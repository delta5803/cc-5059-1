// 过渡追踪：记录情境请求 / 乐句边界 / 实际音符提交的阶段证据。
// 追踪日志是有界的（默认 256 条），并对连续同构事件做冗余合并；完整状态链见 reservation。
export const PHASE = {
  REQUEST: 'request',
  DECIDE: 'decide',
  LEAD: 'lead',
  DEFER: 'defer',
  REVOKE: 'revoke',
  SPLICE: 'splice',
  COMMIT: 'commit',
  ENTER: 'enter',
  REJECT: 'reject',
  END: 'end',
};

const keyOf = (e) => [
  e.phase, e.reqId ?? '', e.mood ?? '', e.secId ?? '', e.state ?? '', e.reason ?? '',
].join('|');

export class Trace {
  constructor({ max = 256 } = {}) {
    this.max = max;
    this.entries = [];
    this.evicted = 0;
    this.seq = 0;
    this._lastKey = null;
  }

  push(entry) {
    const key = keyOf(entry);
    const last = this.entries[this.entries.length - 1];
    if (last && key === this._lastKey) {
      last.count += 1; // 消去冗余事件：连续同构只加计数
      return last;
    }
    const e = { seq: ++this.seq, count: 1, ...entry };
    if (this.entries.length >= this.max) {
      this.entries.shift();
      this.evicted += 1;
    }
    this.entries.push(e);
    this._lastKey = key;
    return e;
  }

  byReq(reqId) {
    return this.entries.filter((e) => e.reqId === reqId);
  }

  stats() {
    return { entries: this.entries.length, evicted: this.evicted, max: this.max };
  }

  truncate(n) {
    if (this.entries.length > n) this.entries.length = n;
    this._lastKey = null;
  }

  toJSON() {
    return { entries: this.entries, evicted: this.evicted, max: this.max, seq: this.seq };
  }
}
