// 简化音色播放：三角波旋律 + 正弦低音，包络从简。事件时间全部来自引擎实际运算。
export class Player {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.nodes = [];
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  scheduleEvent(ev, whenSec) {
    const osc = this.ctx.createOscillator();
    osc.type = ev.vo === 'bas' ? 'sine' : 'triangle';
    osc.frequency.value = 440 * Math.pow(2, (ev.p - 69) / 12);
    const g = this.ctx.createGain();
    const peak = (ev.v / 127) * 0.35;
    const dur = Math.max(0.08, ev.ds);
    g.gain.setValueAtTime(0.0001, whenSec);
    g.gain.linearRampToValueAtTime(peak, whenSec + 0.02);
    g.gain.setTargetAtTime(0.0001, whenSec + Math.max(0.05, dur - 0.05), 0.06);
    osc.connect(g);
    g.connect(this.master);
    osc.start(whenSec);
    osc.stop(whenSec + dur + 0.5);
    this.nodes.push(osc);
  }

  playEvents(events, offsetSec) {
    this.ensure();
    const t0 = this.ctx.currentTime + offsetSec;
    for (const ev of events) this.scheduleEvent(ev, t0 + ev.ts);
    return t0;
  }

  stopAll() {
    for (const n of this.nodes) {
      try { n.stop(); } catch { /* 已停止 */ }
    }
    this.nodes = [];
  }
}
