// 曲谱与连接图体检：结构、乐理一致性、可达性报告。
import { parseChord, keysCompatible } from './theory.js';
import { barLen, phraseLen } from './score-data.js';
import { expandEdges, edgeKeyOk, reachableFrom } from './graph.js';

export function validateScore(score) {
  const errors = [];
  const warnings = [];
  const secs = score.sections;

  for (const sec of Object.values(secs)) {
    const bl = barLen(sec);
    if (!sec.phrases.length) errors.push(`${sec.id}: 没有乐句`);
    if (sec.pickupBeats < 0 || sec.pickupBeats > bl) {
      errors.push(`${sec.id}: 弱起长度 ${sec.pickupBeats} 超出小节`);
    }
    if (sec.pickup.length && sec.pickupBeats === 0) errors.push(`${sec.id}: 有弱起音符但弱起长度为 0`);
    for (const ev of sec.pickup) {
      if (ev.b < 0 || ev.b + ev.d > sec.pickupBeats) errors.push(`${sec.id}: 弱起音符越界`);
    }
    if (sec.kind === 'theme' && sec.prepareBeats < bl) {
      errors.push(`${sec.id}: 准备拍 ${sec.prepareBeats} 小于一小节，出口变体无法落位`);
    }
    if (sec.kind === 'theme' && !sec.phrases.some((p) => p.exitable)) {
      errors.push(`${sec.id}: 主题段没有可用出口`);
    }
    sec.phrases.forEach((ph, pi) => {
      const checkBar = (b, where) => {
        try { parseChord(b.chord); } catch (err) { errors.push(`${sec.id} ${where}: ${err.message}`); }
        for (const ev of b.events) {
          if (ev.b < 0 || ev.b >= bl) errors.push(`${sec.id} ${where}: 音符起拍 ${ev.b} 越界`);
          if (ev.d <= 0) errors.push(`${sec.id} ${where}: 音符时值非正`);
          if (ev.b + ev.d > bl) errors.push(`${sec.id} ${where}: 音符越过小节线（应使用延音标记）`);
          if (ev.tie && ev.tie <= 0) errors.push(`${sec.id} ${where}: 延音长度非正`);
        }
      };
      ph.bars.forEach((b, bi) => checkBar(b, `乐句${pi} 小节${bi}`));
      if (ph.exit) {
        const k = ph.exit.bars.length;
        if (k > ph.bars.length) errors.push(`${sec.id} 乐句${pi}: 出口变体长于乐句`);
        ph.exit.bars.forEach((b, bi) => checkBar(b, `乐句${pi} 出口变体${bi}`));
        for (const ev of ph.exit.tail || []) {
          if (ev.b < 0 || ev.d <= 0) errors.push(`${sec.id} 乐句${pi}: 尾部事件非法`);
        }
      }
      if (ph.exitable && sec.kind !== 'theme') errors.push(`${sec.id}: 非主题段不应声明出口`);
    });
  }

  for (const link of score.links) {
    if (!secs[link.from]) { errors.push(`连接起点不存在: ${link.from}`); continue; }
    if (!secs[link.to]) { errors.push(`连接终点不存在: ${link.to}`); continue; }
    if (link.via && !secs[link.via]) { errors.push(`过渡段不存在: ${link.via}`); continue; }
  }
  for (const edge of expandEdges(score)) {
    if (!edgeKeyOk(score, edge)) {
      errors.push(`声明的直接连接未通过调性检查: ${edge.from} -> ${edge.to}`);
    }
  }

  for (const [mood, ids] of Object.entries(score.moods)) {
    for (const id of ids) {
      if (!secs[id]) errors.push(`情境 ${mood} 引用不存在的段落 ${id}`);
    }
  }

  if (!secs[score.start]) errors.push(`起始段落不存在: ${score.start}`);
  else {
    const reach = reachableFrom(score, score.start);
    for (const sec of Object.values(secs)) {
      if (sec.id !== score.start && !reach.has(sec.id)) {
        warnings.push(`段落 ${sec.id} 从起始段不可达（无声明路径）`);
      }
    }
  }

  return { errors, warnings };
}
