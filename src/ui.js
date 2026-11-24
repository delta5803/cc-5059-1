// 编曲试听台：现场调度 + 段落试听 + 结果区渲染。所有节奏与配乐均来自引擎实际运算。
import { SCORE, loopLen } from './score-data.js';
import { Engine } from './scheduler.js';
import { renderScenario, renderSectionAudition, renderPickupVariants, scoreExport } from './render.js';
import { diagnoseScenario, summarizeDiagnosis } from './diagnosis.js';
import { DEMO_SCENARIO, BOUNDARY_SCENARIO } from './scenarios.js';
import { Player } from './player.js';
import { validateScore } from './validate.js';
import { expandEdges, edgeKeyOk } from './graph.js';
import { keyName, midiName } from './theory.js';
import { RES } from './reservation.js';

const MOOD_LABELS = { calm: '宁静', tense: '紧张', heroic: '昂扬', drift: '游离', end: '收束' };
const KIND_LABELS = { theme: '主题', transition: '过渡', ending: '收束' };
const SEC_IDS = Object.keys(SCORE.sections);
const SEC_COLORS = new Map(SEC_IDS.map((id, i) => [id, `hsl(${(i * 67) % 360} 55% 55%)`]));

const $ = (id) => document.getElementById(id);
const player = new Player();

const state = {
  live: null,
  scenario: { start: SCORE.start, until: 164, requests: [] },
  render: null,
  diag: null,
  selected: null,
  resplice: 'legacy',
  lastAudition: null,
};

// ---------- 钢琴卷帘 ----------
function drawRoll(canvas, events, harmony, segments, opts = {}) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (!events.length) return;
  const t0 = opts.t0 ?? 0;
  const t1 = opts.t1 ?? Math.max(...events.map((e) => e.t + e.d), 1);
  let lo = Math.min(...events.map((e) => e.p)) - 2;
  let hi = Math.max(...events.map((e) => e.p)) + 2;
  if (hi - lo < 12) { const m = (hi + lo) / 2; lo = m - 6; hi = m + 6; }
  const x = (t) => ((t - t0) / (t1 - t0)) * W;
  const y = (p) => H - ((p - lo) / (hi - lo)) * H;

  for (const s of segments || []) {
    if (s.startBeat < t0 || s.startBeat > t1) continue;
    ctx.strokeStyle = '#3a415a';
    ctx.beginPath();
    ctx.moveTo(x(s.startBeat), 0);
    ctx.lineTo(x(s.startBeat), H);
    ctx.stroke();
    ctx.fillStyle = '#8b93a7';
    ctx.font = '10px sans-serif';
    ctx.fillText(SCORE.sections[s.secId].title, x(s.startBeat) + 3, 11);
  }
  for (const h of harmony || []) {
    if (h.t + h.d < t0 || h.t > t1) continue;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    ctx.moveTo(x(h.t), 0);
    ctx.lineTo(x(h.t), H);
    ctx.stroke();
    ctx.fillStyle = 'rgba(139,147,167,0.6)';
    ctx.font = '9px sans-serif';
    ctx.fillText(h.chord, x(h.t) + 2, H - 4);
  }
  for (const ev of events) {
    if (ev.t + ev.d < t0 || ev.t > t1) continue;
    ctx.fillStyle = SEC_COLORS.get(ev.sec) || '#999';
    ctx.globalAlpha = ev.role === 'pickup' ? 0.65 : ev.role === 'tail' ? 0.5 : 0.95;
    const w = Math.max(1.5, x(ev.t + ev.d) - x(ev.t) - 0.6);
    ctx.fillRect(x(ev.t), y(ev.p) - 3, w, 6);
    ctx.globalAlpha = 1;
  }
  if (opts.cursor !== undefined) {
    ctx.strokeStyle = '#d8a657';
    ctx.beginPath();
    ctx.moveTo(x(opts.cursor), 0);
    ctx.lineTo(x(opts.cursor), H);
    ctx.stroke();
  }
}

// ---------- 段落编曲面板 ----------
function renderSectionCards() {
  const host = $('section-list');
  host.innerHTML = '';
  for (const sec of Object.values(SCORE.sections)) {
    const card = document.createElement('div');
    card.className = 'card' + (state.selected === sec.id ? ' selected' : '');
    card.innerHTML = `<div class="title">${sec.title}<span class="badge ${sec.kind}">${KIND_LABELS[sec.kind]}</span></div>
      <div class="meta">${keyName(sec.key)} · ${sec.meter.num}/${sec.meter.den} · ♩=${sec.tempo} · 弱起${sec.pickupBeats}拍 · 准备${sec.prepareBeats}拍</div>
      <div class="meta">${sec.phrases.length} 个乐句 · 循环 ${loopLen(sec)} 拍${sec.mood ? ` · 情绪「${MOOD_LABELS[sec.mood]}」` : ''}</div>`;
    card.onclick = () => selectSection(sec.id);
    host.appendChild(card);
  }
}

function selectSection(secId) {
  state.selected = secId;
  renderSectionCards();
  const sec = SCORE.sections[secId];
  $('section-detail').classList.remove('hidden');
  $('section-detail-title').textContent = `${sec.title} — 乐句（一遍循环的实际渲染）`;
  const r = renderSectionAudition(SCORE, secId);
  drawRoll($('section-roll'), r.events, r.harmony, r.segments);
}

// ---------- 情境按钮 ----------
function renderMoodButtons() {
  const host = $('mood-buttons');
  host.innerHTML = '';
  for (const [mood, label] of Object.entries(MOOD_LABELS)) {
    const b = document.createElement('button');
    b.className = 'mood';
    b.textContent = label;
    b.onclick = () => requestMood(mood);
    host.appendChild(b);
  }
}

function requestMood(mood) {
  const live = state.live;
  if (!live) {
    flashLog(`未在现场播放：请先「开始现场」，或在结果区载入/编辑情境后渲染`);
    return;
  }
  const beat = live.eng.beatAtSec(player.ctx.currentTime - live.t0);
  const res = live.eng.requestContext(mood, Math.max(0, beat));
  state.scenario.requests.push({ t: Math.round(beat * 4) / 4, mood });
  state.scenario.until = Math.ceil(live.eng.frontier) + 16;
  updateScenarioView();
  if (res.type === 'exception') flashLog(`异常：${res.error || '请求被拒绝'}`);
}

// ---------- 现场 ----------
function startLive() {
  player.ensure();
  const eng = new Engine(SCORE, { start: state.scenario.start || SCORE.start, resplice: state.resplice });
  const t0 = player.ctx.currentTime + 0.1;
  state.scenario = { start: eng.cur.secId, until: 160, requests: [] };
  state.live = { eng, t0, timer: null };
  state.live.timer = setInterval(tick, 40);
  $('btn-live').disabled = true;
  $('btn-stop').disabled = false;
  updateScenarioView();
}

function stopLive() {
  if (!state.live) return;
  clearInterval(state.live.timer);
  player.stopAll();
  state.scenario.until = Math.ceil(state.live.eng.frontier) + 4;
  state.live = null;
  $('btn-live').disabled = false;
  $('btn-stop').disabled = true;
  updateScenarioView();
}

function tick() {
  const live = state.live;
  if (!live) return;
  const elapsed = player.ctx.currentTime - live.t0;
  const horizonBeat = live.eng.beatAtSec(Math.max(0, elapsed) + 0.45);
  const emitted = live.eng.advanceTo(horizonBeat);
  for (const ev of emitted) {
    const when = live.t0 + ev.ts;
    if (when > player.ctx.currentTime - 0.05) player.scheduleEvent(ev, Math.max(when, player.ctx.currentTime));
  }
  updateStatusPanels();
}

// ---------- 状态面板 ----------
function fmtPlan(p) {
  return `出口 第${p.exitBeat}拍 → ${p.path.map((id) => SCORE.sections[id].title).join(' → ')}（锁定点 第${p.lockBeat}拍）`;
}

const RES_LABELS = {
  deferred: '延后等待', reserved: '已预约', lead_granted: '提前量已授',
  splice_queued: '拼接就绪', committed: '已提交', entering: '过渡中', entered: '已进入',
  superseded: '已被取代', cancelled: '已取消', conflict: '规则冲突', lost: '状态丢失',
};

function renderLiveTransition(eng) {
  const res = eng.book.list.slice(-6).reverse();
  if (!res.length) { $('live-transition').innerHTML = '<span class="dim">（暂无预约）</span>'; return; }
  $('live-transition').innerHTML = res.map((r) => {
    const tgt = r.targetId ? SCORE.sections[r.targetId].title : '—';
    const bits = [`请求#${r.reqId} ${MOOD_LABELS[r.mood] || r.mood}`, `→ ${tgt}`, RES_LABELS[r.state] || r.state];
    if (r.exitBeat !== null) bits.push(`出口${r.exitBeat}`);
    if (r.grantedLead !== null) bits.push(`提前量${r.grantedLead}/${r.requiredLead}`);
    if (r.enteredBeat !== null) bits.push(`进入@${r.enteredBeat}`);
    return escapeHtml(bits.join(' · '));
  }).join('\n');
}

function updateStatusPanels() {
  const live = state.live;
  if (!live) return;
  const { eng } = live;
  const sec = eng.sec(eng.cur.secId);
  $('clock').textContent = `调度前沿 第${eng.frontier.toFixed(0)}拍 · ${sec.title}${eng.done ? '（已收束）' : ''}`;
  $('now-phrase').textContent =
    `${sec.title} · 乐句 ${eng.cur.phraseIdx + 1}/${sec.phrases.length} · 小节 ${eng.cur.barIdx + 1} · 循环 ${eng.cur.loops + 1}`;
  const pend = [];
  if (eng.plan) pend.push(`▶ ${fmtPlan(eng.plan)}`);
  const preview = eng.previewExits();
  for (const [mood, r] of Object.entries(preview)) {
    if (eng.plan && eng.plan.targetMood === mood) continue;
    pend.push(r.plan ? `${MOOD_LABELS[mood]}：最早出口 第${r.plan.exitBeat}拍` : `${MOOD_LABELS[mood]}：${r.error}`);
  }
  $('pending-exits').innerHTML = pend.length ? pend.map(escapeHtml).join('\n') : '—';
  $('queue').textContent = eng.queue.length ? eng.queue.map((q) => MOOD_LABELS[q.mood]).join('、') : '—';
  const evs = eng.events.slice(-12).reverse()
    .map((e) => `第${String(e.t.toFixed(1)).padStart(6)}拍 ${midiName(e.p)}  ${String(e.d.toFixed(1)).padStart(4)}拍  ${e.sec} · ${e.role}`);
  $('events').innerHTML = evs.map(escapeHtml).join('\n') || '—';
  renderLiveTransition(eng);
  const win = { t0: Math.max(0, eng.frontier - 18), t1: eng.frontier + 6 };
  drawRoll($('live-roll'), eng.events, eng.harmony, eng.segments, win);
  const logs = eng.log.slice(-14).reverse().map((l) => `[${l.t}] ${l.type}  ${l.msg}`);
  $('live-log').innerHTML = logs.map(escapeHtml).join('\n');
}

function flashLog(msg) {
  const el = $('live-log');
  el.innerHTML = `${escapeHtml(msg)}\n` + el.innerHTML;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// ---------- 结果区 ----------
function updateScenarioView() {
  const s = state.scenario;
  const reqs = [...s.requests].sort((a, b) => a.t - b.t)
    .map((r) => `第${r.t}拍→${MOOD_LABELS[r.mood] || r.mood}`).join('，');
  $('scenario-view').textContent = `起始 ${s.start} · 时长 ${s.until} 拍 · ${s.requests.length} 个请求${reqs ? `：${reqs}` : ''}`;
  renderProbeOptions();
}

function renderProbeOptions() {
  const sel = $('probe-req');
  const s = state.scenario;
  const prev = sel.value;
  sel.innerHTML = '';
  [...s.requests].sort((a, b) => a.t - b.t).forEach((r, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `第${r.t}拍→${MOOD_LABELS[r.mood] || r.mood}`;
    sel.appendChild(o);
  });
  if (prev && sel.options[Number(prev)]) sel.value = prev;
}

function outcomeClass(o) {
  if (o === 'entered' || o === 'equivalent') return 'ok';
  if (o === 'legal_wait' || o === 'truncated') return 'warn';
  if (o === 'deadlock' || o === 'state_loss' || o === 'conflict' || o === 'rule_conflict') return 'bad';
  return 'dim';
}

const OUTCOME_LABELS = {
  entered: '已进入', legal_wait: '合法等待', deadlock: '死锁', state_loss: '状态丢失',
  conflict: '规则冲突', rule_conflict: '规则冲突', superseded: '被取代', ended: '已收束',
  pending: '待定', in_progress: '进行中', truncated: '运行截断（未见进入）', equivalent: '两策略一致',
};

function renderDiagnosis(diag) {
  const host = $('diag');
  if (!diag) { host.innerHTML = '<span class="dim">（尚未诊断）</span>'; return; }
  const title = (id) => (SCORE.sections[id] ? SCORE.sections[id].title : id);
  const lines = [];
  const head = diag.ok
    ? `<span class="ok">✓ 证据可复跑一致（${diag.evidenceHash}）· 无伪报 · 无状态丢失 · 校验通过</span>`
    : `<span class="bad">✗ 诊断发现问题：复跑${diag.reproducible ? '一致' : '不一致'}、伪报 ${diag.falseReports.length}、状态丢失 ${diag.lostStates.length}、违规 ${diag.violations.length}</span>`;
  lines.push(head);
  lines.push(`<span class="dim">追踪 ${diag.logCost.traceEntries} 条（消去冗余 ${diag.redundant.removed}，逐出 ${diag.logCost.evicted}，上限 ${diag.logCost.max}）· 事件 ${diag.logCost.eventCount} · 诊断 ${diag.logCost.diagnosticMs}ms / 复跑 ${diag.logCost.rerunMs}ms</span>`);
  lines.push('<table class="joins"><tr><th>请求</th><th>目标</th><th>结论</th><th>阶段</th><th>状态 / 实际弱起</th><th>原因</th></tr>');
  for (const r of diag.requests) {
    const pk = r.noteEvidence ? `${r.noteEvidence.actualPickup}/${r.noteEvidence.expectedPickup} 音` : '—';
    lines.push(`<tr><td>#${r.reqId} 第${r.t}拍<br>${MOOD_LABELS[r.mood] || r.mood}</td>`
      + `<td>${r.targetId ? title(r.targetId) : '—'}</td>`
      + `<td class="${outcomeClass(r.outcome)}">${OUTCOME_LABELS[r.outcome] || r.outcome}</td>`
      + `<td>${r.stage}</td>`
      + `<td>${RES_LABELS[r.state] || r.state}<br><span class="dim">弱起 ${pk}</span></td>`
      + `<td>${escapeHtml(r.reason)}${r.probe ? `<br><span class="dim">边界前后：前=${r.probe.earlier.entered ? '进入' : '未进'} 后=${r.probe.later.entered ? '进入' : '未进'}</span>` : ''}</td></tr>`);
  }
  lines.push('</table>');
  if (diag.replay.length) {
    lines.push('<h3>迟到请求回放（延后 vs 立即重排）</h3>');
    lines.push('<table class="joins"><tr><th>请求</th><th>legacy（延后）</th><th>immediate（立即重排）</th><th>判定</th></tr>');
    for (const p of diag.replay) {
      lines.push(`<tr><td>#${p.reqId} ${MOOD_LABELS[p.mood] || p.mood} → ${p.targetTitle || '—'}<br><span class="dim">第${p.atT}拍：${escapeHtml(p.reason)}</span></td>`
        + `<td>${p.legacy.entered ? `进入@${p.legacy.entryBeat}` : RES_LABELS[p.legacy.state] || p.legacy.state}</td>`
        + `<td>${p.immediate.entered ? `进入@${p.immediate.entryBeat}` : RES_LABELS[p.immediate.state] || p.immediate.state}</td>`
        + `<td class="${outcomeClass(p.verdict)}">${OUTCOME_LABELS[p.verdict] || p.verdict}</td></tr>`);
    }
    lines.push('</table>');
  }
  lines.push(`<p class="hint">两份乐谱：完整弱起 ${diag.variants.pickupNotes} 弱起音 / ${diag.variants.totalNotes} 事件；`
    + `省略弱起 ${diag.variants.omitPickupNotes} 弱起音 / ${diag.variants.omitTotalNotes} 事件</p>`);
  host.innerHTML = lines.join('\n');
}

function renderResult() {
  state.render = renderScenario(SCORE, state.scenario, { resplice: state.resplice });
  state.diag = diagnoseScenario(SCORE, state.scenario, { resplice: state.resplice });
  const r = state.render;

  const preempted = new Set(r.log.filter((l) => l.type === 'preempt').map((l) => l.data?.oldPlanId));
  const plans = r.log.filter((l) => l.type === 'plan').map((l) => ({ ...l.data.plan, preempted: preempted.has(l.data.plan.id) }));
  let html = '<table class="joins"><tr><th>计划</th><th>路径</th><th>出口 / 提前量</th><th>接点检查（实际运算）</th><th>状态</th></tr>';
  for (const p of plans) {
    const joins = p.joins.map((j) => {
      const checks = j.checks.map((c) => `<span class="${c.ok ? 'ok' : 'bad'}">${c.ok ? '✓' : '✗'}${c.name}${c.detail ? ` ${c.detail}` : ''}</span>`).join('<br>');
      return `<b>${SCORE.sections[j.from].title} → ${SCORE.sections[j.to].title}</b><br>${checks}`;
    }).join('<hr style="border-color:#333949">');
    html += `<tr><td>#${p.id}</td><td>${p.path.map((id) => SCORE.sections[id].title).join(' → ')}</td>`
      + `<td>第${p.exitBeat}拍<br><span class="dim">锁定 第${p.lockBeat}拍 · 提前量 ${p.grantedLead ?? '—'}/${p.requiredLead ?? '—'}</span></td><td>${joins}</td>`
      + `<td class="${p.preempted ? 'warn' : 'ok'}">${p.preempted ? '被抢占' : '已执行'}</td></tr>`;
  }
  html += '</table>';
  const heard = r.segments.map((s) => `${s.startBeat}拍·${SCORE.sections[s.secId].title}`).join(' → ');
  $('joins').innerHTML = (plans.length ? html : '<span class="dim">（无过渡计划）</span>')
    + `<p class="hint">听闻路径：${escapeHtml(heard)}</p>`;

  renderDiagnosis(state.diag);

  drawRoll($('result-roll'), r.events, r.harmony, r.segments);

  $('verify').innerHTML = r.violations.length
    ? r.violations.map((v) => `<span class="bad">✗ ${escapeHtml(v)}</span>`).join('\n')
    : `<span class="ok">✓ 通过：计划路径与听闻一致；接点和声 / 弱起 / 延音 / 尾部 / 拍号 / 时间序均合法（${r.events.length} 个事件）</span>`;

  const exs = r.log.filter((l) => l.type === 'exception');
  $('exceptions').innerHTML = exs.length
    ? exs.map((l) => `<span class="bad">[第${l.t}拍] ${escapeHtml(l.msg)}</span>`).join('\n')
    : '<span class="dim">（无异常）</span>';
}

// ---------- 连接图 ----------
function renderGraph() {
  const { errors, warnings } = validateScore(SCORE);
  const lines = [];
  for (const e of expandEdges(SCORE)) {
    const ok = edgeKeyOk(SCORE, e);
    const decl = e.via ? `（声明 ${e.via.from}→${e.via.to}${e.via.via ? `，经 ${e.via.via}` : ''}）` : '（直接）';
    lines.push(`<span class="${ok ? 'ok' : 'bad'}">${ok ? '可行' : '不可行'}</span>  ${e.from} → ${e.to} ${decl}`);
  }
  for (const w of warnings) lines.push(`<span class="warn">警告</span>  ${escapeHtml(w)}`);
  for (const e of errors) lines.push(`<span class="bad">错误</span>  ${escapeHtml(e)}`);
  $('links').innerHTML = lines.join('\n');
}

// ---------- 调试回放 ----------
function probeRequest(delta) {
  const s = state.scenario;
  const idx = Number($('probe-req').value);
  const sorted = [...s.requests].sort((a, b) => a.t - b.t);
  const target = sorted[idx];
  if (!target) { flashLog('没有可改的请求：请先载入示例情境'); return; }
  const orig = s.requests.find((r) => r === target);
  if (orig) orig.t = Math.max(0, Math.round((orig.t + delta) * 4) / 4);
  state.scenario.requests = s.requests;
  updateScenarioView();
  renderResult();
  flashLog(`边界前后改请求：第${target.t}拍 → ${MOOD_LABELS[target.mood] || target.mood}（${delta > 0 ? '推后' : '提前'} 4 拍）`);
}

// 切换情绪并播放乐句：用内核渲染「当前段 → 新情绪」并显示过渡节奏与实际配乐。
function moodAudition() {
  const mood = $('mood-switch').value;
  const startId = state.render && state.render.segments.length
    ? state.render.segments[0].secId
    : (state.scenario.start || SCORE.start);
  const until = loopLen(SCORE.sections[startId]) * 2 + 24;
  const scen = { start: startId, until, requests: [{ t: 1, mood }] };
  const r = renderScenario(SCORE, scen, { resplice: state.resplice });
  const diag = diagnoseScenario(SCORE, scen, { resplice: state.resplice });
  state.lastAudition = { scen, r, diag };
  state.scenario = scen;
  state.render = r;
  state.diag = diag;
  updateScenarioView();

  const segs = r.segments.map((x) => `${x.startBeat}拍·${SCORE.sections[x.secId].title}`).join(' → ');
  const entered = diag.requests.find((q) => q.mood === mood);
  const reason = entered ? entered.reason : '无可用过渡';
  const outcome = entered ? (OUTCOME_LABELS[entered.outcome] || entered.outcome) : '未进入';
  const pk = entered && entered.noteEvidence ? entered.noteEvidence.actualPickup : 0;
  $('joins').innerHTML = `<p class="hint">切换「${MOOD_LABELS[mood] || mood}」→ ${escapeHtml(segs)}</p>`
    + `<p class="${entered && entered.outcome === 'entered' ? 'ok' : 'warn'}">过渡节奏：${outcome} · 实际弱起 ${pk} 音</p>`
    + `<p class="dim">原因：${escapeHtml(reason)}</p>`;
  renderDiagnosis(diag);
  drawRoll($('result-roll'), r.events, r.harmony, r.segments);
  $('verify').innerHTML = r.violations.length
    ? r.violations.map((v) => `<span class="bad">✗ ${escapeHtml(v)}</span>`).join('\n')
    : `<span class="ok">✓ 通过（${r.events.length} 个事件）</span>`;
  $('exceptions').innerHTML = '<span class="dim">（试听模式）</span>';
  player.playEvents(r.events, 0.1);
}

function exportScore(mode) {
  const v = renderPickupVariants(SCORE, state.scenario, { resplice: state.resplice });
  const res = mode === 'omit' ? v.omit : v.full;
  const data = scoreExport(SCORE, res, mode === 'omit' ? '省略弱起' : '完整弱起');
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = mode === 'omit' ? 'score-omit-pickup.json' : 'score-full-pickup.json';
  a.click();
  URL.revokeObjectURL(a.href);
  flashLog(`导出乐谱（${mode === 'omit' ? '省略弱起' : '完整弱起'}）：${data.pickupCount} 弱起音 / ${data.noteCount} 事件 / 违规 ${data.violations.length}`);
}

// ---------- 事件绑定 ----------
function init() {
  renderSectionCards();
  renderMoodButtons();
  renderGraph();
  updateScenarioView();

  for (const [mood, label] of Object.entries(MOOD_LABELS)) {
    const o = document.createElement('option');
    o.value = mood;
    o.textContent = label;
    $('mood-switch').appendChild(o);
  }

  $('btn-live').onclick = startLive;
  $('btn-stop').onclick = stopLive;
  $('resplice-mode').onchange = (ev) => {
    state.resplice = ev.target.value;
    flashLog(`迟到请求策略：${ev.target.value === 'immediate' ? '立即取消未发声拼接重排' : '延后到下一乐句接管'}`);
    if (state.render) renderResult();
  };
  $('btn-audition').onclick = () => {
    if (!state.selected) return;
    const r = renderSectionAudition(SCORE, state.selected);
    player.playEvents(r.events, 0.1);
  };
  $('btn-render').onclick = renderResult;
  $('btn-replay').onclick = () => {
    if (state.render) player.playEvents(state.render.events, 0.15);
  };
  $('btn-demo').onclick = () => {
    state.scenario = JSON.parse(JSON.stringify(DEMO_SCENARIO));
    updateScenarioView();
    renderResult();
  };
  $('btn-boundary').onclick = () => {
    state.scenario = JSON.parse(JSON.stringify(BOUNDARY_SCENARIO));
    updateScenarioView();
    renderResult();
  };
  $('btn-probe-earlier').onclick = () => probeRequest(-4);
  $('btn-probe-later').onclick = () => probeRequest(4);
  $('btn-mood-audition').onclick = moodAudition;
  $('btn-score-full').onclick = () => exportScore('full');
  $('btn-score-omit').onclick = () => exportScore('omit');
  $('btn-export').onclick = () => {
    const blob = new Blob([JSON.stringify(state.scenario, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'scenario.json';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('file-import').onchange = async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const s = JSON.parse(await file.text());
      if (!Array.isArray(s.requests)) throw new Error('缺少 requests 数组');
      state.scenario = { start: s.start || SCORE.start, until: s.until || 128, requests: s.requests };
      updateScenarioView();
      renderResult();
    } catch (err) {
      flashLog(`导入失败：${err.message}`);
    }
    ev.target.value = '';
  };
}

if (typeof document !== 'undefined') init();
