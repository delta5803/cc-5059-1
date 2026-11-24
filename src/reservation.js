// 可撤销预约：每个过渡请求一条，记录从预留到提交/进入（或撤销/冲突）的完整状态链。
// 与有界 Trace 不同，预约链不被截断，供诊断复跑核对（无伪报）。
export const RES = {
  DEFERRED: 'deferred',          // 请求在边界之后到达，合法等待下一乐句
  RESERVED: 'reserved',          // 已选定出口，可抢占/撤销
  LEAD_GRANTED: 'lead_granted',  // 拼接器取得提前量
  SPLICE_QUEUED: 'splice_queued',// 分离乐句就绪：弱起已排队，尚未发声（可撤销）
  COMMITTED: 'committed',        // 已发声提交：不可回退，只能延后接管
  ENTERING: 'entering',          // 已越过接点，正在经过渡段
  ENTERED: 'entered',
  SUPERSEDED: 'superseded',
  CANCELLED: 'cancelled',
  CONFLICT: 'conflict',
  LOST: 'lost',                  // 证据显示应进入却没有进入（状态丢失）
};

export const TERMINAL = new Set([RES.ENTERED, RES.SUPERSEDED, RES.CANCELLED, RES.CONFLICT]);
// 进入目标段前、且已无退路的中间态
export const ARMED = new Set([RES.SPLICE_QUEUED, RES.COMMITTED, RES.ENTERING]);

export class ReservationBook {
  constructor() {
    this.list = [];
    this.seq = 0;
  }

  create(fields) {
    const {
      reqId, mood, sourceId = null, targetId = null, path = [],
      exitBeat = null, lockBeat = null, decisionBeat = null, entryBeat = null,
      createdAt = 0,
      requiredLead = null, grantedLead = null, pickupCount = 0,
      spliceFirstSoundBeat = null, state = RES.RESERVED,
    } = fields;
    const r = {
      id: ++this.seq, reqId, mood, sourceId, targetId, path: [...path],
      exitBeat, lockBeat, decisionBeat, entryBeat, createdAt,
      requiredLead, grantedLead, pickupCount, spliceFirstSoundBeat,
      state, enteredBeat: null, committedBeat: null, terminal: false,
      history: [], entries: [],
    };
    this._push(r, createdAt, state, 'create');
    this.list.push(r);
    return r;
  }

  _push(r, t, to, reason, data) {
    const entry = { t, to, reason };
    if (r.sourceId || r.targetId) {
      entry.stateAt = {
        sourceId: r.sourceId, targetId: r.targetId,
        exitBeat: r.exitBeat, lockBeat: r.lockBeat, entryBeat: r.entryBeat,
      };
    }
    if (data) entry.data = data;
    r.history.push(entry);
  }

  byId(id) { return this.list.find((r) => r.id === id); }
  byReq(reqId) { return this.list.filter((r) => r.reqId === reqId); }
  active() { return this.list.filter((r) => !r.terminal); }
  latestActiveForReq(reqId) {
    const list = this.byReq(reqId).filter((r) => !r.terminal);
    return list.length ? list[list.length - 1] : null;
  }

  transition(id, t, to, reason, data) {
    const r = this.byId(id);
    if (!r) return null;
    if (r.terminal) return r;
    r.state = to;
    if (to === RES.ENTERED) r.enteredBeat = t;
    if (to === RES.COMMITTED) r.committedBeat = t;
    this._push(r, t, to, reason, data);
    if (TERMINAL.has(to)) r.terminal = true;
    return r;
  }

  // 同一预约改变出口/目标时，保留证据链但更新当前快照
  retarget(id, t, fields, reason) {
    const r = this.byId(id);
    if (!r || r.terminal) return r;
    Object.assign(r, fields);
    this._push(r, t, r.state, reason, { retarget: true });
    return r;
  }

  snapshot() {
    return {
      seq: this.seq,
      list: this.list.map((r) => ({
        ...r, path: [...r.path], entries: r.entries.map((x) => ({ ...x })),
        history: r.history.map((h) => ({ ...h, data: h.data ? { ...h.data } : undefined })),
      })),
    };
  }

  restore(snap) {
    this.seq = snap.seq;
    this.list = snap.list.map((r) => ({
      ...r, path: [...r.path], entries: (r.entries || []).map((x) => ({ ...x })),
      history: r.history.map((h) => ({ ...h, data: h.data ? { ...h.data } : undefined })),
    }));
  }
}
