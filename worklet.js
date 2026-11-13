// 唱盘播放处理器：在音频线程里同步播放一首歌的所有分轨
// 每条分轨走一个独立输出口，外面再接各自的推子/EQ/滤波
const MAX_OUT = 8;

class DeckProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.stems = [];      // [{d: Int16Array, ch: 1|2, len}]
    this.len = 0;         // 最长分轨的帧数
    this.pos = 0;         // 播放位置（帧，可带小数）
    this.v = 0;           // 实际播放速度（每输出帧走多少帧，可为负=倒放）
    this.rate = 1;        // 目标速度（变速 × 微调）
    this.playing = false;
    this.scratch = false;
    this.scratchTarget = 0;
    this.loopOn = false; this.loopS = 0; this.loopE = 0;
    this.env = 0;         // 防爆音包络
    this.pendingSeek = null;
    this.startAt = null;  // {time, pos}
    this.blockCount = 0;
    this.endedSent = false;
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  onMsg(m) {
    switch (m.cmd) {
      case 'load':
        this.stems = m.stems;
        this.len = 0;
        for (const s of this.stems) this.len = Math.max(this.len, s.len);
        this.pos = m.pos || 0; this.v = 0; this.playing = false; this.scratch = false;
        this.loopOn = false; this.pendingSeek = null; this.startAt = null; this.env = 0;
        this.endedSent = false;
        this.report(true);
        break;
      case 'unload':
        this.stems = []; this.len = 0; this.pos = 0; this.playing = false; this.v = 0;
        this.report(true);
        break;
      case 'play':
        if (this.len) { this.playing = true; this.endedSent = false; if (this.pos >= this.len - 1) this.pos = 0; }
        this.startAt = null;
        break;
      case 'pause':
        this.playing = false; this.startAt = null;
        break;
      case 'seek':
        this.doSeek(m.pos);
        break;
      case 'rate':
        this.rate = m.v;
        break;
      case 'scratch':
        if (m.on && !this.scratch) { this.scratchTarget = this.pos; }
        this.scratch = !!m.on;
        if (m.target !== undefined) this.scratchTarget = m.target;
        break;
      case 'scratchMove':
        this.scratchTarget += m.delta;
        break;
      case 'loop':
        this.loopOn = !!m.on; this.loopS = m.s; this.loopE = m.e;
        break;
      case 'startAt':
        // 在指定的音频时间点从指定位置开始播放（自动混音/同步起播用，精确到采样）
        this.startAt = { time: m.time, pos: m.pos };
        break;
    }
  }

  doSeek(p) {
    p = Math.max(0, Math.min(this.len, p));
    if (this.env < 0.001 && !this.playing && !this.scratch) { this.pos = p; this.pendingSeek = null; }
    else this.pendingSeek = p;
    this.endedSent = false;
  }

  report(force) {
    this.port.postMessage({ pos: this.pos, time: currentTime + (force ? 0 : 128 / sampleRate), v: this.v, playing: this.playing, len: this.len });
  }

  process(inputs, outputs) {
    const n = outputs[0][0].length;
    const stems = this.stems;
    const ns = stems.length;
    // 清空不用的输出口
    for (let o = ns; o < outputs.length; o++) {
      const out = outputs[o]; for (let c = 0; c < out.length; c++) out[c].fill(0);
    }
    if (!this.len) {
      for (let o = 0; o < Math.min(ns, outputs.length); o++) { const out = outputs[o]; for (let c = 0; c < out.length; c++) out[c].fill(0); }
      if ((++this.blockCount & 15) === 0) this.report();
      return true;
    }

    // 定时起播：算出这一块里从第几帧开始
    let startIdx = -1;
    if (this.startAt) {
      const off = Math.round((this.startAt.time - currentTime) * sampleRate);
      if (off < n) { startIdx = Math.max(0, off); }
    }

    // 搓碟：根据目标位置算速度
    let scratchVel = 0;
    if (this.scratch) {
      scratchVel = (this.scratchTarget - this.pos) / (sampleRate * 0.025);
      if (scratchVel > 6) scratchVel = 6; else if (scratchVel < -6) scratchVel = -6;
    }
    const kFast = 1 - Math.exp(-1 / (0.004 * sampleRate));
    const kNorm = 1 - Math.exp(-1 / (0.012 * sampleRate));
    const kRelease = 1 - Math.exp(-1 / (0.06 * sampleRate));
    const envStep = 1 / 96;
    const inv = 1 / 32768;
    const len = this.len;

    let pos = this.pos, v = this.v, env = this.env;
    const outs = outputs;
    for (let i = 0; i < n; i++) {
      if (i === startIdx) {
        pos = this.startAt.pos; this.pendingSeek = null; this.playing = true; this.endedSent = false;
        v = this.rate; env = 0; this.startAt = null;
      }
      // 速度平滑
      let target, k;
      if (this.scratch) { target = scratchVel; k = kFast; }
      else if (this.playing) { target = this.rate; k = (Math.abs(v) > 3 || v < 0) ? kRelease : kNorm; }
      else { target = 0; k = kNorm; }
      v += (target - v) * k;

      // 防爆音包络
      const audible = (this.playing || this.scratch || Math.abs(v) > 0.002) && this.pendingSeek === null;
      if (audible) { if (env < 1) env = Math.min(1, env + envStep); }
      else if (env > 0) env = Math.max(0, env - envStep);
      if (this.pendingSeek !== null && env <= 0) { pos = this.pendingSeek; this.pendingSeek = null; }

      pos += v;
      if (this.loopOn && v > 0 && pos >= this.loopE && this.loopE > this.loopS) pos -= (this.loopE - this.loopS);
      if (pos < 0) { pos = 0; if (v < 0) v = 0; }
      if (pos >= len - 1) {
        pos = len - 1;
        if (this.playing && !this.scratch) { this.playing = false; v = 0; if (!this.endedSent) { this.endedSent = true; this.port.postMessage({ ended: true }); } }
      }

      const idx = pos | 0, f = pos - idx, g = env * inv;
      for (let s = 0; s < ns && s < outs.length; s++) {
        const st = stems[s], d = st.d, out = outs[s];
        let l = 0, r = 0;
        if (idx < st.len - 1 && env > 0) {
          if (st.ch === 2) {
            const j = idx << 1;
            l = (d[j] + (d[j + 2] - d[j]) * f) * g;
            r = (d[j + 1] + (d[j + 3] - d[j + 1]) * f) * g;
          } else {
            l = r = (d[idx] + (d[idx + 1] - d[idx]) * f) * g;
          }
        }
        out[0][i] = l; if (out[1]) out[1][i] = r;
      }
    }
    this.pos = pos; this.v = v; this.env = env;
    if ((++this.blockCount & 7) === 0) this.report();
    return true;
  }
}

registerProcessor('deck-processor', DeckProcessor);
