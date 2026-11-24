// 界面冒烟测试：用 jsdom 加载真实 index.html + src/ui.js（桩掉 canvas/WebAudio），
// 触发真实按钮与下拉，断言结果区由段落配乐内核驱动展示过渡节奏与实际音符、诊断证据。
// 若未安装 jsdom（devDependency），跳过且不判失败。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let JSDOM = null;
let VirtualConsole = null;
try {
  const mod = await import('jsdom');
  JSDOM = mod.JSDOM;
  VirtualConsole = mod.VirtualConsole;
} catch {
  JSDOM = null;
}

test('界面：由内核驱动展示过渡节奏、实际音符与诊断（jsdom）', { skip: !JSDOM && '未安装 jsdom（npm i -D jsdom）' }, async () => {
  const html = readFileSync(`${ROOT}/index.html`, 'utf8');
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/not implemented/i.test(e.message)) errors.push(e.message); });

  const dom = new JSDOM(html, {
    url: pathToFileURL(`${ROOT}/index.html`).href,
    runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc,
  });
  const { window } = dom;

  const noop = () => {};
  const ctxStub = new Proxy({}, {
    get: (t, p) => (p === 'canvas' ? { width: 800, height: 200 } : noop),
    set: () => true,
  });
  window.HTMLCanvasElement.prototype.getContext = () => ctxStub;

  class FakeParam { setValueAtTime() {} linearRampToValueAtTime() {} setTargetAtTime() {} }
  window.AudioContext = class {
    constructor() { this.currentTime = 0; this.state = 'running'; this.destination = { connect() {} }; }
    resume() {}
    createGain() { return { gain: new FakeParam(), connect() {} }; }
    createOscillator() { return { type: 'sine', frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
  };

  const created = [];
  const realCreate = window.document.createElement.bind(window.document);
  window.document.createElement = (tag) => {
    const el = realCreate(tag);
    if (tag === 'a') el.click = () => created.push(el.download);
    return el;
  };
  window.URL.createObjectURL = () => 'blob:stub';
  window.URL.revokeObjectURL = noop;

  for (const k of ['window', 'document', 'HTMLElement', 'HTMLCanvasElement', 'Blob', 'URL',
    'requestAnimationFrame', 'AudioContext', 'webkitAudioContext']) {
    if (window[k] !== undefined) {
      try { globalThis[k] = window[k]; } catch { Object.defineProperty(globalThis, k, { value: window[k], configurable: true }); }
    }
  }

  await import(pathToFileURL(`${ROOT}/src/ui.js`).href);
  await new Promise((r) => setTimeout(r, 30));
  const $ = (id) => window.document.getElementById(id);

  assert.ok($('section-list').children.length > 0, '段落卡片应渲染');
  assert.ok($('links').textContent.trim().length > 0, '连接图应渲染');

  // 示例情境：诊断与过渡节奏由内核运算得出
  $('btn-demo').dispatchEvent(new window.Event('click'));
  assert.ok($('diag').querySelector('table'), '诊断表应出现');
  assert.match($('diag').textContent, /证据可复跑一致/, '诊断应显示可复跑一致');
  assert.match($('diag').textContent, /弱起 \d+\/\d+ 音/, '应显示实际弱起音符数');
  assert.ok($('joins').querySelector('table'), '过渡节奏表应出现');
  assert.match($('verify').textContent, /✓ 通过/);

  // 边界示例：迟到请求回放
  $('btn-boundary').dispatchEvent(new window.Event('click'));
  assert.match($('diag').textContent, /迟到请求回放/);
  assert.match($('diag').textContent, /合法等待|已进入/);

  // 策略切换后重算
  $('resplice-mode').value = 'immediate';
  $('resplice-mode').dispatchEvent(new window.Event('change'));
  assert.match($('diag').textContent, /已进入|合法等待/);

  // 边界前后改请求
  const before = $('scenario-view').textContent;
  $('btn-probe-later').dispatchEvent(new window.Event('click'));
  assert.notEqual($('scenario-view').textContent, before, '改请求后情境序列应变化');
  assert.ok($('diag').querySelector('table'), '改请求后诊断应重算');

  // 切换情绪并播放乐句：显示过渡节奏与实际配乐
  $('mood-switch').value = 'heroic';
  $('btn-mood-audition').dispatchEvent(new window.Event('click'));
  assert.match($('joins').textContent, /过渡节奏/);
  assert.match($('verify').textContent, /✓ 通过/);
  assert.match($('diag').textContent, /[0-9a-f]{8}/);

  // 双份乐谱导出
  $('btn-score-full').dispatchEvent(new window.Event('click'));
  $('btn-score-omit').dispatchEvent(new window.Event('click'));
  assert.ok(created.includes('score-full-pickup.json'));
  assert.ok(created.includes('score-omit-pickup.json'));

  // 现场：过渡追踪面板来自内核
  $('btn-live').dispatchEvent(new window.Event('click'));
  await new Promise((r) => setTimeout(r, 120));
  assert.match($('clock').textContent, /调度前沿/);
  assert.ok($('live-transition').textContent.trim().length > 0);
  $('btn-stop').dispatchEvent(new window.Event('click'));

  assert.deepEqual(errors, [], '不应有未捕获的界面脚本错误');
});
