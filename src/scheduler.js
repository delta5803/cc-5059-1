// 调度引擎：按拍推进，逐小节承诺事件；情境请求在乐句边界按规则换乘。
// 规则（显式）：
//  - 出口 = 当前主题段可出乐句的终止拍；请求决策需提前 prepareBeats（决策点 = 出口 - 准备拍）。
//  - 决策点之后到达的请求对该出口无效，顺延到下一可行出口；绝不生成过去时间的事件。
//  - 新请求在锁定点前到达则抢占重排；锁定点后到达则入队延后（队列后到者优先）。
//  - 目标段弱起铺在旧段最后一小节内；旧段延音/尾部越界发声，须与进入和声协和。
//  - 拼接器向伴奏调度申请提前量（prepareBeats）；提前量不足的出口不选。
//  - 拼接（旧段尾部 + 目标弱起）先进入可撤销缓冲：旧段终止小节照常发声（不截断），
//    但拼接音尚未发声前可撤销重排；首个拼接音实际发声即提交，提交后只能延后接管。
import { parseChord, chordsCompatible, consonantWithChord, keysCompatible, midiName } from './theory.js';
import { barLen, loopLen } from './score-data.js';
import { findPath } from './graph.js';
import { Trace, PHASE } from './trace.js';
import { ReservationBook, RES } from './reservation.js';

const EPS = 1e-6;

export class Engine {
  constructor(score, opts = {}) {
    this.score = score;
    const startId = opts.start || score.start;
    const startSec = score.sections[startId];
    if (!startSec) throw new Error(`起始段落不存在: ${startId}`);
    this.opts = { resplice: 'legacy', pickupMode: 'full', traceMax: 256, ...opts };
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
    this.reqSeq = 0;
    this.queue = [];
    this.done = false;
    this.switchNext = null;
    this.splice = null;       // 当前可撤销拼接缓冲（旧段尾部 + 目标弱起）
    this.trace = new Trace({ max: this.opts.traceMax });
    this.book = new ReservationBook();
    this.addLog(0, 'init', `起始段落：${startSec.title}`);
    if (startSec.pickupBeats > 0) this.addLog(0, 'init', `起始段弱起 ${startSec.pickupBeats} 拍在 t=0 省略`);
    this.traceEvent(0, PHASE.ENTER, { secId: startId, reason: '起始段' });
  }

  sec(id) { return this.score.sections[id]; }

  addLog(t, type, msg, data) {
    const entry = { t, type, msg };
    if (data !== undefined) entry.data = data;
    this.log.push(entry);
  }

  traceEvent(t, phase, fields = {}) {
    return this.trace.push({ t, phase, ...fields });
  }

  openingChord(secId) {
    return parseChord(this.sec(secId).phrases[0].bars[0].chord);
  }

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
    if (this.opts.pickupMode !== 'omit') {
      for (const pk of toSec.pickup || []) {
        const pc = pk.p % 12;
        const ok = consonantWithChord(pc, fromCtx.cadence) || consonantWithChord(pc, opening);
        checks.push({ name: `弱起 ${midiName(pk.p)}`, ok, detail: ok ? '协和' : '与发声和声及目标和声均不合' });
      }
    }
    for (const tie of fromCtx.ties) {
      checks.push({ name: `延音 ${midiName(tie.pitch)}`, ok: consonantWithChord(tie.pc, opening), detail: `越界 ${tie.spill} 拍` });
    }
    for (const tail of fromCtx.tails) {
      checks.push({ name: `尾部 ${midiName(tail.pitch)}`, ok: consonantWithChord(tail.pc, opening), detail: `+${tail.at}拍起 ${tail.d}拍` });
    }
    return { ok: checks.every((c) => c.ok), opening, checks };
  }

  candidateExits(fromBeat, horizon, includeBeat = null) {
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
        if (beat > fromBeat + EPS || (includeBeat !== null && Math.abs(beat - includeBeat) < EPS)) {
          exits.push({ beat, phraseIdx: e.phraseIdx });
        }
      }
    }
    return exits.sort((a, b) => a.beat - b.beat);
  }

  // 目标段拼接位置：入口拍、首个弱起音发声拍、弱起音符数（受 pickupMode 影响）。
  spliceInfo(targetId, exitBeat, path) {
    const target = this.sec(targetId);
    const intermediate = path.slice(0, -1).reduce((sum, id) => sum + loopLen(this.sec(id)), 0);
    const entryBeat = exitBeat + intermediate;
    const pickupCount = this.opts.pickupMode === 'omit' ? 0 : (target.pickup || []).length;
    const firstSoundBeat = pickupCount && target.pickupBeats > 0 ? entryBeat - target.pickupBeats : entryBeat;
    return { entryBeat, firstSoundBeat, pickupCount };
  }

  buildPlan(mood, t, opts2 = {}) {
    const cur = this.sec(this.cur && this.cur.secId);
    const ids = this.score.moods[mood];
    if (!ids) return { error: `未知情境: ${mood}` };
    const cands = ids.map((id) => this.sec(id)).filter(Boolean);
    const ordered = [...cands].sort((a, b) => Number(keysCompatible(cur.key, b.key)) - Number(keysCompatible(cur.key, a.key)));
    const decisionBeat = opts2.decisionBeat ?? Math.max(t, this.frontier);
    const allowBeat = opts2.allowBeat ?? null;
    const reasons = [];
    for (const cand of ordered) {
      if (cand.id === cur.id) return { already: true };
      const path = findPath(this.score, cur.id, cand.id);
      if (!path) { reasons.push(`${cur.title}→${cand.title}：没有声明的可达路径`); continue; }
      const P = cur.prepareBeats;
      const horizon = decisionBeat + P + 4 * loopLen(cur);
      const exits = this.candidateExits(this.frontier, horizon, allowBeat);
      let skippedLate = 0;
      const joinFails = [];
      for (const ex of exits) {
        const isAllowed = allowBeat !== null && Math.abs(ex.beat - allowBeat) < EPS;
        if (!isAllowed && ex.beat - P < decisionBeat - EPS) { skippedLate++; continue; }
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
          const splice = this.spliceInfo(cand.id, ex.beat, path);
          return {
            plan: {
              id: ++this.planSeq, targetMood: mood, targetId: cand.id, path,
              exitBeat: ex.beat, exitPhraseIdx: ex.phraseIdx,
              lockBeat: ex.beat - P, decisionBeat: t, joins,
              requiredLead: P, grantedLead: ex.beat - decisionBeat,
              pickupCount: splice.pickupCount, entryBeat: splice.entryBeat,
              spliceFirstSoundBeat: splice.firstSoundBeat,
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

  // ---- 可撤销拼接缓冲 ----
  // 旧段尾部 + 目标弱起作为独立缓冲；旧段终止小节本身照常发声（不截断）。
  prepareSplice(plan) {
    this.cancelSplice(plan.id, null);
    const curSec = this.sec(this.cur.secId);
    const curSpb = 60 / curSec.tempo;
    const exitPhrase = curSec.phrases[plan.exitPhraseIdx];
    const nextSec = this.sec(plan.path[0]);
    const nextSpb = 60 / nextSec.tempo;
    const notes = [];
    const tsAt = (beat) => this.frontierSec + (beat - this.frontier) * curSpb;
    for (const ev of exitPhrase.exit?.tail || []) {
      const at = plan.exitBeat + ev.b;
      notes.push({ t: at, d: ev.d, ts: tsAt(at), ds: ev.d * nextSpb, p: ev.p, v: ev.v, vo: ev.vo, sec: curSec.id, role: 'tail' });
    }
    if (this.opts.pickupMode !== 'omit' && nextSec.pickupBeats > 0) {
      for (const ev of nextSec.pickup) {
        const at = plan.exitBeat - nextSec.pickupBeats + ev.b;
        notes.push({ t: at, d: ev.d, ts: tsAt(at), ds: ev.d * curSpb, p: ev.p, v: ev.v, vo: ev.vo, sec: nextSec.id, role: 'pickup' });
      }
    }
    notes.sort((a, b) => a.t - b.t);
    const pickupNotes = notes.filter((n) => n.role === 'pickup');
    const firstSoundBeat = pickupNotes.length ? pickupNotes[0].t : plan.exitBeat;
    plan.spliceFirstSoundBeat = firstSoundBeat;
    plan.pickupCount = pickupNotes.length;
    plan.spliceCommitted = false;
    plan.pickupQueued = true;
    plan.pickupQueuedAt = this.frontier;
    this.splice = {
      planId: plan.id, resId: plan.resId, targetId: nextSec.id,
      notes, commitAtBeat: notes.length ? notes[0].t : plan.exitBeat,
    };
    if (plan.resId) this.book.transition(plan.resId, this.frontier, RES.SPLICE_QUEUED, `拼接就绪（${notes.length} 音，未发声）`);
    this.traceEvent(this.frontier, PHASE.SPLICE, {
      reqId: plan.reqId, mood: plan.targetMood, secId: nextSec.id,
      reason: notes.length ? `弱起 ${pickupNotes.length} 音就绪（未发声）` : '无弱起，边界等待提交',
    });
  }

  cancelSplice(planId, t) {
    if (!this.splice || (planId !== undefined && this.splice.planId !== planId)) return false;
    const had = this.splice.notes.length;
    this.splice = null;
    if (t !== null && t !== undefined) {
      this.traceEvent(t, PHASE.REVOKE, { secId: null, reason: `撤销未发声拼接（${had} 音）` });
    }
    return true;
  }

  flushSplice(limit, emitted) {
    if (!this.splice) return;
    const ready = this.splice.notes.filter((n) => n.t <= limit + EPS);
    if (!ready.length) return;
    const rest = this.splice.notes.filter((n) => n.t > limit + EPS);
    const plan = this.plan;
    for (const ev of ready) { this.events.push(ev); emitted.push(ev); }
    const firstBeat = Math.min(...ready.map((n) => n.t));
    if (plan && plan.id === this.splice.planId && !plan.spliceCommitted) {
      plan.spliceCommitted = true;
      if (plan.resId) this.book.transition(plan.resId, firstBeat, RES.COMMITTED, '首个拼接音发声，提交');
      this.traceEvent(firstBeat, PHASE.COMMIT, {
        reqId: plan.reqId, secId: this.splice.targetId, reason: `拼接发声 ${ready.length} 音`,
      });
    }
    if (rest.length) this.splice.notes = rest;
    else this.splice = null;
  }

  supersedePlan(t, reason) {
    const old = this.plan;
    if (!old) return false;
    this.cancelSplice(old.id, t);
    if (old.resId) this.book.transition(old.resId, t, RES.SUPERSEDED, reason);
    return true;
  }

  createReservation(plan, t, reqId, state = RES.RESERVED, existingId = null) {
    const fields = {
      reqId, mood: plan.targetMood, sourceId: this.cur.secId, targetId: plan.targetId,
      path: plan.path, exitBeat: plan.exitBeat, lockBeat: plan.lockBeat, decisionBeat: plan.decisionBeat,
      entryBeat: plan.entryBeat, createdAt: t, requiredLead: plan.requiredLead, grantedLead: plan.grantedLead,
      pickupCount: plan.pickupCount, spliceFirstSoundBeat: plan.spliceFirstSoundBeat,
    };
    let r;
    if (existingId) {
      r = this.book.byId(existingId);
      if (r) {
        this.book.retarget(existingId, t, fields, '出队后重排');
        this.book.transition(existingId, t, state, '出队后生成计划');
      } else {
        r = this.book.create({ ...fields, state });
      }
    } else {
      r = this.book.create({ ...fields, state });
    }
    return r;
  }

  acceptPlan(plan, t, reqId, type, reuseResId, cur) {
    this.plan = plan;
    const r = this.createReservation(plan, t, reqId, RES.RESERVED, reuseResId);
    plan.resId = r.id;
    this.book.transition(r.id, t, RES.LEAD_GRANTED, `提前量 ${plan.grantedLead} 拍 ≥ 需要 ${plan.requiredLead} 拍`);
    this.traceEvent(t, PHASE.LEAD, {
      reqId, mood: plan.targetMood, secId: cur.id,
      reason: `提前量 ${plan.grantedLead}/${plan.requiredLead} 拍`,
    });
    this.prepareSplice(plan);
    const p = plan;
    this.addLog(t, 'plan',
      `过渡计划：${cur.title} → ${p.path.map((id) => this.sec(id).title).join(' → ')}，出口 第${p.exitBeat}拍（锁定点 第${p.lockBeat}拍）`,
      { plan: p });
    this.traceEvent(t, PHASE.DECIDE, { reqId, mood: plan.targetMood, secId: cur.id, state: type, reason: `出口 第${p.exitBeat}拍` });
    return { type, plan: p };
  }

  requestContext(mood, t, opts2 = {}) {
    t = Math.max(0, t);
    const reqId = opts2.reqId ?? ++this.reqSeq;
    const reuseResId = opts2.resId ?? null;
    if (!opts2.dequeued) this.traceEvent(t, PHASE.REQUEST, { reqId, mood, secId: this.cur.secId });
    if (this.done) {
      this.addLog(t, 'exception', `情境「${mood}」被拒绝：乐曲已收束`);
      this.book.create({ reqId, mood, sourceId: this.cur.secId, state: RES.CONFLICT, createdAt: t });
      this.traceEvent(t, PHASE.REJECT, { reqId, mood, reason: '已收束' });
      return { type: 'exception' };
    }
    this.addLog(t, 'request', `情境请求：${mood}`);
    const cur = this.sec(this.cur.secId);
    if (this.plan && this.plan.targetMood === mood) {
      this.addLog(t, 'keep', `已有前往「${mood}」的待定过渡`);
      this.traceEvent(t, PHASE.DECIDE, { reqId, mood, state: 'keep', reason: '已有同目标待定过渡' });
      return { type: 'keep' };
    }
    if (!this.plan && cur.kind === 'theme' && cur.mood === mood) {
      this.addLog(t, 'already', `已处于「${mood}」`);
      this.traceEvent(t, PHASE.DECIDE, { reqId, mood, state: 'already', reason: '已处于该情绪' });
      return { type: 'already' };
    }
    const locked = this.plan && (t >= this.plan.lockBeat - EPS || this.frontier > this.plan.lockBeat + EPS);
    // 拼接就绪但首个拼接音尚未发声 → 可立即撤销重排（immediate 策略）。
    const canRevoke = locked && this.opts.resplice === 'immediate' && this.plan
      && !this.plan.spliceCommitted && t < this.plan.spliceFirstSoundBeat - EPS;
    if (cur.kind !== 'theme' || (locked && !canRevoke)) {
      let why;
      if (cur.kind !== 'theme') why = `${cur.title}（${cur.kind === 'transition' ? '过渡' : '收束'}进行中）`;
      else if (this.plan && this.plan.spliceCommitted) why = `拼接已发声提交（首个弱起音 第${this.plan.spliceFirstSoundBeat}拍），只能延后接管`;
      else why = `出口已锁定（决策点 第${this.plan.lockBeat}拍）`;
      let resId = reuseResId;
      if (!resId || !this.book.byId(resId)) {
        const r = this.book.create({ reqId, mood, sourceId: this.cur.secId, state: RES.DEFERRED, createdAt: t });
        resId = r.id;
      } else {
        this.book.transition(resId, t, RES.DEFERRED, '延后入队');
      }
      this.queue = this.queue.filter((q) => {
        if (q.mood === mood) {
          if (q.resId) this.book.transition(q.resId, t, RES.CANCELLED, '同情绪新请求替换');
          return false;
        }
        return true;
      });
      this.queue.push({ mood, t, reqId, resId });
      this.addLog(t, 'defer', `延后：${why}，请求入队（后到者优先）`);
      this.traceEvent(t, PHASE.DEFER, { reqId, mood, secId: this.cur.secId, reason: why });
      return { type: 'deferred' };
    }

    // 立即撤销重排：沿用当前待切边界，用请求到达时刻做决策（拼接尚未发声）。
    if (locked && canRevoke) {
      const boundary = this.plan.exitBeat;
      const res = this.buildPlan(mood, t, { decisionBeat: t, allowBeat: boundary });
      if (res.already) {
        this.cancelSplice(this.plan.id, t);
        if (this.plan.resId) this.book.transition(this.plan.resId, t, RES.SUPERSEDED, '撤销过渡，留在原段');
        this.addLog(t, 'preempt',
          `撤销：放弃原过渡（目标 ${this.sec(this.plan.targetId).title}，出口 第${this.plan.exitBeat}拍），留在 ${cur.title}`,
          { oldPlanId: this.plan.id });
        this.plan = null;
        if (this.switchNext && Math.abs(this.switchNext.atBeat - boundary) < EPS) this.switchNext = null;
        this.traceEvent(t, PHASE.REVOKE, { reqId, mood, reason: '撤销未发声拼接，留在原段' });
        return { type: 'preempt' };
      }
      if (!res.error) {
        const old = this.plan;
        this.addLog(t, 'preempt',
          `撤销重排：取消未发声拼接（原目标 ${this.sec(old.targetId).title}），按新情境重排于第${boundary}拍出口`,
          { oldPlanId: old.id });
        this.cancelSplice(old.id, t);
        if (old.resId) this.book.transition(old.resId, t, RES.SUPERSEDED, '拼接未发声，立即撤销重排');
        const plan = res.plan;
        plan.spliceFirstSoundBeat = this.spliceInfo(plan.targetId, boundary, plan.path).firstSoundBeat;
        this.plan = plan;
        if (this.switchNext && Math.abs(this.switchNext.atBeat - boundary) < EPS) this.switchNext.nextId = plan.path[0];
        const r = this.createReservation(plan, t, reqId, RES.RESERVED, reuseResId);
        plan.resId = r.id;
        this.book.transition(r.id, t, RES.LEAD_GRANTED, `沿用边界 第${boundary}拍，拼接提前量有效`);
        this.traceEvent(t, PHASE.LEAD, { reqId, mood, secId: cur.id, reason: `沿用边界 ${boundary}，拼接未发声` });
        this.prepareSplice(plan);
        this.addLog(t, 'plan',
          `过渡计划：${cur.title} → ${plan.path.map((id) => this.sec(id).title).join(' → ')}，出口 第${plan.exitBeat}拍（锁定点 第${plan.lockBeat}拍）`,
          { plan });
        this.traceEvent(t, PHASE.DECIDE, { reqId, mood, secId: cur.id, state: 'preempt', reason: `立即重排于出口 第${plan.exitBeat}拍` });
        return { type: 'preempt', plan };
      }
      // 边界处无法达成新目标 → 回到下方延后逻辑
      const why = `出口已锁定且新目标在本边界不可达`;
      let resId = reuseResId;
      if (!resId || !this.book.byId(resId)) {
        const r = this.book.create({ reqId, mood, sourceId: this.cur.secId, state: RES.DEFERRED, createdAt: t });
        resId = r.id;
      } else {
        this.book.transition(resId, t, RES.DEFERRED, '延后入队');
      }
      this.queue.push({ mood, t, reqId, resId });
      this.addLog(t, 'defer', `延后：${why}，请求入队（后到者优先）`);
      this.traceEvent(t, PHASE.DEFER, { reqId, mood, secId: this.cur.secId, reason: why });
      return { type: 'deferred' };
    }

    const res = this.buildPlan(mood, t);
    if (res.already) {
      if (this.plan) {
        this.addLog(t, 'preempt',
          `撤销：放弃原过渡（目标 ${this.sec(this.plan.targetId).title}，出口 第${this.plan.exitBeat}拍），留在 ${cur.title}`,
          { oldPlanId: this.plan.id });
        this.supersedePlan(t, '撤销过渡，留在原段');
        this.traceEvent(t, PHASE.REVOKE, { reqId, mood, reason: '请求当前情绪，撤销未发声过渡' });
        this.plan = null;
        return { type: 'preempt' };
      }
      this.addLog(t, 'already', `已处于「${mood}」`);
      this.traceEvent(t, PHASE.DECIDE, { reqId, mood, state: 'already' });
      return { type: 'already' };
    }
    if (res.error) {
      this.addLog(t, 'exception', `无法调度「${mood}」：${res.error}`);
      this.book.create({ reqId, mood, sourceId: cur.id, state: RES.CONFLICT, createdAt: t });
      this.traceEvent(t, PHASE.REJECT, { reqId, mood, reason: res.error });
      return { type: 'exception', error: res.error };
    }
    let type = 'plan';
    if (this.plan) {
      type = 'preempt';
      this.addLog(t, 'preempt',
        `抢占：放弃原过渡（目标 ${this.sec(this.plan.targetId).title}，出口 第${this.plan.exitBeat}拍），按新情境重排`,
        { oldPlanId: this.plan.id });
      this.supersedePlan(t, '被新请求抢占');
    }
    return this.acceptPlan(res.plan, t, reqId, type, reuseResId, cur);
  }

  advanceTo(limit) {
    const emitted = [];
    while (!this.done && this.frontier < limit - EPS) {
      this.flushSplice(limit, emitted);
      this.emitBar(emitted);
    }
    this.flushSplice(limit, emitted);
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
      this.switchNext = { atBeat: phraseEndBeat, nextId: plan.path[0] };
    } else if (isTransitionEnd) {
      if (plan && plan.path.length) {
        const nextId = plan.path[0];
        const nextSec = this.sec(nextId);
        this.emitPickup(nextSec, phraseEndBeat, emitted, plan);
        this.switchNext = { atBeat: phraseEndBeat, nextId };
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
      this.traceEvent(this.frontier, PHASE.END, { secId: sec.id, reason: '收束结束' });
      if (this.queue.length) {
        this.addLog(this.frontier, 'exception', `已收束，${this.queue.length} 个排队请求被放弃`);
        for (const q of this.queue) {
          if (q.resId) this.book.transition(q.resId, this.frontier, RES.CANCELLED, '乐曲已收束，排队请求放弃');
        }
        this.queue = [];
      }
    }
  }

  // 过渡段结尾的弱起：直接发声（此时已进入过渡，不接受边界改请求）。
  emitPickup(nextSec, atBeat, emitted, plan) {
    if (!nextSec.pickupBeats) return;
    if (this.opts.pickupMode === 'omit') return;
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
    const prevId = this.cur.secId;
    const nextSec = this.sec(nextId);
    const joinPlanId = this.plan ? this.plan.id : null;
    this.joins.push({ atBeat, from: prevId, to: nextId, planId: joinPlanId });
    this.cur = { secId: nextId, phraseIdx: 0, barIdx: 0, loops: 0 };
    this.segments.push({ secId: nextId, startBeat: atBeat, kind: nextSec.kind });
    this.addLog(atBeat, 'switch', `进入段落：${nextSec.title}`);
    if (this.plan && this.plan.resId) {
      const r = this.book.byId(this.plan.resId);
      if (r) {
        r.entries.push({ beat: atBeat, secId: nextId, kind: nextSec.kind });
        this.book.transition(this.plan.resId, atBeat,
          nextSec.kind === 'transition' ? RES.ENTERING : RES.ENTERED,
          nextSec.kind === 'transition' ? '进入过渡段' : '进入目标段');
      }
    }
    this.traceEvent(atBeat, PHASE.ENTER, {
      reqId: this.plan ? this.plan.reqId : null, secId: nextId,
      reason: nextSec.kind === 'transition' ? '过渡段' : '目标段',
    });
    if (nextSec.kind === 'transition') {
      this.plan = { ...this.plan, path: this.plan.path.slice(1) };
      return;
    }
    this.plan = null;
    if (nextSec.kind === 'theme' && this.queue.length) {
      const q = this.queue[this.queue.length - 1];
      this.queue = [];
      this.addLog(atBeat, 'dequeue', `处理排队请求：${q.mood}（后到者优先，其余放弃）`);
      this.traceEvent(atBeat, PHASE.DECIDE, { reqId: q.reqId, mood: q.mood, state: 'dequeue', reason: '过渡落地，接管排队请求' });
      this.requestContext(q.mood, atBeat, { reqId: q.reqId, resId: q.resId, dequeued: true });
    }
  }

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

  snapshotResult() {
    return {
      events: this.events,
      harmony: this.harmony,
      segments: this.segments,
      joins: this.joins,
      log: this.log,
      done: this.done,
      frontier: this.frontier,
      frontierSec: this.frontierSec,
      reservations: this.book.snapshot(),
      trace: this.trace.toJSON(),
      pickupMode: this.opts.pickupMode,
      pendingSplices: this.splice ? [{ planId: this.splice.planId, resId: this.splice.resId, targetId: this.splice.targetId, commitAtBeat: this.splice.commitAtBeat, count: this.splice.notes.length }] : [],
      plan: this.plan ? { ...this.plan } : null,
    };
  }
}
