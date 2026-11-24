// 调度引擎：按拍推进，逐小节承诺事件；情境请求在乐句边界按规则换乘。
// 规则（显式）：
//  - 出口 = 当前主题段可出乐句的终止拍；请求决策需提前 prepareBeats（决策点 = 出口 - 准备拍）。
//  - 决策点之后到达的请求对该出口无效，顺延到下一可行出口；绝不生成过去时间的事件。
//  - 新请求在锁定点前到达则抢占重排；锁定点后到达则入队延后（队列后到者优先）。
//  - 目标段弱起铺在旧段最后一小节内；旧段延音/尾部越界发声，须与进入和声协和。
import { parseChord, chordsCompatible, consonantWithChord, keysCompatible, midiName } from './theory.js';
import { barLen, loopLen } from './score-data.js';
import { findPath } from './graph.js';

const EPS = 1e-6;

export class Engine {
  constructor(score, opts = {}) {
    this.score = score;
    const startId = opts.start || score.start;
    const startSec = score.sections[startId];
    if (!startSec) throw new Error(`起始段落不存在: ${startId}`);
    this.frontier = 0;
    this.frontierSec = 0;
    this.cur = { secId: startId, phraseIdx: 0, barIdx: 0, loops: 0 };
    this.events = [];
    this.harmony = [];
    this.segments = [{ secId: startId, startBeat: 0, kind: startSec.kind }];
    this.checkpoints = [{ beat: 0, sec: 0, spb: 60 / startSec.tempo }];
    this.log = [];
    this.joins = [];
    this.plan = null;
    this.planSeq = 0;
    this.queue = [];
    this.done = false;
    this.switchNext = null;
    this.addLog(0, 'init', `起始段落：${startSec.title}`);
    if (startSec.pickupBeats > 0) this.addLog(0, 'init', `起始段弱起 ${startSec.pickupBeats} 拍在 t=0 省略`);
  }

  sec(id) { return this.score.sections[id]; }

  addLog(t, type, msg, data) {
    const entry = { t, type, msg };
    if (data !== undefined) entry.data = data;
    this.log.push(entry);
  }

  openingChord(secId) {
    return parseChord(this.sec(secId).phrases[0].bars[0].chord);
  }

  // 出口处的和声上下文：终止和弦（出口变体优先）、越界延音、尾部。
  exitContext(secId, phraseIdx) {
    const sec = this.sec(secId);
    const ph = sec.phrases[phraseIdx];
    const finalBar = ph.exit?.bars?.length ? ph.exit.bars[ph.exit.bars.length - 1] : ph.bars[ph.bars.length - 1];
    return {
      cadence: parseChord(finalBar.chord),
      ties: finalBar.events.filter((ev) => ev.tie).map((ev) => ({ pitch: ev.p, pc: ev.p % 12, spill: ev.tie })),
      tails: (ph.exit?.tail || []).map((ev) => ({ pitch: ev.p, pc: ev.p % 12, at: ev.b, d: ev.d })),
    };
  }

  checkJoin(fromCtx, toSecId) {
    const toSec = this.sec(toSecId);
    const opening = this.openingChord(toSecId);
    const checks = [];
    checks.push({
      name: '终止→起始和弦', ok: chordsCompatible(fromCtx.cadence, opening),
      detail: `${fromCtx.cadence.name} → ${opening.name}`,
    });
    for (const pk of toSec.pickup || []) {
      const pc = pk.p % 12;
      const ok = consonantWithChord(pc, fromCtx.cadence) || consonantWithChord(pc, opening);
      checks.push({ name: `弱起 ${midiName(pk.p)}`, ok, detail: ok ? '协和' : '与发声和声及目标和声均不合' });
    }
    for (const tie of fromCtx.ties) {
      checks.push({ name: `延音 ${midiName(tie.pitch)}`, ok: consonantWithChord(tie.pc, opening), detail: `越界 ${tie.spill} 拍` });
    }
    for (const tail of fromCtx.tails) {
      checks.push({ name: `尾部 ${midiName(tail.pitch)}`, ok: consonantWithChord(tail.pc, opening), detail: `+${tail.at}拍起 ${tail.d}拍` });
    }
    return { ok: checks.every((c) => c.ok), opening, checks };
  }

  // 当前段落从 fromBeat 之后的可出乐句终止拍（按循环展开）。
  candidateExits(fromBeat, horizon) {
    const sec = this.sec(this.cur.secId);
    const bl = barLen(sec);
    const ends = [];
    let acc = 0;
    sec.phrases.forEach((ph, i) => {
      acc += ph.bars.length * bl;
      if (ph.exitable) ends.push({ local: acc, phraseIdx: i });
    });
    const L = acc;
    const segStart = this.segments[this.segments.length - 1].startBeat;
    const firstLoop = Math.max(0, Math.floor((fromBeat - segStart) / L));
    const exits = [];
    for (let base = segStart + firstLoop * L; base <= fromBeat + horizon; base += L) {
      for (const e of ends) {
        const beat = base + e.local;
        if (beat > fromBeat + EPS) exits.push({ beat, phraseIdx: e.phraseIdx });
      }
    }
    return exits.sort((a, b) => a.beat - b.beat);
  }

  buildPlan(mood, t) {
    const cur = this.sec(this.cur && this.cur.secId);
    const ids = this.score.moods[mood];
    if (!ids) return { error: `未知情境: ${mood}` };
    const cands = ids.map((id) => this.sec(id)).filter(Boolean);
    const ordered = [...cands].sort((a, b) => Number(keysCompatible(cur.key, b.key)) - Number(keysCompatible(cur.key, a.key)));
    const decisionBeat = Math.max(t, this.frontier);
    const reasons = [];
    for (const cand of ordered) {
      if (cand.id === cur.id) return { already: true };
      const path = findPath(this.score, cur.id, cand.id);
      if (!path) { reasons.push(`${cur.title}→${cand.title}：没有声明的可达路径`); continue; }
      const P = cur.prepareBeats;
      const horizon = decisionBeat + P + 4 * loopLen(cur);
      const exits = this.candidateExits(this.frontier, horizon);
      let skippedLate = 0;
      const joinFails = [];
      for (const ex of exits) {
        if (ex.beat - P < decisionBeat - EPS) { skippedLate++; continue; }
        let prevCtx = this.exitContext(cur.id, ex.phraseIdx);
        let prevId = cur.id;
        const joins = [];
        let ok = true;
        for (const stepId of path) {
          const join = this.checkJoin(prevCtx, stepId);
          joins.push({ from: prevId, to: stepId, ...join });
          if (!join.ok) { ok = false; break; }
          prevCtx = this.exitContext(stepId, 0);
          prevId = stepId;
        }
        if (ok) {
          return {
            plan: {
              id: ++this.planSeq, targetMood: mood, targetId: cand.id, path,
              exitBeat: ex.beat, exitPhraseIdx: ex.phraseIdx,
              lockBeat: ex.beat - P, decisionBeat: t, joins,
            },
          };
        }
        joinFails.push(`第${ex.beat}拍`);
      }
      const parts = [];
      if (skippedLate) parts.push(`${skippedLate} 个出口已过决策点（需提前 ${P} 拍）`);
      if (joinFails.length) parts.push(`出口和声不兼容: ${joinFails.join('、')}`);
      reasons.push(`${cur.title}→${cand.title}：${parts.join('；') || '无可用出口'}`);
    }
    return { error: reasons.join('；') };
  }

  requestContext(mood, t) {
    t = Math.max(0, t);
    if (this.done) {
      this.addLog(t, 'exception', `情境「${mood}」被拒绝：乐曲已收束`);
      return { type: 'exception' };
    }
    this.addLog(t, 'request', `情境请求：${mood}`);
    const cur = this.sec(this.cur.secId);
    if (this.plan && this.plan.targetMood === mood) {
      this.addLog(t, 'keep', `已有前往「${mood}」的待定过渡`);
      return { type: 'keep' };
    }
    if (!this.plan && cur.kind === 'theme' && cur.mood === mood) {
      this.addLog(t, 'already', `已处于「${mood}」`);
      return { type: 'already' };
    }
    const locked = this.plan && (t >= this.plan.lockBeat - EPS || this.frontier > this.plan.lockBeat + EPS);
    if (cur.kind !== 'theme' || locked) {
      this.queue = this.queue.filter((q) => q.mood !== mood);
      this.queue.push({ mood, t });
      const why = cur.kind !== 'theme'
        ? `${cur.title}（${cur.kind === 'transition' ? '过渡' : '收束'}进行中）`
        : `出口已锁定（决策点 第${this.plan.lockBeat}拍）`;
      this.addLog(t, 'defer', `延后：${why}，请求入队（后到者优先）`);
      return { type: 'deferred' };
    }
    const res = this.buildPlan(mood, t);
    if (res.already) {
      if (this.plan) {
        this.addLog(t, 'preempt',
          `撤销：放弃原过渡（目标 ${this.sec(this.plan.targetId).title}，出口 第${this.plan.exitBeat}拍），留在 ${cur.title}`,
          { oldPlanId: this.plan.id });
        this.plan = null;
        return { type: 'preempt' };
      }
      this.addLog(t, 'already', `已处于「${mood}」`);
      return { type: 'already' };
    }
    if (res.error) {
      this.addLog(t, 'exception', `无法调度「${mood}」：${res.error}`);
      return { type: 'exception', error: res.error };
    }
    let type = 'plan';
    if (this.plan) {
      type = 'preempt';
      this.addLog(t, 'preempt',
        `抢占：放弃原过渡（目标 ${this.sec(this.plan.targetId).title}，出口 第${this.plan.exitBeat}拍），按新情境重排`,
        { oldPlanId: this.plan.id });
    }
    this.plan = res.plan;
    const p = res.plan;
    this.addLog(t, 'plan',
      `过渡计划：${cur.title} → ${p.path.map((id) => this.sec(id).title).join(' → ')}，出口 第${p.exitBeat}拍（锁定点 第${p.lockBeat}拍）`,
      { plan: p });
    return { type, plan: p };
  }

  advanceTo(limit) {
    const emitted = [];
    while (!this.done && this.frontier < limit - EPS) this.emitBar(emitted);
    return emitted;
  }

  emitBar(emitted) {
    if (this.switchNext && this.frontier >= this.switchNext.atBeat - EPS) this.doSwitch();
    const sec = this.sec(this.cur.secId);
    const bl = barLen(sec);
    const spb = 60 / sec.tempo;
    const phrase = sec.phrases[this.cur.phraseIdx];
    const phraseEndBeat = this.frontier + bl;
    const isFinalBar = this.cur.barIdx === phrase.bars.length - 1;
    const plan = this.plan;
    const isThemeExit = sec.kind === 'theme' && plan
      && this.cur.phraseIdx === plan.exitPhraseIdx
      && Math.abs( phraseEndBeat - plan.exitBeat ) < EPS;
    const isTransitionEnd = sec.kind === 'transition' && isFinalBar;
    const isEndingEnd = sec.kind === 'ending' && isFinalBar;

    let barData = phrase.bars[this.cur.barIdx];
    let role = sec.kind;
    if (sec.kind === 'theme') {
      role = 'theme';
      if (plan && phrase.exit && this.cur.phraseIdx === plan.exitPhraseIdx
        && this.frontier >= plan.exitBeat - phrase.exit.bars.length * bl - EPS
        && this.frontier < plan.exitBeat - EPS) {
        barData = phrase.exit.bars[this.cur.barIdx - (phrase.bars.length - phrase.exit.bars.length)];
        role = 'exit';
      }
    }

    const sectionEnding = (isThemeExit || isTransitionEnd || isEndingEnd) && isFinalBar;
    for (const ev of barData.events) {
      const out = {
        t: this.frontier + ev.b, d: ev.d,
        ts: this.frontierSec + ev.b * spb, ds: ev.d * spb,
        p: ev.p, v: ev.v, vo: ev.vo, sec: sec.id, role,
      };
      if (sectionEnding && ev.tie) {
        out.d += ev.tie;
        out.ds = out.d * spb;
        out.tie = ev.tie;
      }
      this.events.push(out);
      emitted.push(out);
    }
    this.harmony.push({ t: this.frontier, d: bl, chord: barData.chord, sec: sec.id });
    this.checkpoints.push({ beat: this.frontier, sec: this.frontierSec, spb });

    const secEndSec = this.frontierSec + bl * spb;
    let endAfter = false;

    if (isThemeExit) {
      const nextId = plan.path[0];
      const nextSec = this.sec(nextId);
      const nextSpb = 60 / nextSec.tempo;
      for (const ev of phrase.exit?.tail || []) {
        const out = {
          t: phraseEndBeat + ev.b, d: ev.d,
          ts: secEndSec + ev.b * nextSpb, ds: ev.d * nextSpb,
          p: ev.p, v: ev.v, vo: ev.vo, sec: sec.id, role: 'tail',
        };
        this.events.push(out);
        emitted.push(out);
      }
      this.emitPickup(nextSec, phraseEndBeat, emitted);
      this.switchNext = { atBeat: phraseEndBeat, nextId };
      this.joins.push({ atBeat: phraseEndBeat, from: sec.id, to: nextId, planId: plan.id });
    } else if (isTransitionEnd) {
      if (plan && plan.path.length) {
        const nextId = plan.path[0];
        const nextSec = this.sec(nextId);
        this.emitPickup(nextSec, phraseEndBeat, emitted);
        this.switchNext = { atBeat: phraseEndBeat, nextId };
        this.joins.push({ atBeat: phraseEndBeat, from: sec.id, to: nextId, planId: plan.id });
      } else {
        endAfter = true;
      }
    } else if (isEndingEnd) {
      for (const ev of phrase.tail || []) {
        const out = {
          t: phraseEndBeat + ev.b, d: ev.d,
          ts: secEndSec + ev.b * spb, ds: ev.d * spb,
          p: ev.p, v: ev.v, vo: ev.vo, sec: sec.id, role: 'tail',
        };
        this.events.push(out);
        emitted.push(out);
      }
      endAfter = true;
    }

    this.frontier = phraseEndBeat;
    this.frontierSec = secEndSec;
    this.cur.barIdx++;
    if (this.cur.barIdx === phrase.bars.length) {
      this.cur.barIdx = 0;
      this.cur.phraseIdx++;
      if (this.cur.phraseIdx === sec.phrases.length) {
        this.cur.phraseIdx = 0;
        this.cur.loops++;
      }
    }
    if (endAfter) {
      this.done = true;
      this.addLog(this.frontier, 'done', `${sec.title} 结束`);
      if (this.queue.length) {
        this.addLog(this.frontier, 'exception', `已收束，${this.queue.length} 个排队请求被放弃`);
        this.queue = [];
      }
    }
  }

  emitPickup(nextSec, atBeat, emitted) {
    if (!nextSec.pickupBeats) return;
    const spb = 60 / this.sec(this.cur.secId).tempo;
    for (const ev of nextSec.pickup) {
      const at = atBeat - nextSec.pickupBeats + ev.b;
      const out = {
        t: at, d: ev.d,
        ts: this.frontierSec + (at - this.frontier) * spb, ds: ev.d * spb,
        p: ev.p, v: ev.v, vo: ev.vo, sec: nextSec.id, role: 'pickup',
      };
      this.events.push(out);
      emitted.push(out);
    }
  }

  doSwitch() {
    const { atBeat, nextId } = this.switchNext;
    this.switchNext = null;
    const nextSec = this.sec(nextId);
    this.cur = { secId: nextId, phraseIdx: 0, barIdx: 0, loops: 0 };
    this.segments.push({ secId: nextId, startBeat: atBeat, kind: nextSec.kind });
    this.addLog(atBeat, 'switch', `进入段落：${nextSec.title}`);
    if (nextSec.kind === 'transition') {
      this.plan = { ...this.plan, path: this.plan.path.slice(1) };
      return;
    }
    this.plan = null;
    if (nextSec.kind === 'theme' && this.queue.length) {
      const { mood } = this.queue[this.queue.length - 1];
      this.queue = [];
      this.addLog(atBeat, 'dequeue', `处理排队请求：${mood}（后到者优先，其余放弃）`);
      this.requestContext(mood, atBeat);
    }
  }

  // UI 用：各情境当前若请求将得到的最早出口（不改变状态）。
  previewExits() {
    if (this.done) return {};
    const cur = this.sec(this.cur.secId);
    if (cur.kind !== 'theme') return {};
    const out = {};
    for (const mood of Object.keys(this.score.moods)) {
      if (this.plan && this.plan.targetMood === mood) { out[mood] = { plan: this.plan }; continue; }
      if (!this.plan && mood === cur.mood) continue;
      const res = this.buildPlan(mood, this.frontier);
      out[mood] = res.plan ? { plan: res.plan } : { error: res.error };
    }
    return out;
  }

  beatAtSec(s) {
    const cps = this.checkpoints;
    let i = cps.length - 1;
    while (i > 0 && cps[i].sec > s) i--;
    const cp = cps[i];
    return cp.beat + (s - cp.sec) / cp.spb;
  }
}
