import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCORE } from '../src/score-data.js';
import { renderScenario, renderPickupVariants } from '../src/render.js';
import { Engine } from '../src/scheduler.js';
import { diagnoseScenario, evidenceHash } from '../src/diagnosis.js';
import { Trace, PHASE } from '../src/trace.js';
import { RES } from '../src/reservation.js';
import { DEMO_SCENARIO } from '../src/scenarios.js';

const segIds = (r) => r.segments.map((s) => s.secId);
const at = (r, beat) => r.segments.find((s) => Math.abs(s.startBeat - beat) < 1e-6);

// 请求恰在下一乐句首个弱起音排队后、发声前到达（边界条件）。
const LEAD_BOUNDARY = {
  start: 'theme_dawn', until: 60,
  requests: [{ t: 6, mood: 'heroic' }, { t: 12.5, mood: 'tense' }],
};

// ---- 追踪与预约 ----

test('追踪：连续同构事件被消去为计数，日志成本有界', () => {
  const tr = new Trace({ max: 4 });
  for (let i = 0; i < 10; i++) tr.push({ t: 1, phase: PHASE.DEFER, reqId: 1, reason: '同一原因' });
  assert.equal(tr.entries.length, 1);
  assert.equal(tr.entries[0].count, 10);
  for (let i = 0; i < 8; i++) tr.push({ t: i + 2, phase: PHASE.REQUEST, reqId: i + 2 });
  assert.ok(tr.entries.length <= 4);
  assert.ok(tr.evicted > 0);
});

test('预约：每个请求有可撤销状态链，撤销后标记终态', () => {
  const r = renderScenario(SCORE, DEMO_SCENARIO);
  assert.ok(r.reservations.list.length > 0);
  const states = new Set(r.reservations.list.map((x) => x.state));
  assert.ok(states.has(RES.ENTERED));
  assert.ok(states.has(RES.SUPERSEDED));
  for (const res of r.reservations.list) {
    assert.ok(res.history.length >= 1, `预约#${res.id} 应有状态链`);
    assert.equal(res.history[res.history.length - 1].to, res.state);
  }
});

test('分离乐句就绪 ≠ 提交：弱起排队后、发声前可撤销', () => {
  const legacy = renderScenario(SCORE, LEAD_BOUNDARY, { resplice: 'legacy' });
  const immediate = renderScenario(SCORE, LEAD_BOUNDARY, { resplice: 'immediate' });
  // legacy：延后到下一乐句经 tr_dusk 进入潮
  assert.equal(legacy.log.filter((l) => l.type === 'defer').length, 1);
  assert.deepEqual(segIds(legacy).slice(0, 2), ['theme_dawn', 'theme_anthem']);
  assert.ok(legacy.segments.some((s) => s.secId === 'theme_tide'));
  // immediate：取消未发声拼接，就在第 16 拍边界改去潮
  assert.ok(immediate.log.some((l) => l.type === 'preempt' && l.msg.includes('未发声拼接')));
  assert.deepEqual(segIds(immediate), ['theme_dawn', 'theme_tide']);
  assert.equal(immediate.segments[1].startBeat, 16);
  assert.deepEqual(legacy.violations, []);
  assert.deepEqual(immediate.violations, []);
});

test('提交后再到达：不能撤销已发声拼接，只能延后接管', () => {
  // t=14.5 已在首个弱起音（第 14 拍）发声之后
  const scen = {
    start: 'theme_dawn', until: 60,
    requests: [{ t: 6, mood: 'heroic' }, { t: 14.5, mood: 'tense' }],
  };
  const immediate = renderScenario(SCORE, scen, { resplice: 'immediate' });
  assert.equal(immediate.log.filter((l) => l.type === 'preempt').length, 0);
  assert.equal(immediate.log.filter((l) => l.type === 'defer').length, 1);
  assert.ok(immediate.log.some((l) => l.type === 'defer' && l.msg.includes('已发声提交')));
  assert.deepEqual(segIds(immediate).slice(0, 2), ['theme_dawn', 'theme_anthem']);
  assert.deepEqual(immediate.violations, []);
});

test('提交时刻以弱起实际发声拍记录（预约 committedBeat）', () => {
  const r = renderScenario(SCORE, { start: 'theme_dawn', until: 40, requests: [{ t: 6, mood: 'heroic' }] });
  const res = r.reservations.list.find((x) => x.targetId === 'theme_anthem' && x.state === RES.ENTERED);
  assert.ok(res);
  const pickup = r.events.filter((e) => e.sec === 'theme_anthem' && e.role === 'pickup');
  assert.equal(res.committedBeat, Math.min(...pickup.map((e) => e.t)));
});

// ---- 提前量 ----

test('拼接器申请提前量：计划记录所需/实得提前量且实得 ≥ 所需', () => {
  const r = renderScenario(SCORE, { start: 'theme_dawn', until: 40, requests: [{ t: 6, mood: 'tense' }] });
  const plan = r.reservations.list.find((x) => x.state === RES.ENTERED);
  assert.ok(plan);
  assert.equal(plan.requiredLead, SCORE.sections.theme_dawn.prepareBeats);
  assert.ok(plan.grantedLead >= plan.requiredLead);
});

// ---- 双份乐谱 ----

test('双份乐谱：完整弱起与省略弱起仅差弱起音，事件数与校验一致', () => {
  const v = renderPickupVariants(SCORE, DEMO_SCENARIO);
  assert.ok(v.pickupNotes > 0);
  assert.equal(v.omitPickupNotes, 0);
  assert.equal(v.totalNotes - v.omitTotalNotes, v.pickupNotes);
  assert.deepEqual(v.full.violations, []);
  assert.deepEqual(v.omit.violations, []);
  assert.deepEqual(segIds(v.full), segIds(v.omit));
});

// ---- 诊断 ----

test('诊断：分段状态与实际音符对应到执行证据，无伪报', () => {
  const d = diagnoseScenario(SCORE, DEMO_SCENARIO);
  assert.equal(d.falseReports.length, 0);
  assert.equal(d.lostStates.length, 0);
  assert.equal(d.deadlocks.length, 0);
  for (const req of d.requests) {
    if (req.outcome !== 'entered') continue;
    // 已进入的请求，实际弱起音符数必须与预约一致
    assert.equal(req.noteEvidence.actualPickup, req.noteEvidence.expectedPickup);
  }
});

test('诊断：复跑证据哈希一致（段落配乐复跑证据保持一致）', () => {
  const d1 = diagnoseScenario(SCORE, DEMO_SCENARIO);
  const d2 = diagnoseScenario(SCORE, DEMO_SCENARIO);
  assert.equal(d1.evidenceHash, d2.evidenceHash);
  assert.equal(d1.reproducible, true);
});

test('诊断：边界前后改请求区分合法等待，且回放区分真死锁', () => {
  const d = diagnoseScenario(SCORE, LEAD_BOUNDARY);
  const req = d.requests.find((r) => r.mood === 'tense');
  assert.ok(req);
  assert.equal(req.outcome, 'legal_wait');
  assert.ok(req.probe, '应有边界前后探测');
  const replay = d.replay.find((p) => p.mood === 'tense');
  assert.ok(replay);
  assert.equal(replay.verdict, 'legal_wait');
  assert.ok(replay.immediate.entered);
  assert.ok(replay.immediate.entryBeat < replay.legacy.entryBeat);
});

test('诊断：不可达请求归为规则冲突，阶段定位到决策点', () => {
  const scen = {
    start: 'theme_dawn', until: 60,
    requests: [{ t: 6, mood: 'drift' }],
  };
  const d = diagnoseScenario(SCORE, scen);
  const req = d.requests.find((r) => r.mood === 'drift');
  assert.ok(req);
  assert.equal(req.outcome, 'conflict');
  assert.equal(req.stage, 'decide');
  assert.match(req.reason, /可达路径/);
});

test('诊断：旧样例运行到底且无违规', () => {
  const d = diagnoseScenario(SCORE, DEMO_SCENARIO);
  assert.equal(d.oldSample.done, true);
  assert.equal(d.oldSample.eventCount, 143);
  assert.equal(d.oldSample.violations.length, 0);
});

test('诊断：日志成本有界且冗余被消去', () => {
  const d = diagnoseScenario(SCORE, DEMO_SCENARIO);
  assert.ok(d.logCost.traceEntries <= d.logCost.max);
  assert.ok(d.redundant.rawEntries >= d.redundant.collapsed);
  assert.equal(d.redundant.removed, d.redundant.rawEntries - d.redundant.collapsed);
});

test('诊断：小追踪预算下逐出但结论仍复跑一致', () => {
  const d = diagnoseScenario(SCORE, { ...DEMO_SCENARIO, traceMax: 8 });
  assert.ok(d.logCost.traceEntries <= 8);
  assert.ok(d.logCost.evicted > 0);
  assert.equal(d.reproducible, true);
});

test('诊断：迟到回放区分真死锁与被运行截断（不伪报）', () => {
  // 只有一条不会被接受的请求 + 很短时长：两侧都未进入，但应判为“截断”而非“死锁”。
  const scen = {
    start: 'theme_dawn', until: 12,
    requests: [{ t: 11, mood: 'tense' }],
  };
  const d = diagnoseScenario(SCORE, scen);
  const r = d.replay[0];
  if (r) assert.notEqual(r.verdict, 'deadlock', `应为截断/其它，实为 ${r.verdict}`);
  assert.equal(d.deadlocks.length, 0, '不应因运行截断误报死锁');
});

test('诊断不改动正在发声的乐句：诊断前后事件流一致', () => {
  const baseline = renderScenario(SCORE, DEMO_SCENARIO);
  diagnoseScenario(SCORE, DEMO_SCENARIO);
  const after = renderScenario(SCORE, DEMO_SCENARIO);
  assert.equal(JSON.stringify(baseline.events), JSON.stringify(after.events));
  assert.equal(evidenceHash(baseline), evidenceHash(after));
});

// ---- 现场引擎与诊断同源 ----

test('快照与离线渲染同源（现场诊断可用同一证据形状）', () => {
  const eng = new Engine(SCORE, { start: 'theme_dawn' });
  eng.requestContext('tense', 6);
  eng.advanceTo(40);
  const snap = eng.snapshotResult();
  assert.ok(Array.isArray(snap.reservations.list));
  assert.ok(snap.trace.entries.length > 0);
  const seg = snap.segments.find((s) => s.secId === 'theme_tide');
  assert.ok(seg);
  assert.equal(seg.startBeat, 16);
});
