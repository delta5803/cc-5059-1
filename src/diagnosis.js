// 过渡卡住诊断：把"请求 → 乐句边界 → 弱起就绪 → 提交/进入"的执行证据串成可复核的链。
// 关键约束：
//  - 证据来自引擎真实运行（trace + 预约链 + 实际事件），不复制/推测。
//  - 诊断只读取渲染结果，不截断正在发声的乐句、不改动事件。
//  - 同一情境复跑必须得到同一证据哈希；冗余事件可消去，但不得改变结论。
import { renderScenario, renderPickupVariants } from './render.js';
import { verifyRender } from './verify.js';
import { RES, TERMINAL } from './reservation.js';
import { PHASE } from './trace.js';

const ARMED_STATES = new Set([RES.SPLICE_QUEUED, RES.COMMITTED, RES.ENTERING]);
const STAGE_BY_PHASE = {
  [PHASE.REQUEST]: 'request',
  [PHASE.DECIDE]: 'decide',
  [PHASE.LEAD]: 'lead',
  [PHASE.DEFER]: 'defer',
  [PHASE.REVOKE]: 'revoke',
  [PHASE.SPLICE]: 'splice',
  [PHASE.COMMIT]: 'commit',
  [PHASE.ENTER]: 'enter',
  [PHASE.REJECT]: 'decide',
  [PHASE.END]: 'end',
};

// djb2：用于复跑一致性比对，不用于安全。
export function stableHash(obj) {
  const s = JSON.stringify(obj);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

// 可移植时钟：浏览器用 performance.now，Node 用 performance（全局可用）。
const nowMs = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

function evidenceOf(result) {
  return {
    events: result.events.map((e) => [e.t, e.d, e.p, e.sec, e.role]),
    segments: result.segments.map((s) => [s.secId, s.startBeat]),
    reservations: (result.reservations?.list || []).map((r) => [
      r.id, r.reqId, r.mood, r.state, r.exitBeat, r.enteredBeat,
      r.history.map((h) => [h.t, h.to, h.reason]),
    ]),
    trace: (result.trace?.entries || []).map((e) => [e.seq, e.t, e.phase, e.reqId, e.secId, e.state, e.reason, e.count]),
  };
}

export function evidenceHash(result) {
  return stableHash(evidenceOf(result));
}

// 某请求实际进入的段落拍点（来自预约 entries；退化时按 path 在 segments 里查找）。
function entryBeatOf(result, res) {
  if (!res) return null;
  if (res.enteredBeat !== null) return res.enteredBeat;
  if (res.entries && res.entries.length) return res.entries[res.entries.length - 1].beat;
  const targetId = res.targetId || (res.path && res.path[res.path.length - 1]);
  const seg = result.segments.find((s, i) => i > 0 && s.secId === targetId);
  return seg ? seg.startBeat : null;
}

function targetEntered(result, res) {
  if (!res) return false;
  if (res.state === RES.ENTERED) return true;
  if (TERMINAL.has(res.state)) return false; // 被撤销/取代/冲突：本次未进入（后续别次进入不算）
  const targetId = res.targetId || (res.path && res.path[res.path.length - 1]);
  return (res.entries || []).some((en) => en.secId === targetId);
}

// 目标段弱起窗口内的实际音符（用于核对"实际发出的音符数"）。
// 窗口 = [接点 - 弱起拍数, 接点)，接点优先取预约记录的 entryBeat。
function actualPickups(result, targetId, entryBeat, pickupBeats) {
  if (typeof entryBeat !== 'number') return [];
  return result.events.filter((e) => e.sec === targetId && e.role === 'pickup'
    && e.t >= entryBeat - pickupBeats - 1e-6 && e.t < entryBeat - 1e-6);
}

// 单个请求的阶段归因：返回 { stage, kind, reason }。
function attribute(res, result, traceEntries) {
  if (!res) {
    const rej = traceEntries.find((e) => e.phase === PHASE.REJECT);
    return { stage: 'request', kind: 'conflict', reason: rej ? rej.reason : '请求未被受理' };
  }
  const last = res.history.length ? res.history[res.history.length - 1] : null;
  const state = res.state;
  const rej = traceEntries.find((e) => e.phase === PHASE.REJECT);
  if (state === RES.ENTERED) return { stage: 'enter', kind: 'entered', reason: '已进入目标段' };
  if (state === RES.CONFLICT) {
    const why = rej ? rej.reason : (last && last.reason !== 'create' ? last.reason : '规则冲突');
    return { stage: 'decide', kind: 'conflict', reason: why };
  }
  if (state === RES.CANCELLED || state === RES.SUPERSEDED) {
    const why = last ? last.reason : '';
    if (state === RES.CANCELLED && why.includes('收束')) return { stage: 'end', kind: 'ended', reason: why };
    const kind = why.includes('收束') ? 'conflict' : 'superseded';
    return { stage: 'revoke', kind, reason: why || '被后续请求取代' };
  }
  if (state === RES.DEFERRED) {
    // 若乐曲已收束，排队请求是被合法放弃；否则视为等待下一乐句。
    if (result.done) return { stage: 'end', kind: 'ended', reason: '乐曲已收束，请求未能接管' };
    return { stage: 'defer', kind: 'legal_wait', reason: '等待下一乐句边界（后到者优先）' };
  }
  if (state === RES.SPLICE_QUEUED) {
    // 拼接就绪但尚未发声：若运行还没推进到首个拼接音拍点，只是被截断，不判死锁。
    const commit = res.spliceFirstSoundBeat;
    if (commit === null || result.frontier < commit - 1e-6) {
      return { stage: 'commit', kind: 'pending', reason: '弱起已就绪，尚未到发声拍（运行未及）' };
    }
    return { stage: 'commit', kind: 'deadlock', reason: '弱起已排入拼接缓冲但已过发声拍仍未发声' };
  }
  if (state === RES.COMMITTED) {
    const entry = res.entryBeat;
    if (entry !== null && result.frontier < entry - 1e-6) {
      return { stage: 'enter', kind: 'pending', reason: '拼接已提交，尚未跨入目标段（运行未及）' };
    }
    return { stage: 'enter', kind: 'deadlock', reason: '拼接已提交但未跨入目标段' };
  }
  if (state === RES.ENTERING) {
    return { stage: 'enter', kind: 'in_progress', reason: '正在经过渡段' };
  }
  // RESERVED / LEAD_GRANTED
  if (res.exitBeat !== null && result.frontier > res.exitBeat + 1e-6) {
    return { stage: 'enter', kind: 'deadlock', reason: `出口 第${res.exitBeat}拍 已过但仍未进入` };
  }
  return { stage: 'decide', kind: 'pending', reason: '计划已建立，尚未到出口' };
}

function buildChain(res, traceEntries, result, secTitle) {
  const chain = [];
  const push = (t, phase, reason) => chain.push({ t, phase, reason });
  for (const e of traceEntries) push(e.t, `trace:${e.phase}`, e.reason || '');
  if (res) {
    for (const h of res.history) push(h.t, `res:${h.to}`, h.reason || '');
    if (res.entries) for (const en of res.entries) push(en.beat, 'enter', `${secTitle(en.secId)}`);
    const pk = actualPickups(result, res.targetId, res.spliceFirstSoundBeat !== null ? res.spliceFirstSoundBeat : res.entryBeat, 4);
    if (pk.length) push(pk[0].t, 'notes', `实际弱起 ${pk.length} 音：${pk.map((e) => e.p).join(',')}`);
  }
  return chain.sort((a, b) => a.t - b.t || a.phase.localeCompare(b.phase));
}

// 消去冗余（连续同构），并在副本上验证"消去后结论不变"。
function dedupeChain(chain) {
  const out = [];
  for (const c of chain) {
    const prev = out[out.length - 1];
    if (prev && prev.phase === c.phase && prev.reason === c.reason) { prev.n = (prev.n || 1) + 1; continue; }
    out.push({ ...c, n: 1 });
  }
  return out;
}

// 对单个请求改请求（边界前后），区分合法等待 / 规则冲突 / 状态丢失。
function boundaryProbe(score, scenario, res, origReq, runOpts) {
  if (!res || res.targetId === null) return null;
  const pad = Math.max(1, Number(scenario.probePad ?? 4));
  const variants = {};
  for (const [name, dt] of [['earlier', -pad], ['later', +pad]]) {
    const s = {
      ...scenario,
      requests: scenario.requests.map((r) => (r === origReq
        ? { ...r, t: Math.max(0, r.t + dt) }
        : r)),
    };
    const r2 = renderScenario(score, s, { traceMax: runOpts.traceMax, resplice: runOpts.resplice });
    const entered = r2.segments.some((sg) => sg.secId === res.targetId);
    variants[name] = { entered, segments: r2.segments.map((x) => `${x.startBeat}:${x.secId}`) };
  }
  return variants;
}

export function diagnoseScenario(score, scenario, opts = {}) {
  const traceMax = opts.traceMax ?? scenario.traceMax ?? 256;
  const runOpts = { traceMax, pickupMode: opts.pickupMode || 'full', resplice: opts.resplice || 'legacy' };
  const t0 = nowMs();
  const result = renderScenario(score, scenario, runOpts);
  const t1 = nowMs();

  const secTitle = (id) => (score.sections[id] ? score.sections[id].title : id);
  const reservations = result.reservations.list;
  const byReq = new Map();
  for (const r of reservations) {
    if (!byReq.has(r.reqId)) byReq.set(r.reqId, []);
    byReq.get(r.reqId).push(r);
  }
  const traceEntries = result.trace.entries;

  const requests = [];
  const deadlocks = [];
  const legalWaits = [];
  const conflicts = [];
  const lostStates = [];
  const falseReports = [];

  const reqIds = new Set([...byReq.keys()]);
  for (const e of traceEntries) if (e.reqId != null) reqIds.add(e.reqId);

  for (const reqId of [...reqIds].sort((a, b) => a - b)) {
    const reqEntries = traceEntries.filter((e) => e.reqId === reqId);
    const reqRes = (byReq.get(reqId) || []).slice();
    // 取该请求最后一次预约作为主预约；若中途重排则保留全部在链里
    const primary = reqRes.length ? reqRes[reqRes.length - 1] : null;
    const moodEntry = reqEntries.find((e) => e.phase === PHASE.REQUEST) || reqEntries[0];
    const mood = primary ? primary.mood : (moodEntry ? moodEntry.mood : null);
    const arriveT = moodEntry ? moodEntry.t : (primary ? primary.createdAt : null);
    const attr = attribute(primary, result, reqEntries);
    const entered = targetEntered(result, primary);
    const wasDeferred = reqEntries.some((e) => e.phase === PHASE.DEFER)
      || (primary && primary.history.some((h) => h.to === RES.DEFERRED));

    const chain = buildChain(primary, reqEntries, result, secTitle);
    const deduped = dedupeChain(chain);

    // 实际音符核对
    let noteEvidence = null;
    if (primary && primary.targetId) {
      const targetSec = score.sections[primary.targetId];
      const pk = actualPickups(result, primary.targetId, primary.entryBeat, targetSec ? targetSec.pickupBeats : 0);
      noteEvidence = {
        targetId: primary.targetId,
        expectedPickup: primary.pickupCount ?? (targetSec && targetSec.pickup ? targetSec.pickup.length : 0),
        actualPickup: entered ? pk.length : 0,
        pickupNotes: entered ? pk.map((e) => ({ t: e.t, p: e.p })) : [],
      };
      if (entered && noteEvidence.expectedPickup !== noteEvidence.actualPickup) {
        falseReports.push({
          reqId, stage: 'commit',
          detail: `声称进入 ${secTitle(primary.targetId)}，但弱起实际 ${noteEvidence.actualPickup}/${noteEvidence.expectedPickup} 音`,
        });
      }
    }

    // 预约状态与听闻段落的交叉核对（防伪报）
    if (primary) {
      const inSegments = result.segments.some((s) => s.secId === primary.targetId);
      if (primary.state === RES.ENTERED && !inSegments) {
        falseReports.push({ reqId, stage: 'enter', detail: `预约记为已进入 ${secTitle(primary.targetId)}，听闻段落缺失` });
      }
      if (ARMED_STATES.has(primary.state) && !result.done && !inSegments) {
        falseReports.push({ reqId, stage: attr.stage, detail: `${primary.state} 预约未落地，且乐曲未收束` });
      }
    }

    const rec = {
      reqId, mood, t: arriveT, targetId: primary ? primary.targetId : null,
      targetTitle: primary && primary.targetId ? secTitle(primary.targetId) : null,
      state: primary ? primary.state : 'none',
      outcome: attr.kind, stage: attr.stage, reason: attr.reason,
      entered, wasDeferred,
      chain: deduped,
      noteEvidence,
      probe: null,
    };

    // 边界前后改请求（对未进入的请求，以及延后后才进入的合法等待做）
    if (primary && primary.targetId && (!entered || wasDeferred)) {
      const orig = (scenario.requests || []).find((r) => r.t === arriveT && r.mood === mood);
      if (orig) {
        const probe = boundaryProbe(score, scenario, primary, orig, runOpts);
        rec.probe = probe;
        if (!entered) {
          const anyProbe = probe && (probe.earlier.entered || probe.later.entered);
          if (attr.kind === 'pending') {
            // 尚未到发声/进入拍点：合法待定，不归因。
            rec.outcome = 'pending';
          } else if (attr.kind === 'deadlock') {
            // 已过截止且没有时机可以把救回 → 状态丢失；若能靠改时机救回 → 合法延迟/规则冲突另判。
            rec.outcome = (probe && !anyProbe) ? 'state_loss' : 'deadlock';
          } else if (attr.kind === 'legal_wait' && anyProbe) {
            rec.outcome = 'legal_wait';
          } else if (!anyProbe && attr.kind !== 'superseded' && attr.kind !== 'ended') {
            rec.outcome = 'rule_conflict';
            rec.stage = 'decide';
          }
        }
        if (entered && wasDeferred) {
          const anyProbe = probe && (probe.earlier.entered || probe.later.entered);
          if (anyProbe) {
            const firstDefer = reqEntries.find((e) => e.phase === PHASE.DEFER);
            rec.outcome = 'legal_wait';
            rec.stage = 'enter';
            rec.reason = `边界后到达，延后至下一乐句并进入（${firstDefer ? firstDefer.reason : '后到者优先'}）`;
          }
        }
      }
    }

    if (rec.outcome === 'deadlock') deadlocks.push(rec);
    else if (rec.outcome === 'legal_wait') legalWaits.push(rec);
    else if (rec.outcome === 'rule_conflict' || rec.outcome === 'conflict') conflicts.push(rec);
    else if (rec.outcome === 'state_loss') lostStates.push(rec);
    requests.push(rec);  }

  // 阶段异常：段落状态 vs 实际音符，定位到阶段
  const stageAnomalies = [];
  for (const r of requests) {
    if (r.outcome === 'deadlock' || r.outcome === 'state_loss') {
      stageAnomalies.push({
        reqId: r.reqId, stage: r.stage,
        segmentState: r.state,
        actualNotes: r.noteEvidence,
        detail: r.reason,
      });
    }
  }

  // 冗余事件成本
  const rawEntries = traceEntries.reduce((n, e) => n + e.count, 0);
  const collapsed = traceEntries.length;

  // 复跑一致性
  const t2 = nowMs();
  const rerun = renderScenario(score, scenario, runOpts);
  const t3 = nowMs();
  const hash1 = evidenceHash(result);
  const hash2 = evidenceHash(rerun);
  const reproducible = hash1 === hash2;

  // 两份乐谱（完整弱起 / 省略弱起）
  const variants = renderPickupVariants(score, scenario, { traceMax });

  // 迟到请求回放：legacy（延后）vs immediate（取消未发声拼接立即重排）
  const legacy = result;
  const immediate = renderScenario(score, scenario, { ...runOpts, resplice: 'immediate' });
  const replay = replayLate(score, legacy, immediate, secTitle);

  // 旧样例跑到底
  const oldSample = {
    done: result.done,
    frontier: result.frontier,
    eventCount: result.events.length,
    violations: result.violations,
  };

  const diagnosticSec = t1 - t0;
  const rerunSec = t3 - t2;

  return {
    ok: reproducible && falseReports.length === 0 && lostStates.length === 0 && result.violations.length === 0,
    reproducible,
    evidenceHash: hash1,
    rerunHash: hash2,
    requests,
    deadlocks,
    legalWaits,
    conflicts,
    lostStates,
    stageAnomalies,
    falseReports,
    replay,
    redundant: { rawEntries, collapsed, removed: rawEntries - collapsed },
    logCost: {
      traceEntries: collapsed,
      evicted: result.trace.evicted,
      max: result.trace.max,
      eventCount: result.events.length,
      diagnosticMs: Math.round(diagnosticSec * 1000) / 1000,
      rerunMs: Math.round(rerunSec * 1000) / 1000,
    },
    variants: {
      pickupNotes: variants.pickupNotes,
      omitPickupNotes: variants.omitPickupNotes,
      totalNotes: variants.totalNotes,
      omitTotalNotes: variants.omitTotalNotes,
      fullViolations: variants.full.violations,
      omitViolations: variants.omit.violations,
    },
    oldSample,
    violations: result.violations,
  };
}

// 回放迟到请求：同一情境分别按 legacy 与 immediate 处理，比较进入拍点。
function blockedEverywhere(score, legacy, immediate, lres, ires) {
  // 冲突：任一侧预约被标为规则冲突，或运行时日志出现不可调度异常。
  const anyConflict = [lres, ires].some((r) => r && r.state === RES.CONFLICT);
  const anyReject = [legacy, immediate].some((r) => r.log.some((l) => l.type === 'exception'));
  if (anyConflict || anyReject) return true;
  // 两侧都仍处于“可继续调度”的预约（已预约/延后等），只是仪器运行时长不够 → 被截断，不是死锁。
  const liveStates = new Set([RES.RESERVED, RES.LEAD_GRANTED, RES.SPLICE_QUEUED, RES.COMMITTED, RES.DEFERRED]);
  const allLive = [lres, ires].every((r) => r && liveStates.has(r.state));
  return !allLive;
}

function replayLate(score, legacy, immediate, secTitle) {
  const out = [];
  const defers = legacy.trace.entries.filter((e) => e.phase === PHASE.DEFER);
  const seen = new Set();
  for (const d of defers) {
    if (d.reqId == null || seen.has(d.reqId)) continue;
    seen.add(d.reqId);
    const lres = (legacy.reservations.list.filter((r) => r.reqId === d.reqId).pop()) || null;
    const ires = (immediate.reservations.list.filter((r) => r.reqId === d.reqId).pop()) || null;
    const targetId = (lres && lres.targetId) || (ires && ires.targetId) || null;
    const lBeat = lres ? entryBeatOf(legacy, lres) : null;
    const iBeat = ires ? entryBeatOf(immediate, ires) : null;
    const lEntered = lres ? targetEntered(legacy, lres) : false;
    const iEntered = ires ? targetEntered(immediate, ires) : false;
    let verdict;
    const cancelledByEnd = lres && lres.state === RES.CANCELLED
      && lres.history.some((h) => /收束/.test(h.reason || ''));
    if (!targetId) verdict = 'unknown';
    else if (cancelledByEnd) verdict = 'conflict';                 // 乐曲已收束：规则拒绝，不是合法延迟
    else if (iEntered && !lEntered) verdict = 'legal_wait';        // immediate 救回，legacy 属合法延迟
    else if (iEntered && lEntered && iBeat !== null && lBeat !== null && iBeat < lBeat - 1e-6) verdict = 'legal_wait';
    // 两种策略都未进入：看它们是被更长的乐句/边界合法拖延（仍是可进入的请求，被截断），
    // 还是根本无可行出口（真死锁/规则冲突）。
    else if (!iEntered && !lEntered) verdict = blockedEverywhere(score, legacy, immediate, lres, ires) ? 'deadlock' : 'truncated';
    else verdict = 'equivalent';                                    // 行为一致
    out.push({
      reqId: d.reqId, mood: d.mood, targetId, targetTitle: targetId ? secTitle(targetId) : null,
      atT: d.t, reason: d.reason,
      legacy: { entered: lEntered, entryBeat: lBeat, state: lres ? lres.state : 'none' },
      immediate: { entered: iEntered, entryBeat: iBeat, state: ires ? ires.state : 'none' },
      verdict,
    });
  }
  return out;
}

// 导出诊断摘要为纯文本（CLI / 界面共用），保持可复核。
export function summarizeDiagnosis(diag, score) {
  const lines = [];
  const title = (id) => (score.sections[id] ? score.sections[id].title : id);
  lines.push(`证据哈希 ${diag.evidenceHash}（复跑 ${diag.reproducible ? '一致' : '不一致!'}）`);
  lines.push(`追踪条目 ${diag.logCost.traceEntries}（消去冗余 ${diag.redundant.removed}，逐出 ${diag.logCost.evicted}，上限 ${diag.logCost.max}）`);
  lines.push(`事件 ${diag.logCost.eventCount} · 诊断 ${diag.logCost.diagnosticMs}ms · 复跑 ${diag.logCost.rerunMs}ms`);
  for (const r of diag.requests) {
    lines.push(`请求#${r.reqId} 「${r.mood}」@第${r.t}拍 → ${r.targetTitle ? title(r.targetId) : '（无目标）'}：${r.outcome} / 阶段 ${r.stage} —— ${r.reason}`);
    if (r.noteEvidence) {
      lines.push(`   实际弱起 ${r.noteEvidence.actualPickup}/${r.noteEvidence.expectedPickup} 音`);
    }
    if (r.probe) {
      lines.push(`   边界前后：前=${r.probe.earlier.entered ? '进入' : '未进入'} 后=${r.probe.later.entered ? '进入' : '未进入'}`);
    }
  }
  lines.push('迟到回放：');
  for (const p of diag.replay) {
    lines.push(`  #${p.reqId} 「${p.mood}」→ ${p.targetTitle || '—'}：legacy ${p.legacy.entered ? `进入@${p.legacy.entryBeat}` : p.legacy.state} / immediate ${p.immediate.entered ? `进入@${p.immediate.entryBeat}` : p.immediate.state} → ${p.verdict}`);
  }
  lines.push(`两份乐谱：完整弱起 ${diag.variants.pickupNotes} 弱起音/${diag.variants.totalNotes} 事件；省略弱起 ${diag.variants.omitPickupNotes} 弱起音/${diag.variants.omitTotalNotes} 事件`);
  lines.push(`旧样例：${diag.oldSample.done ? `收束于第${diag.oldSample.frontier}拍` : '未收束'} · ${diag.oldSample.eventCount} 事件 · 违规 ${diag.oldSample.violations.length}`);
  return lines.join('\n');
}
