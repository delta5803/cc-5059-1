// 连接图：声明边 + 乐理检查。路径最多经过一个过渡段，不允许主题段做中转。
import { keysCompatible } from './theory.js';

// 展开为可通行的有向边 [{from, to}]，via 拆成两段。
export function expandEdges(score) {
  const edges = [];
  for (const link of score.links) {
    const from = score.sections[link.from];
    const to = score.sections[link.to];
    if (!from || !to) throw new Error(`连接引用不存在的段落: ${link.from} -> ${link.to}`);
    if (link.via) {
      const via = score.sections[link.via];
      if (!via || via.kind !== 'transition') throw new Error(`过渡段不存在或类型错误: ${link.via}`);
      edges.push({ from: link.from, to: link.via, via: link });
      edges.push({ from: link.via, to: link.to, via: link });
    } else {
      edges.push({ from: link.from, to: link.to, via: null });
    }
  }
  return edges;
}

// 单条边的调性可行性（和声细节在调度时按具体出口再查）。
export function edgeKeyOk(score, edge) {
  const from = score.sections[edge.from];
  const to = score.sections[edge.to];
  if (to.kind === 'transition') return keysCompatible(from.key, to.key);
  if (from.kind === 'transition') return keysCompatible(from.toKey, to.key);
  return keysCompatible(from.key, to.key);
}

export function neighbors(score, edges, secId) {
  return edges
    .filter((e) => e.from === secId && edgeKeyOk(score, e))
    .map((e) => e.to);
}

// BFS：主题段只作为起点与终点，过渡段不可成链。
export function findPath(score, fromId, toId) {
  if (fromId === toId) return null;
  const edges = expandEdges(score);
  const prev = new Map([[fromId, null]]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === toId) {
      const path = [];
      for (let n = toId; n !== null; n = prev.get(n)) path.unshift(n);
      path.shift();
      return path;
    }
    const curSec = score.sections[cur];
    const isIntermediateTheme = cur !== fromId && curSec.kind === 'theme';
    if (isIntermediateTheme) continue;
    for (const next of neighbors(score, edges, cur)) {
      if (!prev.has(next)) {
        prev.set(next, cur);
        queue.push(next);
      }
    }
  }
  return null;
}

// 会话可达性：主题段是枢纽（到达后可再发起新过渡），过渡段通向其目标段。
// 与 findPath 的单次路径语义不同：这里回答"该段是否可能出现在某次演奏中"。
export function reachableFrom(score, fromId) {
  const edges = expandEdges(score);
  const seen = new Set([fromId]);
  const queue = [fromId];
  while (queue.length) {
    const cur = queue.shift();
    const curSec = score.sections[cur];
    if (curSec.kind === 'ending') continue;
    for (const next of neighbors(score, edges, cur)) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  seen.delete(fromId);
  return seen;
}
