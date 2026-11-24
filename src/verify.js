// 校验器：独立检查渲染结果——计划路径与听闻一致、接点和声、弱起/延音/尾部、拍号、时间不倒退。
import { parseChord, chordsCompatible, consonantWithChord, midiName } from './theory.js';
import { barLen } from './score-data.js';

const EPS = 1e-6;

export function verifyRender(score, result) {
  const v = [];
  const { events, harmony, segments, log, frontier } = result;

  for (const ev of events) {
    if (ev.t < -EPS) v.push(`事件时间倒退: ${ev.sec} ${ev.role} @${ev.t}`);
  }

  for (let i = 1; i < harmony.length; i++) {
    if (harmony[i].t < harmony[i - 1].t - EPS) v.push(`和声轨时间倒退 @${harmony[i].t}`);
    const gap = harmony[i].t - (harmony[i - 1].t + harmony[i - 1].d);
    if (Math.abs(gap) > 1e-3) v.push(`和声轨不连续 @${harmony[i].t}（间隙 ${gap}）`);
  }

  if (segments.length && Math.abs(segments[0].startBeat) > EPS) v.push('首段未从第 0 拍开始');
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].startBeat <= segments[i - 1].startBeat + EPS) {
      v.push(`段落起点未递增: ${segments[i].secId} @${segments[i].startBeat}`);
    }
  }

  for (const h of harmony) {
    const sec = score.sections[h.sec];
    if (Math.abs(h.d - barLen(sec)) > EPS) v.push(`小节长度与拍号不符: ${h.sec} @${h.t}`);
  }

  const harmonyAt = (t) => harmony.find((h) => t >= h.t - EPS && t < h.t + h.d - EPS);

  // 接点：最后一拍和声、弱起、越界延音/尾部
  for (let i = 1; i < segments.length; i++) {
    const E = segments[i].startBeat;
    const prev = segments[i - 1];
    const next = segments[i];
    const nextSec = score.sections[next.secId];
    const opening = parseChord(nextSec.phrases[0].bars[0].chord);
    const windowEnd = i + 1 < segments.length ? segments[i + 1].startBeat : Infinity;

    const hBefore = harmonyAt(E - 0.5);
    if (!hBefore) {
      v.push(`接点@第${E}拍: 最后一拍无和声记录`);
    } else {
      if (hBefore.sec !== prev.secId) v.push(`接点@第${E}拍: 最后一拍和声属于 ${hBefore.sec}，应为 ${prev.secId}`);
      const cadence = parseChord(hBefore.chord);
      if (!chordsCompatible(cadence, opening)) {
        v.push(`接点@第${E}拍: 终止和弦 ${cadence.name} 与 ${nextSec.title} 起始和弦 ${opening.name} 不兼容`);
      }
    }

    const pickups = events.filter((e) => e.sec === next.secId && e.role === 'pickup'
      && e.t >= E - nextSec.pickupBeats - EPS && e.t < E - EPS);
    if (pickups.length !== (nextSec.pickup || []).length) {
      v.push(`接点@第${E}拍: 弱起音符数量 ${pickups.length} 与谱面 ${(nextSec.pickup || []).length} 不符`);
    }
    for (const ev of pickups) {
      const h = harmonyAt(ev.t + 1e-3);
      const pc = ev.p % 12;
      const ok = (h && consonantWithChord(pc, parseChord(h.chord))) || consonantWithChord(pc, opening);
      if (!ok) v.push(`接点@第${E}拍: 弱起 ${midiName(ev.p)} 与实际发声和声及目标和声均不合`);
    }

    // 越界：跨界延音必须声明且长度受控；尾部必须在接点后的本段窗口内
    const crossing = events.filter((e) => e.sec === prev.secId
      && e.t >= prev.startBeat - EPS && e.t < E - EPS && e.t + e.d > E + EPS);
    for (const ev of crossing) {
      if (!(ev.tie && ev.t + ev.d <= E + ev.tie + EPS)) {
        v.push(`接点@第${E}拍: ${prev.secId} 事件 @${ev.t} 越界且未声明延音（被截断？）`);
        continue;
      }
      if (!consonantWithChord(ev.p % 12, opening)) {
        v.push(`接点@第${E}拍: 延音 ${midiName(ev.p)} 与进入和声 ${opening.name} 不合`);
      }
    }
    const tails = events.filter((e) => e.sec === prev.secId && e.role === 'tail' && e.t >= E - EPS && e.t < windowEnd - EPS);
    for (const ev of tails) {
      if (!consonantWithChord(ev.p % 12, opening)) {
        v.push(`接点@第${E}拍: 尾部 ${midiName(ev.p)} 与进入和声 ${opening.name} 不合`);
      }
    }
  }

  // 每个弱起事件都必须落在某个接点窗口内
  for (const ev of events.filter((e) => e.role === 'pickup')) {
    const sec = score.sections[ev.sec];
    const ok = segments.some((s) => s.secId === ev.sec && s.startBeat > 0
      && ev.t >= s.startBeat - sec.pickupBeats - EPS && ev.t < s.startBeat - EPS);
    if (!ok) v.push(`弱起事件不在任何接点窗口内: ${ev.sec} @${ev.t}`);
  }

  // 计划路径与听闻一致（被抢占的计划除外；超出渲染时长的待定计划除外）
  const preempted = new Set(log.filter((l) => l.type === 'preempt').map((l) => l.data?.oldPlanId));
  const plans = log.filter((l) => l.type === 'plan').map((l) => l.data.plan)
    .filter((p) => !preempted.has(p.id) && p.exitBeat <= frontier + EPS);
  for (const p of plans) {
    const idx = segments.findIndex((s) => Math.abs(s.startBeat - p.exitBeat) < 1e-6);
    if (idx < 0) { v.push(`计划#${p.id} 的出口 第${p.exitBeat}拍 未在听闻中出现`); continue; }
    for (let k = 0; k < p.path.length; k++) {
      const seg = segments[idx + k];
      if (!seg || seg.secId !== p.path[k]) {
        v.push(`计划#${p.id} 路径第 ${k + 1} 段应为 ${p.path[k]}，听闻为 ${seg ? seg.secId : '（无）'}`);
        break;
      }
    }
  }

  return v;
}
