import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCORE } from '../src/score-data.js';
import { parseChord, keysCompatible, chordsCompatible } from '../src/theory.js';
import { findPath } from '../src/graph.js';
import { validateScore } from '../src/validate.js';
import { Engine } from '../src/scheduler.js';
import { renderScenario } from '../src/render.js';
import { DEMO_SCENARIO } from '../src/scenarios.js';

const segIds = (r) => r.segments.map((s) => s.secId);
const logsOf = (r, type) => r.log.filter((l) => l.type === type);

test('乐理：调性兼容规则', () => {
  const D = { tonic: 2, mode: 'major' };
  const Bm = { tonic: 11, mode: 'minor' };
  const G = { tonic: 7, mode: 'major' };
  const Eb = { tonic: 3, mode: 'major' };
  assert.equal(keysCompatible(D, Bm), true);   // 关系大小调
  assert.equal(keysCompatible(D, G), true);    // 四度关系
  assert.equal(keysCompatible(Bm, G), false);  // 需过渡段
  assert.equal(keysCompatible(D, Eb), false);
});

test('乐理：和弦连接兼容规则', () => {
  assert.equal(chordsCompatible(parseChord('D'), parseChord('Bm')), true);
  assert.equal(chordsCompatible(parseChord('D'), parseChord('G')), true);
  assert.equal(chordsCompatible(parseChord('A7'), parseChord('Bm')), false);
});

test('曲谱体检通过（drift 不可达为设计内警告）', () => {
  const { errors, warnings } = validateScore(SCORE);
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.includes('theme_drift')));
});

test('连接图：不兼容调性必须经过渡段，不可任意直连', () => {
  assert.deepEqual(findPath(SCORE, 'theme_tide', 'theme_anthem'), ['tr_ember', 'theme_anthem']);
  assert.deepEqual(findPath(SCORE, 'theme_anthem', 'theme_tide'), ['tr_dusk', 'theme_tide']);
  assert.equal(findPath(SCORE, 'theme_dawn', 'theme_drift'), null);
  assert.equal(findPath(SCORE, 'theme_tide', 'ending_home'), null); // 主题不可中转
});

test('无请求时主题段循环，事件时间非负', () => {
  const r = renderScenario(SCORE, { start: 'theme_dawn', until: 40, requests: [] });
  assert.deepEqual(segIds(r), ['theme_dawn']);
  assert.ok(r.events.every((e) => e.t >= 0));
  assert.deepEqual(r.violations, []);
});

test('正常换乘：请求在下一乐句边界生效', () => {
  const r = renderScenario(SCORE, { start: 'theme_dawn', until: 40, requests: [{ t: 6, mood: 'tense' }] });
  assert.deepEqual(segIds(r), ['theme_dawn', 'theme_tide']);
  assert.equal(r.segments[1].startBeat, 16);
  assert.deepEqual(r.violations, []);
});

test('来得太晚：决策点之后的请求顺延到下一出口', () => {
  const r = renderScenario(SCORE, { start: 'theme_dawn', until: 70, requests: [{ t: 13, mood: 'tense' }] });
  // 第16拍出口的决策点是第12拍；t=13 已晚 → 顺延到第32拍
  assert.equal(r.segments[1].startBeat, 32);
  assert.equal(r.segments[1].secId, 'theme_tide');
  assert.deepEqual(r.violations, []);
});

test('抢占：锁定点前连续改调，重排过渡', () => {
  const r = renderScenario(SCORE, {
    start: 'theme_dawn', until: 60,
    requests: [{ t: 5, mood: 'tense' }, { t: 8, mood: 'heroic' }],
  });
  assert.equal(logsOf(r, 'preempt').length, 1);
  assert.deepEqual(segIds(r), ['theme_dawn', 'theme_anthem']);
  assert.equal(r.segments[1].startBeat, 16);
  assert.deepEqual(r.violations, []);
});

test('延后：锁定点后请求入队，过渡完成后出队重排', () => {
  const r = renderScenario(SCORE, {
    start: 'theme_dawn', until: 80,
    requests: [{ t: 5, mood: 'tense' }, { t: 13, mood: 'heroic' }],
  });
  assert.equal(logsOf(r, 'defer').length, 1);
  assert.equal(logsOf(r, 'dequeue').length, 1);
  assert.deepEqual(segIds(r), ['theme_dawn', 'theme_tide', 'tr_ember', 'theme_anthem']);
  assert.equal(r.segments[1].startBeat, 16);
  assert.equal(r.segments[2].startBeat, 32); // 过渡段在出口拍进入
  assert.equal(r.segments[3].startBeat, 40); // 过渡段 2 小节 = 8 拍
  assert.deepEqual(r.violations, []);
});

test('弱起：不同长度弱起铺在旧段最后一小节内', () => {
  const r = renderScenario(SCORE, { start: 'theme_dawn', until: 60, requests: [{ t: 6, mood: 'heroic' }] });
  const E = r.segments[1].startBeat;
  const pickups = r.events.filter((e) => e.sec === 'theme_anthem' && e.role === 'pickup');
  assert.equal(pickups.length, 2); // 主题·歌弱起 2 拍
  assert.ok(pickups.every((e) => e.t >= E - 2 && e.t < E));
  const tidePickups = r.events.filter((e) => e.sec === 'theme_tide' && e.role === 'pickup');
  assert.equal(tidePickups.length, 0); // 主题·潮无弱起
  assert.deepEqual(r.violations, []);
});

test('跨界延音与上一段尾部：越界发声不被截断', () => {
  const r = renderScenario(SCORE, { start: 'theme_dawn', until: 60, requests: [{ t: 20, mood: 'tense' }] });
  // t=20 → 决策 20，第16拍出口已过 → 第32拍（晨·第二乐句，带延音与尾部）
  const E = 32;
  assert.equal(r.segments[1].startBeat, E);
  const tie = r.events.find((e) => e.sec === 'theme_dawn' && e.tie && e.t < E && e.t + e.d > E);
  assert.ok(tie, '应存在越过接点的延音');
  assert.ok(tie.t + tie.d <= E + tie.tie + 1e-6);
  const tail = r.events.find((e) => e.sec === 'theme_dawn' && e.role === 'tail' && e.t >= E);
  assert.ok(tail, '应存在上一段尾部');
  assert.deepEqual(r.violations, []);
});

test('出口选择按和声过滤：延音不合的出口被跳过', () => {
  // 主题·歌第二乐句出口的延音 G 与主题·晨起始和弦 D 不合 → 只能用第一乐句出口
  const r = renderScenario(SCORE, {
    start: 'theme_anthem', until: 80,
    requests: [{ t: 18, mood: 'calm' }],
  });
  // 歌的乐句终止：16（第一乐句）、32（第二乐句）；t=18 → 决策≥18，32-4=28 ≥ 18 但和声不合 → 48
  assert.equal(r.segments[1].startBeat, 48);
  assert.equal(r.segments[1].secId, 'theme_dawn');
  assert.deepEqual(r.violations, []);
});

test('不可达目标：异常提示且音乐不被打断', () => {
  const r = renderScenario(SCORE, { start: 'theme_dawn', until: 40, requests: [{ t: 6, mood: 'drift' }] });
  assert.equal(logsOf(r, 'exception').length, 1);
  assert.ok(logsOf(r, 'exception')[0].msg.includes('没有声明的可达路径'));
  assert.deepEqual(segIds(r), ['theme_dawn']);
  assert.deepEqual(r.violations, []);
});

test('收束：ending 后引擎停止，后续请求被拒绝', () => {
  const r = renderScenario(SCORE, {
    start: 'theme_dawn', until: 80,
    requests: [{ t: 6, mood: 'end' }, { t: 40, mood: 'tense' }],
  });
  assert.deepEqual(segIds(r), ['theme_dawn', 'ending_home']);
  assert.equal(r.done, true);
  assert.ok(r.events.every((e) => e.t < 40));
  assert.ok(logsOf(r, 'exception').some((l) => l.msg.includes('已收束')));
  assert.deepEqual(r.violations, []);
});

test('end 情境按当前调性选择收束段', () => {
  const r = renderScenario(SCORE, {
    start: 'theme_tide', until: 60,
    requests: [{ t: 4, mood: 'end' }],
  });
  assert.deepEqual(segIds(r), ['theme_tide', 'ending_fall']);
  assert.deepEqual(r.violations, []);
});

test('重复请求与同情境请求不产生计划', () => {
  const r = renderScenario(SCORE, {
    start: 'theme_dawn', until: 40,
    requests: [{ t: 2, mood: 'calm' }, { t: 6, mood: 'tense' }, { t: 8, mood: 'tense' }],
  });
  assert.equal(logsOf(r, 'already').length, 1);
  assert.equal(logsOf(r, 'keep').length, 1);
  assert.equal(logsOf(r, 'plan').length, 1);
  assert.deepEqual(r.violations, []);
});

test('锁定点前请求当前情绪：撤销待定过渡并留在原段', () => {
  const r = renderScenario(SCORE, {
    start: 'theme_dawn', until: 48,
    requests: [{ t: 5, mood: 'tense' }, { t: 8, mood: 'calm' }],
  });
  assert.equal(logsOf(r, 'preempt').length, 1);
  assert.deepEqual(segIds(r), ['theme_dawn']);
  assert.deepEqual(r.violations, []);
});

test('示例情境：全规则演练且校验通过、可重放（确定性）', () => {
  const r1 = renderScenario(SCORE, DEMO_SCENARIO);
  const r2 = renderScenario(SCORE, DEMO_SCENARIO);
  assert.deepEqual(r1.violations, []);
  assert.deepEqual(segIds(r1), [
    'theme_dawn', 'theme_tide', 'theme_dawn', 'theme_anthem',
    'theme_dawn', 'theme_tide', 'tr_ember', 'theme_anthem', 'ending_home',
  ]);
  assert.equal(logsOf(r1, 'preempt').length, 1);
  assert.ok(logsOf(r1, 'defer').length >= 2);
  assert.ok(logsOf(r1, 'exception').some((l) => l.msg.includes('可达路径')));
  assert.equal(JSON.stringify(r1.events), JSON.stringify(r2.events));
  assert.equal(JSON.stringify(r1.log), JSON.stringify(r2.log));
});

test('计划路径与听闻一致（校验器独立复核）', () => {
  const r = renderScenario(SCORE, DEMO_SCENARIO);
  const preempted = new Set(logsOf(r, 'preempt').map((l) => l.data.oldPlanId));
  const plans = logsOf(r, 'plan').map((l) => l.data.plan).filter((p) => !preempted.has(p.id));
  const heard = r.segments.map((s) => s.secId);
  for (const p of plans) {
    const idx = r.segments.findIndex((s) => s.startBeat === p.exitBeat);
    assert.ok(idx >= 0, `计划出口 ${p.exitBeat} 应出现在听闻中`);
    assert.deepEqual(heard.slice(idx, idx + p.path.length), p.path);
  }
});

test('事件时间不倒退、和声轨连续', () => {
  const r = renderScenario(SCORE, DEMO_SCENARIO);
  assert.ok(r.events.every((e) => e.t >= 0));
  for (let i = 1; i < r.harmony.length; i++) {
    assert.ok(r.harmony[i].t >= r.harmony[i - 1].t, '和声轨单调');
    assert.ok(Math.abs(r.harmony[i].t - (r.harmony[i - 1].t + r.harmony[i - 1].d)) < 1e-3, '和声轨连续');
  }
  for (let i = 1; i < r.segments.length; i++) {
    assert.ok(r.segments[i].startBeat > r.segments[i - 1].startBeat);
  }
});

test('引擎可单步驱动（现场模式接口）', () => {
  const eng = new Engine(SCORE, { start: 'theme_dawn' });
  eng.advanceTo(10);
  const res = eng.requestContext('tense', 6);
  assert.equal(res.type, 'plan');
  eng.advanceTo(40);
  assert.equal(eng.segments.length, 2);
  assert.equal(eng.segments[1].secId, 'theme_tide');
  assert.ok(eng.events.every((e) => e.t >= 0));
});
