// 离线渲染：把情境序列跑成确定的事件流（结果区与 CLI 共用）。
import { Engine } from './scheduler.js';
import { verifyRender } from './verify.js';
import { loopLen } from './score-data.js';

export function renderScenario(score, scenario, opts = {}) {
  const eng = new Engine(score, { start: scenario.start || score.start, ...opts });
  const reqs = [...(scenario.requests || [])].sort((a, b) => a.t - b.t);
  const until = scenario.until ?? 128;
  const step = 0.25;
  let t = 0;
  while (eng.frontier < until - 1e-9 && !eng.done) {
    while (reqs.length && reqs[0].t <= t + 1e-9) {
      const r = reqs.shift();
      eng.requestContext(r.mood, r.t);
    }
    eng.advanceTo(t + step);
    t += step;
  }
  for (const r of reqs) eng.requestContext(r.mood, Math.max(r.t, eng.frontier));
  const result = eng.snapshotResult();
  result.violations = verifyRender(score, result);
  return result;
}

// 单段试听：主题段渲染一遍循环，过渡/收束段渲染一遍本体。
export function renderSectionAudition(score, secId, opts = {}) {
  const sec = score.sections[secId];
  const until = sec.kind === 'theme' ? loopLen(sec) : loopLen(sec) + 2;
  return renderScenario(score, { start: secId, until, requests: [] }, opts);
}

// 两份乐谱导出：带完整弱起 / 省略弱起。除弱起策略外其余输入完全一致，便于核对实际音符数。
export function renderPickupVariants(score, scenario, opts = {}) {
  const full = renderScenario(score, scenario, { ...opts, pickupMode: 'full' });
  const omit = renderScenario(score, scenario, { ...opts, pickupMode: 'omit' });
  return {
    full,
    omit,
    pickupNotes: full.events.filter((e) => e.role === 'pickup').length,
    omitPickupNotes: omit.events.filter((e) => e.role === 'pickup').length,
    totalNotes: full.events.length,
    omitTotalNotes: omit.events.length,
  };
}

// 导出为可下载的乐谱 JSON（事件 + 段落 + 接点 + 证据），供复跑比对。
export function scoreExport(score, result, label) {
  return {
    label,
    pickupMode: result.pickupMode,
    tempoMap: score.sections,
    events: result.events,
    segments: result.segments,
    joins: result.joins,
    noteCount: result.events.length,
    pickupCount: result.events.filter((e) => e.role === 'pickup').length,
    violations: result.violations,
  };
}
