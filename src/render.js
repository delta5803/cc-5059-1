// 离线渲染：把情境序列跑成确定的事件流（结果区与 CLI 共用）。
import { Engine } from './scheduler.js';
import { verifyRender } from './verify.js';
import { loopLen } from './score-data.js';

export function renderScenario(score, scenario) {
  const eng = new Engine(score, { start: scenario.start || score.start });
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
  const result = {
    events: eng.events,
    harmony: eng.harmony,
    segments: eng.segments,
    joins: eng.joins,
    log: eng.log,
    done: eng.done,
    frontier: eng.frontier,
    frontierSec: eng.frontierSec,
  };
  result.violations = verifyRender(score, result);
  return result;
}

// 单段试听：主题段渲染一遍循环，过渡/收束段渲染一遍本体。
export function renderSectionAudition(score, secId) {
  const sec = score.sections[secId];
  const until = sec.kind === 'theme' ? loopLen(sec) : loopLen(sec) + 2;
  return renderScenario(score, { start: secId, until, requests: [] });
}
