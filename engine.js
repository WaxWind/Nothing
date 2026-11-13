// 音频引擎：AudioContext、每个唱盘的播放节点、每条分轨的推子/EQ/滤波、混音台、主输出
export const MAX_STEMS = 8;

// 旋钮值 -1..1 → EQ 增益（dB）。往左拧到底接近完全切掉
export function eqDb(v) { return v >= 0 ? v * 6 : -40 * v * v; }
// 滤波旋钮 -1..1：中间不滤波，往左低通，往右高通
export function filterFreqs(v) {
  const lp = v < -0.02 ? 20000 * Math.pow(100 / 20000, Math.min(1, (-v - 0.02) / 0.98)) : 22000;
  const hp = v > 0.02 ? 20 * Math.pow(9000 / 20, Math.min(1, (v - 0.02) / 0.98)) : 10;
  return { lp, hp };
}

const T = 0.012; // 参数平滑时间

function smooth(param, value, ctx, tc = T) {
  const now = ctx.currentTime;
  try { param.cancelScheduledValues(now); param.setTargetAtTime(value, now, tc); } catch (e) { param.value = value; }
}

// 一组 EQ + 滤波（分轨和唱盘通道都用）
class EqFilter {
  constructor(ctx) {
    this.ctx = ctx;
    this.lo = ctx.createBiquadFilter(); this.lo.type = 'lowshelf'; this.lo.frequency.value = 220;
    this.mid = ctx.createBiquadFilter(); this.mid.type = 'peaking'; this.mid.frequency.value = 1100; this.mid.Q.value = 0.55;
    this.hi = ctx.createBiquadFilter(); this.hi.type = 'highshelf'; this.hi.frequency.value = 3200;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 22000; this.lp.Q.value = 0.7;
    this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 10; this.hp.Q.value = 0.7;
    this.lo.connect(this.mid); this.mid.connect(this.hi); this.hi.connect(this.lp); this.lp.connect(this.hp);
    this.input = this.lo; this.output = this.hp;
  }
  setEq(band, v) { smooth(this[band].gain, eqDb(v), this.ctx); }
  setFilter(v) {
    const { lp, hp } = filterFreqs(v);
    smooth(this.lp.frequency, lp, this.ctx, 0.02); smooth(this.hp.frequency, hp, this.ctx, 0.02);
    const q = Math.abs(v) > 0.05 ? 1.6 : 0.7;
    smooth(this.lp.Q, q, this.ctx); smooth(this.hp.Q, q, this.ctx);
  }
}

class StemChain {
  constructor(ctx, dest) {
    this.ctx = ctx;
    this.auto = ctx.createGain();   // 自动混音用的增益（不影响你自己的推子位置）
    this.user = ctx.createGain();   // 推子 × 静音/独奏
    this.fx = new EqFilter(ctx);
    this.meter = ctx.createAnalyser(); this.meter.fftSize = 256;
    this.auto.connect(this.user); this.user.connect(this.fx.input); this.fx.output.connect(dest); this.fx.output.connect(this.meter);
    this.input = this.auto;
    this.buf = new Float32Array(256);
  }
  setGain(v) { smooth(this.user.gain, v, this.ctx); }
  setAuto(v, tc = 0.03) { smooth(this.auto.gain, v, this.ctx, tc); }
  level() { this.meter.getFloatTimeDomainData(this.buf); let m = 0; for (let i = 0; i < this.buf.length; i++) { const a = Math.abs(this.buf[i]); if (a > m) m = a; } return m; }
}

export class DeckAudio {
  constructor(engine) {
    const ctx = this.ctx = engine.ctx;
    this.engine = engine;
    this.sr = ctx.sampleRate;
    this.node = new AudioWorkletNode(ctx, 'deck-processor', {
      numberOfInputs: 0, numberOfOutputs: MAX_STEMS, outputChannelCount: new Array(MAX_STEMS).fill(2),
    });
    this.sum = ctx.createGain();
    this.chains = [];
    for (let i = 0; i < MAX_STEMS; i++) {
      const c = new StemChain(ctx, this.sum);
      this.node.connect(c.input, i, 0);
      this.chains.push(c);
    }
    this.trim = ctx.createGain();
    this.fx = new EqFilter(ctx);
    this.fader = ctx.createGain();
    this.xf = ctx.createGain();
    this.meter = ctx.createAnalyser(); this.meter.fftSize = 512;
    this.sum.connect(this.trim); this.trim.connect(this.fx.input); this.fx.output.connect(this.fader);
    this.fader.connect(this.xf); this.fader.connect(this.meter);
    this.xf.connect(engine.masterIn);
    this.rep = { pos: 0, time: 0, v: 0, playing: false, len: 0 };
    this.onEnded = null;
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m.ended) { this.rep.playing = false; this.onEnded && this.onEnded(); return; }
      this.rep = m;
    };
    this.mbuf = new Float32Array(512);
  }
  post(m, tr) { this.node.port.postMessage(m, tr || []); }
  load(stems) {
    // stems: [{d: Int16Array, ch, len}]
    this.post({ cmd: 'load', stems }, stems.map((s) => s.d.buffer));
    this.rep = { pos: 0, time: this.ctx.currentTime, v: 0, playing: false, len: Math.max(0, ...stems.map((s) => s.len)) };
  }
  unload() { this.post({ cmd: 'unload' }); this.rep = { pos: 0, time: this.ctx.currentTime, v: 0, playing: false, len: 0 }; }
  play() { this.post({ cmd: 'play' }); this.rep.playing = true; }
  pause() { this.post({ cmd: 'pause' }); this.rep.playing = false; }
  seek(sec) {
    const p = Math.max(0, sec * this.sr);
    this.post({ cmd: 'seek', pos: p });
    this.rep = { ...this.rep, pos: p, time: this.ctx.currentTime };
  }
  setRate(r) { this.post({ cmd: 'rate', v: r }); }
  scratch(on) { this.post({ cmd: 'scratch', on }); }
  scratchMove(sec) { this.post({ cmd: 'scratchMove', delta: sec * this.sr }); }
  setLoop(on, s, e) { this.post({ cmd: 'loop', on, s: s * this.sr, e: e * this.sr }); }
  startAt(time, sec) { this.post({ cmd: 'startAt', time, pos: sec * this.sr }); }
  // 当前位置（秒），用上次报告的位置推算
  posAt(t) {
    const r = this.rep;
    let p = r.pos + (t - r.time) * this.sr * r.v;
    if (!isFinite(p)) p = r.pos;
    return Math.max(0, Math.min(r.len, p)) / this.sr;
  }
  pos() { return this.posAt(this.ctx.currentTime); }
  get playing() { return this.rep.playing; }
  level() { this.meter.getFloatTimeDomainData(this.mbuf); let m = 0; for (let i = 0; i < this.mbuf.length; i++) { const a = Math.abs(this.mbuf[i]); if (a > m) m = a; } return m; }
  setTrim(v) { smooth(this.trim.gain, v, this.ctx); }
  setFader(v) { smooth(this.fader.gain, v, this.ctx); }
  setXf(v) { smooth(this.xf.gain, v, this.ctx, 0.008); }
}

export class Engine {
  async init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    const ctx = this.ctx;
    await ctx.audioWorklet.addModule('worklet.js');
    this.masterIn = ctx.createGain();
    this.master = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1.5; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002; this.limiter.release.value = 0.12;
    this.meter = ctx.createAnalyser(); this.meter.fftSize = 512;
    this.masterIn.connect(this.master); this.master.connect(this.limiter); this.limiter.connect(ctx.destination); this.limiter.connect(this.meter);
    this.decks = [new DeckAudio(this), new DeckAudio(this)];
    this.mbuf = new Float32Array(512);
  }
  setMaster(v) { smooth(this.master.gain, v, this.ctx); }
  level() { this.meter.getFloatTimeDomainData(this.mbuf); let m = 0; for (let i = 0; i < this.mbuf.length; i++) { const a = Math.abs(this.mbuf[i]); if (a > m) m = a; } return m; }
  async decode(arrayBuffer) {
    return await new Promise((resolve, reject) => {
      const p = this.ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  }
}

// AudioBuffer → 16 位整数交错数据（省一半内存）
export function toInt16(buf) {
  const ch = Math.min(2, buf.numberOfChannels), len = buf.length;
  if (ch === 2) {
    const L = buf.getChannelData(0), R = buf.getChannelData(1);
    const d = new Int16Array(len * 2);
    for (let i = 0, j = 0; i < len; i++, j += 2) {
      let l = L[i] * 32767, r = R[i] * 32767;
      d[j] = l > 32767 ? 32767 : l < -32768 ? -32768 : l;
      d[j + 1] = r > 32767 ? 32767 : r < -32768 ? -32768 : r;
    }
    return { d, ch: 2, len };
  }
  const M = buf.getChannelData(0);
  const d = new Int16Array(len);
  for (let i = 0; i < len; i++) { const m = M[i] * 32767; d[i] = m > 32767 ? 32767 : m < -32768 ? -32768 : m; }
  return { d, ch: 1, len };
}

// 交叉推子曲线：x=0 只有 A，x=1 只有 B，中间两边都是满音量
export function xfGains(x) {
  const a = x <= 0.5 ? 1 : Math.cos((x - 0.5) * Math.PI);
  const b = x >= 0.5 ? 1 : Math.cos((0.5 - x) * Math.PI);
  return [a, b];
}
