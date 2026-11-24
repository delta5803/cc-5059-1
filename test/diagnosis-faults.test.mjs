// 诊断的“负例”测试：人为注入故障，确认诊断能真正识别死锁 / 状态丢失 / 伪报，
// 而不是只对健康运行给出“通过”。注入通过替换引擎方法实现，不修改源码文件。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCORE } from '../src/score-data.js';
import { Engine } from '../src/scheduler.js';
import { diagnoseScenario } from '../src/diagnosis.js';
import { RES } from '../src/reservation.js';

// 在诊断跑动的多处会重建 Engine；用原型补丁让特定场景触发故障，结束后还原。
function withFault(patch, fn) {
  const originals = {};
  for (const [name, impl] of Object.entries(patch)) {
    originals[name] = Engine.prototype[name];
    Engine.prototype[name] = impl(originals[name]);
  }
  try { return fn(); } finally {
    for (const [name, impl] of Object.entries(originals)) Engine.prototype[name] = impl;
  }
}

const SCEN = { start: 'theme_dawn', until: 200, requests: [{ t: 6, mood: 'heroic' }, { t: 12.5, mood: 'tense' }] };

test('负例·真死锁：状态显示已提交却始终不进入目标段 → 判死锁，不误判为合法等待', () => {
  // doSwitch 会把预约推进到“已进入”。这里把它退化为：只标记提交、不推进段落、也不置 entered。
  const d = withFault({
    doSwitch: () => function () {
      this.switchNext = null;
      if (this.plan && this.plan.resId) {
        this.book.transition(this.plan.resId, this.frontier, RES.COMMITTED, '注入：卡在提交态');
      }
      // 故意不 push 段落、不切换 cur、不进入 —— 模拟“已提交但状态丢失”
      this.done = false;
    },
  }, () => diagnoseScenario(SCORE, SCEN));
  const stuck = d.requests.filter((r) => ['deadlock', 'state_loss'].includes(r.outcome));
  assert.ok(stuck.length > 0, `应识别死锁/状态丢失，实为 ${d.requests.map((r) => `${r.mood}:${r.outcome}`).join(', ')}`);
  assert.equal(d.ok, false);
});

test('负例·提交丢失：拼接已就绪却不发声 → 记为伪报（声称进入但弱起 0 音）', () => {
  // 让 flushSplice 永不把拼接音写入发声流：段落边界仍会切换，但弱起音符丢失。
  const d = withFault({ flushSplice: () => function () { /* 永不提交 */ } }, () => diagnoseScenario(SCORE, SCEN));
  assert.ok(d.falseReports.length > 0, '应记录伪报');
  assert.ok(d.falseReports.some((f) => f.stage === 'commit' || f.stage === 'enter'),
    `伪报阶段应定位到提交/进入，实为 ${d.falseReports.map((f) => f.stage).join(',')}`);
  assert.equal(d.ok, false, '诊断整体应判失败');
});

test('负例·伪报：预约声称已进入但听闻段落缺失 → 记伪报', () => {
  // 让 doSwitch 把预约标进入，却不真正 push 段落。
  const d = withFault({
    doSwitch: (orig) => function () {
      const fake = { secId: null, startBeat: this.frontier };
      const segments = this.segments;
      const push = segments.push.bind(segments);
      segments.push = (x) => { fake.secId = x.secId; return segments.length; }; // 吞掉真实 push
      try { return orig.call(this); } finally { segments.push = push; }
    },
  }, () => diagnoseScenario(SCORE, SCEN));
  assert.ok(d.falseReports.length > 0, '应记录至少一条伪报');
  assert.equal(d.ok, false);
});

test('正例·健康运行不伪报（对照）', () => {
  const d = diagnoseScenario(SCORE, SCEN);
  assert.equal(d.falseReports.length, 0);
  assert.equal(d.deadlocks.length, 0);
  assert.equal(d.lostStates.length, 0);
  assert.equal(d.ok, true);
});
