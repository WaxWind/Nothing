// 分轨DJ 主程序
import { Engine, toInt16, xfGains, MAX_STEMS } from './engine.js';
import { groupFiles, modeName, analyzeRhythm, stemPeaks, bandPeaks, toBytes, audibleRange, fmtTime, WAVE_RATE, KIND_MAP } from './analysis.js';
import { lib, uid } from './library.js';
import { $, $$, h, clamp, Knob, Fader, modal, close as closeModal, confirmBox, promptBox, toast, hideToast, escapeHtml } from './ui.js';

const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
const frac = (x) => x - Math.floor(x);
const ramp = (p, a, b) => clamp((p - a) / (b - a), 0, 1);
const faderGain = (v) => (v <= 0 ? 0 : v * v);
function bestRatio(r) { let best = r; for (const c of [r * 2, r / 2]) if (Math.abs(c - 1) < Math.abs(best - 1)) best = c; return best; }

// ---------- 设置 ----------
const SETTINGS_KEY = 'djmix-settings-v1';
const settings = Object.assign({ zoom: 3, am: { beats: 16, style: 'auto', match: true }, queue: [] }, (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; } })());
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) {} }

let engine = null;
let decks = [];
let mixer = null;
let waves = null;

// =====================================================================
// 唱盘
// =====================================================================
class Deck {
  constructor(i) {
    this.i = i; this.L = 'AB'[i];
    this.root = $(i ? '#deckB' : '#deckA');
    this.audio = null; this.song = null; this.wave = null;
    this.bpm = 0; this.t0 = 0; this.tempo = 0; this.range = 0.08; this.bend = 0; this.sync = false;
    this.loop = { on: false, beats: 4, s: 0, e: 0 };
    this.cue = 0; this.stems = []; this.view = 'platter';
    this.trim = 0; this.eq = { hi: 0, mid: 0, lo: 0 }; this.filter = 0; this.fader = 1;
    this.cuePreview = false; this.cueKeep = false; this.loadToken = 0;
    this.waveScale = 1; this.lastTxt = {}; this.popStem = -1;
    this.build();
  }
  get other() { return decks[1 - this.i]; }
  get isMulti() { return !!this.song && this.song.type === 'multi'; }
  get duration() { return this.audio && this.audio.rep.len ? this.audio.rep.len / this.audio.sr : (this.song ? this.song.duration : 0); }
  beatLen() { return this.bpm > 0 ? 60 / this.bpm : 0; }
  rate() { return (1 + this.tempo) * (1 + this.bend); }
  curBpm() { return this.bpm * (1 + this.tempo); }

  build() {
    const r = this.root;
    r.innerHTML = `
      <div class="dhead">
        <div class="lcd">
          <div class="dletter">${this.L}</div>
          <div class="tt"><div class="tname">未载入</div><div class="tsub"><span class="mode">空</span><span class="stemlist"></span></div></div>
          <button class="bpmbox"><span class="bpm num">—</span><small>BPM</small></button>
          <div class="timebox num"><div class="rm">-0:00</div><div class="el">0:00</div><div class="beats"><i></i><i></i><i></i><i></i></div></div>
        </div>
        <button class="btn small loadbtn">载入</button>
      </div>
      <canvas class="overview"></canvas>
      <div class="dbody">
        <div class="tempo-col"><div class="silk">变速</div><button class="btn small trange">±8%</button><div class="tfw" style="flex:1;min-height:0;display:flex"></div><div class="tval num">0.0%</div><div class="bend"><button class="btn bm">‹</button><button class="btn bp">›</button></div></div>
        <div class="dmain">
          <div class="viewtabs"><button data-v="stems">分轨</button><button data-v="platter">唱盘</button></div>
          <div class="platter-wrap"><div class="ttb">
            <div class="platter"><div class="spin"><div class="dots"></div><div class="vinyl"><div class="label"><b>${this.L}</b><span>分轨 DJ</span></div></div></div><div class="sheen"></div><div class="spindle"></div></div>
            <svg class="tonearm" viewBox="0 0 118 100">
              <defs>
                <linearGradient id="tgArm${this.L}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6f7f9"/><stop offset=".5" stop-color="#8b8f96"/><stop offset="1" stop-color="#dadde1"/></linearGradient>
                <radialGradient id="tgBase${this.L}" cx=".38" cy=".32" r=".75"><stop offset="0" stop-color="#6d7076"/><stop offset=".6" stop-color="#2b2d31"/><stop offset="1" stop-color="#111214"/></radialGradient>
                <linearGradient id="tgCw${this.L}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d4d7dc"/><stop offset=".5" stop-color="#6c7077"/><stop offset="1" stop-color="#b6bac0"/></linearGradient>
              </defs>
              <circle cx="108" cy="10" r="9.6" fill="url(#tgBase${this.L})" stroke="#000" stroke-width=".5"/>
              <circle cx="108" cy="10" r="6.2" fill="#1a1b1e" stroke="#4d5056" stroke-width=".6"/>
              <g class="armg" transform="rotate(94 108 10)">
                <rect x="90.5" y="6.1" width="10.5" height="7.8" rx="1.5" fill="url(#tgCw${this.L})" stroke="#000" stroke-width=".3"/>
                <rect x="100" y="9.1" width="9" height="1.8" fill="url(#tgArm${this.L})"/>
                <circle cx="108" cy="10" r="3.3" fill="url(#tgCw${this.L})" stroke="#000" stroke-width=".3"/>
                <rect x="108" y="9.15" width="66" height="1.7" rx=".85" fill="url(#tgArm${this.L})" stroke="rgba(0,0,0,.55)" stroke-width=".2"/>
                <g transform="translate(173.5 10) rotate(-22)">
                  <rect x="-1" y="-2.7" width="11.2" height="5.4" rx="1" fill="#25272b" stroke="#9a9ea5" stroke-width=".35"/>
                  <rect x="6.4" y="-1.75" width="3.5" height="3.5" rx=".4" fill="#c79e45"/>
                  <rect x="1.6" y="-4.4" width="1.2" height="2.1" fill="#9a9ea5"/>
                </g>
              </g>
            </svg>
          </div></div>
          <div class="stems"></div>
          <div class="empty-msg"><div>还没有载入歌曲</div><button class="btn small openlib">打开曲库</button></div>
          <div class="loading"><div class="ltxt">载入中…</div><div class="bar"><i></i></div></div>
        </div>
      </div>
      <div class="transport">
        <button class="btn tb-cue">CUE</button>
        <button class="btn tb-play">▶</button>
        <button class="btn tb-sync">SYNC</button>
        <div class="loopgrp"><button class="btn lh">½</button><button class="btn lp">循环<small>4 拍</small></button><button class="btn ld">×2</button></div>
      </div>`;
    const q = (s) => r.querySelector(s);
    this.el = {
      name: q('.tname'), mode: q('.mode'), stemlist: q('.stemlist'), bpm: q('.bpm'), rm: q('.rm'), elT: q('.el'), beats: [...r.querySelectorAll('.beats i')],
      ov: q('.overview'), trange: q('.trange'), tval: q('.tval'), platter: q('.platter'), disc: q('.spin'), arm: q('.armg'), stems: q('.stems'),
      ltxt: q('.ltxt'), lbar: q('.loading .bar'), cue: q('.tb-cue'), play: q('.tb-play'), sync: q('.tb-sync'),
      lh: q('.lh'), lp: q('.lp'), ld: q('.ld'), tabs: [...r.querySelectorAll('.viewtabs button')], bpmbox: q('.bpmbox'),
    };
    // 变速推子（往上 = 变快）
    this.tf = new Fader({ orient: 'v', value: 0, def: 0, min: -1, max: 1, center: true, cls: 'tempo bip', sens: 0.6, caps: 30, onChange: (v) => this.userTempo(v * this.range) });
    q('.tfw').append(this.tf.el);
    this.tf.el.style.width = '46px';
    this.el.trange.onclick = () => {
      const opts = [0.08, 0.16, 0.5];
      this.range = opts[(opts.indexOf(this.range) + 1) % opts.length];
      if (Math.abs(this.tempo) > this.range) this.setTempo(clamp(this.tempo, -this.range, this.range));
      this.updateTempoUi();
    };
    const bendBtn = (b, v) => {
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); this.bend = v; this.applyRate(); b.classList.add('on'); });
      const off = () => { this.bend = 0; this.applyRate(); b.classList.remove('on'); };
      b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('pointerleave', off);
    };
    bendBtn(q('.bm'), -0.04); bendBtn(q('.bp'), 0.04);

    // 走带按钮
    this.el.play.addEventListener('pointerdown', (e) => { e.preventDefault(); this.playPress(); });
    this.el.cue.addEventListener('pointerdown', (e) => { e.preventDefault(); this.cueDown(); });
    const cueUp = () => this.cueUp();
    this.el.cue.addEventListener('pointerup', cueUp); this.el.cue.addEventListener('pointercancel', cueUp);
    this.el.sync.onclick = () => this.setSync(!this.sync);
    this.el.lp.onclick = () => this.loopToggle();
    this.el.lh.onclick = () => this.loopResize(0.5);
    this.el.ld.onclick = () => this.loopResize(2);
    for (const b of this.el.tabs) b.onclick = () => this.setView(b.dataset.v);
    q('.loadbtn').onclick = () => openSheet('lib', this.i);
    q('.openlib').onclick = () => openSheet('lib', this.i);
    this.el.bpmbox.onclick = () => openBpmPop(this);

    this.bindPlatter();
    this.bindOverview();
  }

  attach(audio) {
    this.audio = audio;
    audio.onEnded = () => { this.cuePreview = false; this.updateButtons(); };
    this.applyMixer();
  }

  // ---------- 唱盘：搓碟 / 微调 ----------
  bindPlatter() {
    const p = this.el.platter;
    let id = null, mode = null, lastA = 0, lastT = 0, cx = 0, cy = 0, nudgeTimer = null;
    p.addEventListener('pointerdown', (e) => {
      if (!this.song || id !== null) return;
      e.preventDefault();
      const r = p.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      const dx = e.clientX - cx, dy = e.clientY - cy;
      const R = r.width / 2, d = Math.hypot(dx, dy);
      if (d > R * 1.02) return;
      id = e.pointerId; try { p.setPointerCapture(id); } catch (_) {}
      lastA = Math.atan2(dy, dx); lastT = performance.now();
      if (d < R * 0.8) { mode = 'scratch'; this.audio.scratch(true); p.classList.add('touch'); }
      else { mode = 'nudge'; p.classList.add('nudge'); }
    });
    p.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const a = Math.atan2(e.clientY - cy, e.clientX - cx);
      let da = a - lastA; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
      lastA = a;
      const t = performance.now(), dt = Math.max(1, t - lastT) / 1000; lastT = t;
      if (mode === 'scratch') this.audio.scratchMove(da / (2 * Math.PI) * 1.8);
      else {
        this.bend = clamp(da / dt * 0.035, -0.3, 0.3); this.applyRate();
        clearTimeout(nudgeTimer); nudgeTimer = setTimeout(() => { this.bend = 0; this.applyRate(); }, 70);
      }
    });
    const up = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      if (mode === 'scratch') this.audio.scratch(false);
      else { this.bend = 0; this.applyRate(); }
      p.classList.remove('touch', 'nudge'); mode = null;
    };
    p.addEventListener('pointerup', up); p.addEventListener('pointercancel', up);
  }

  bindOverview() {
    const c = this.el.ov;
    let id = null, lastSeek = 0;
    const seekTo = (e, force) => {
      const r = c.getBoundingClientRect();
      const f = clamp((e.clientX - r.left) / r.width, 0, 1);
      const t = performance.now();
      if (!force && t - lastSeek < 60) return;
      lastSeek = t;
      this.seek(f * this.duration);
    };
    c.addEventListener('pointerdown', (e) => { if (!this.song) return; e.preventDefault(); id = e.pointerId; try { c.setPointerCapture(id); } catch (_) {} seekTo(e, true); });
    c.addEventListener('pointermove', (e) => { if (e.pointerId === id) seekTo(e); });
    const up = (e) => { if (e.pointerId === id) { seekTo(e, true); id = null; } };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', () => (id = null));
  }

  // ---------- 载入 ----------
  setBusy(on, txt, p) {
    this.root.classList.toggle('busy', on);
    if (txt) this.el.ltxt.textContent = txt;
    if (p !== undefined) this.el.lbar.style.setProperty('--p', p);
  }

  setSong(song, wave) {
    this.song = song; this.wave = wave;
    this.bpm = song.bpm || 0; this.t0 = song.t0 || 0;
    this.loop.on = false; this.bend = 0; this.cuePreview = false;
    this.audio.setLoop(false, 0, 0);
    const n = Math.min(song.stems.length, MAX_STEMS);
    this.stems = song.stems.slice(0, n).map((s) => ({ ...s, fader: 1, mute: false, solo: false, eq: { hi: 0, mid: 0, lo: 0 }, filter: 0, eff: 1 }));
    for (let j = 0; j < MAX_STEMS; j++) {
      const c = this.audio.chains[j];
      c.setAuto(1, 0.01);
      for (const b of ['hi', 'mid', 'lo']) c.fx.setEq(b, 0);
      c.fx.setFilter(0);
    }
    this.updateStemGains();
    // 波形缩放：多轨叠起来的最大高度
    this.waveScale = 1;
    if (wave && song.type === 'multi') {
      const arrs = wave.data; const N = arrs[0].length; let mx = 1;
      for (let i = 0; i < N; i++) { let s = 0; for (const a of arrs) s += a[i] || 0; if (s > mx) mx = s; }
      this.waveScale = 255 / mx;
    }
    this.root.classList.add('loaded');
    this.root.classList.toggle('multi', this.isMulti);
    this.setView(this.isMulti ? 'stems' : 'platter');
    this.el.name.textContent = song.title;
    this.el.mode.textContent = this.isMulti ? '多音轨 · ' + modeName(song.stems) : '单曲';
    this.el.stemlist.textContent = this.isMulti ? song.stems.map((s) => s.label).join(' · ') : '';
    $(this.i ? '#laneB' : '#laneA').textContent = song.title;
    this.buildStemsUi();
    this.lastTxt = {};
    if (this.sync && this.other.song) this.followSync(); else this.setTempo(0);
    this.cue = this.introPoint();
    this.audio.seek(this.cue);
    this.drawOverviewBase();
    this.updateButtons();
  }

  introPoint() {
    const first = (this.song && this.song.first) || 0;
    const bl = this.beatLen();
    if (!bl) return Math.max(0, first - 0.02);
    const n = Math.floor((first + 0.03 - this.t0) / bl);
    return Math.max(0, this.t0 + n * bl);
  }
  // 自动混音用：歌开头的第一个小节线（可能是负数，表示要晚一点开始）
  barIntro() {
    const first = (this.song && this.song.first) || 0;
    const bl = this.beatLen();
    if (!bl) return Math.max(0, first - 0.02);
    const bar = bl * 4;
    const n = Math.floor((first + 0.03 - this.t0) / bar);
    return this.t0 + n * bar;
  }
  nearestBeat(t) { const bl = this.beatLen(); if (!bl) return t; let b = this.t0 + Math.round((t - this.t0) / bl) * bl; if (b < 0) b += bl; return b; }
  nextBar(t) { const bl = this.beatLen(); if (!bl) return t; const bar = bl * 4; return this.t0 + Math.ceil((t - this.t0) / bar) * bar; }

  // ---------- 分轨界面 ----------
  buildStemsUi() {
    const box = this.el.stems;
    box.innerHTML = '';
    this.popStem = -1;
    if (!this.isMulti) return;
    this.stems.forEach((s, j) => {
      const strip = h('div', { class: 'strip', style: `--c:${s.color}` });
      const meter = h('div', { class: 'smeter' }, h('i'));
      const fader = new Fader({ orient: 'v', value: 1, def: 1, caps: 38, onChange: (v) => { s.fader = v; this.updateStemGains(); } });
      const m = h('button', { class: 'm' }, 'M');
      const so = h('button', { class: 's' }, 'S');
      const eq = h('button', { class: 'seq' }, 'EQ ▾');
      m.addEventListener('pointerdown', (e) => { e.preventDefault(); s.mute = !s.mute; this.updateStemGains(); });
      so.addEventListener('pointerdown', (e) => { e.preventDefault(); s.solo = !s.solo; this.updateStemGains(); });
      eq.onclick = () => this.openStemPop(j);
      strip.append(h('div', { class: 'sname' }, s.label), h('div', { class: 'sfw' }, meter, fader.el), h('div', { class: 'sbtns' }, m, so), eq);
      box.append(strip);
      s.ui = { strip, meter: meter.firstChild, fader, m, so, eq };
    });
    this.pop = h('div', { class: 'stem-pop' });
    box.append(this.pop);
    this.updateStemGains();
  }

  openStemPop(j) {
    if (this.popStem === j) { this.closeStemPop(); return; }
    const s = this.stems[j];
    this.popStem = j;
    for (const t of this.stems) t.ui.eq.classList.toggle('open', t === s);
    const pop = this.pop;
    pop.innerHTML = '';
    pop.style.setProperty('--c', s.color); pop.style.setProperty('--dc', s.color);
    const ch = this.audio.chains[j];
    const mk = (label, band) => new Knob({ label, value: s.eq[band], def: 0, onChange: (v) => { s.eq[band] = v; ch.fx.setEq(band, v); this.markStemMod(s); k[band].el.classList.toggle('kill', v <= -0.97); } });
    const k = { hi: mk('高', 'hi'), mid: mk('中', 'mid'), lo: mk('低', 'lo') };
    const kf = new Knob({ label: '滤波', value: s.filter, def: 0, onChange: (v) => { s.filter = v; ch.fx.setFilter(v); this.markStemMod(s); } });
    const reset = h('button', { class: 'btn small' }, '重置');
    reset.onclick = () => {
      for (const b of ['hi', 'mid', 'lo']) { s.eq[b] = 0; ch.fx.setEq(b, 0); k[b].set(0); k[b].el.classList.remove('kill'); }
      s.filter = 0; ch.fx.setFilter(0); kf.set(0); this.markStemMod(s);
    };
    const x = h('button', { class: 'btn small' }, '✕');
    x.onclick = () => this.closeStemPop();
    pop.append(h('div', { class: 'ph' }, h('b', {}, s.label), h('span', { style: 'color:var(--dim);font-size:12px' }, 'EQ 与滤波（双击旋钮归零）'), h('div', { class: 'spacer' }), reset, x),
      h('div', { class: 'knobs' }, k.hi.el, k.mid.el, k.lo.el, kf.el));
    pop.classList.add('show');
  }
  closeStemPop() {
    this.popStem = -1;
    if (this.pop) this.pop.classList.remove('show');
    for (const t of this.stems) t.ui && t.ui.eq.classList.remove('open');
  }
  markStemMod(s) {
    const mod = s.filter !== 0 || s.eq.hi !== 0 || s.eq.mid !== 0 || s.eq.lo !== 0;
    s.ui.eq.classList.toggle('mod', mod);
  }

  updateStemGains() {
    if (!this.audio) return;
    const anySolo = this.stems.some((s) => s.solo);
    this.stems.forEach((s, j) => {
      const g = s.mute ? 0 : (anySolo && !s.solo ? 0 : s.fader);
      s.eff = g;
      this.audio.chains[j].setGain(faderGain(g));
      if (s.ui) {
        s.ui.m.classList.toggle('on', s.mute); s.ui.so.classList.toggle('on', s.solo);
        s.ui.strip.classList.toggle('dead', g === 0);
      }
    });
    for (let j = this.stems.length; j < MAX_STEMS; j++) this.audio.chains[j].setGain(0);
    this.ovDirty = true;
  }

  setView(v) {
    if (!this.isMulti) v = 'platter';
    this.view = v;
    this.root.classList.toggle('view-stems', v === 'stems');
    for (const b of this.el.tabs) b.classList.toggle('on', b.dataset.v === v);
    if (v !== 'stems') this.closeStemPop();
  }

  // ---------- 混音台参数 ----------
  applyMixer() {
    const a = this.audio;
    a.setTrim(Math.pow(10, this.trim * 12 / 20));
    for (const b of ['hi', 'mid', 'lo']) a.fx.setEq(b, this.eq[b]);
    a.fx.setFilter(this.filter);
    a.setFader(faderGain(this.fader));
  }
  setEq(band, v) { this.eq[band] = v; if (this.audio) this.audio.fx.setEq(band, v); const k = this.knobs && this.knobs[band]; if (k) { k.set(v); k.el.classList.toggle('kill', v <= -0.97); } }
  setFilter(v) { this.filter = v; if (this.audio) this.audio.fx.setFilter(v); if (this.knobs) this.knobs.filter.set(v); }
  setTrim(v) { this.trim = v; if (this.audio) this.audio.setTrim(Math.pow(10, v * 12 / 20)); if (this.knobs) this.knobs.trim.set(v); }
  setFader(v) { this.fader = v; if (this.audio) this.audio.setFader(faderGain(v)); if (this.chFader) this.chFader.set(v); }

  // ---------- 变速 / 同步 ----------
  applyRate() { if (this.audio) this.audio.setRate(this.rate()); }
  setTempo(t, fromSync = false) {
    if (Math.abs(t) > this.range + 1e-9) this.range = Math.abs(t) <= 0.16 ? 0.16 : 0.5;
    this.tempo = clamp(t, -0.5, 0.5);
    this.applyRate();
    this.updateTempoUi();
    if (!fromSync && this.other && this.other.sync) this.other.followSync();
  }
  userTempo(t) {
    if (this.sync) { this.sync = false; this.updateButtons(); }
    if (am.glide && am.glide.deck === this) am.glide = null;
    this.setTempo(t);
  }
  updateTempoUi() {
    this.tf.set(this.tempo / this.range);
    this.el.trange.textContent = `±${Math.round(this.range * 100)}%`;
    const pct = this.tempo * 100;
    this.el.tval.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(Math.abs(pct) >= 10 ? 1 : 2) + '%';
    this.el.tval.classList.toggle('mod', Math.abs(pct) > 0.001);
    this.lastTxt.bpm = null;
  }
  followSync() {
    const o = this.other;
    if (!o || !o.song || !o.bpm || !this.bpm) return false;
    const r = bestRatio(o.curBpm() / this.bpm);
    if (Math.abs(r - 1) > 0.5) return false;
    this.setTempo(r - 1, true);
    return true;
  }
  setSync(on) {
    if (on) {
      if (!this.song) return;
      if (!this.followSync()) { toast('另一个唱盘没有歌或测不到 BPM，无法同步'); this.sync = false; this.updateButtons(); return; }
      this.sync = true; this.other.sync = false; this.other.updateButtons();
      if (this.audio.playing && this.other.audio.playing) this.phaseAlign();
    } else this.sync = false;
    this.updateButtons();
  }
  // 两个唱盘节拍相位差（返回本唱盘需要移动的秒数）
  phaseDelta(pa, pb) {
    const o = this.other;
    let perA = this.beatLen(), perB = o.beatLen();
    const k = (perA / this.rate()) / (perB / o.rate());
    if (k > 1.5) perB *= Math.round(k); else if (k < 0.67) perA *= Math.round(1 / k);
    const d = frac((pb - o.t0) / perB) - frac((pa - this.t0) / perA);
    return (d - Math.round(d)) * perA;
  }
  phaseAlign() {
    if (!this.bpm || !this.other.bpm) return;
    const t = engine.ctx.currentTime;
    const pa = this.audio.posAt(t), pb = this.other.audio.posAt(t);
    const d = this.phaseDelta(pa, pb);
    if (Math.abs(d) > 0.004) this.audio.seek(pa + d);
  }

  // ---------- 走带 ----------
  seek(t) {
    if (!this.song) return;
    t = clamp(t, 0, this.duration);
    this.audio.seek(t);
  }
  play() {
    if (!this.song) return;
    wakeLock();
    const o = this.other;
    if (this.sync && o.audio.playing && this.bpm && o.bpm) {
      const t = engine.ctx.currentTime + 0.05;
      const pa = this.audio.pos(), pb = o.audio.posAt(t);
      let np = pa + this.phaseDelta(pa, pb);
      if (np < 0) np += this.beatLen();
      this.audio.startAt(t, np);
      this.audio.rep.playing = true;
    } else this.audio.play();
    this.updateButtons();
  }
  pause() { this.audio.pause(); this.updateButtons(); }
  playPress() {
    if (!this.song) return;
    if (this.cuePreview) { this.cueKeep = true; this.updateButtons(); return; }
    if (this.audio.playing) this.pause(); else this.play();
  }
  cueDown() {
    if (!this.song) return;
    if (this.audio.playing && !this.cuePreview) { this.audio.pause(); this.audio.seek(this.cue); this.updateButtons(); return; }
    const p = this.audio.pos();
    if (Math.abs(p - this.cue) > 0.02) { this.cue = this.bpm ? this.nearestBeatIfClose(p) : p; this.audio.seek(this.cue); this.ovDirty = true; this.updateButtons(); return; }
    this.cuePreview = true; this.cueKeep = false;
    this.audio.play(); this.updateButtons();
  }
  nearestBeatIfClose(p) { const b = this.nearestBeat(p); return Math.abs(b - p) < 0.06 ? b : p; }
  cueUp() {
    if (!this.cuePreview) return;
    this.cuePreview = false;
    if (!this.cueKeep) { this.audio.pause(); this.audio.seek(this.cue); }
    this.cueKeep = false;
    this.updateButtons();
  }
  loopToggle() {
    if (!this.song) return;
    if (this.loop.on) { this.loop.on = false; this.audio.setLoop(false, 0, 0); this.updateButtons(); return; }
    const bl = this.beatLen() || 0.5;
    const p = this.audio.pos();
    let s = this.bpm ? this.nearestBeat(p) : p;
    if (s > p + 0.08) s -= bl;   // 别把起点放在前面太远
    if (s < 0) s = 0;
    this.loop = { on: true, beats: this.loop.beats, s, e: s + this.loop.beats * bl };
    this.audio.setLoop(true, this.loop.s, this.loop.e);
    this.updateButtons();
  }
  loopResize(f) {
    const nb = clamp(this.loop.beats * f, 0.125, 32);
    this.loop.beats = nb;
    if (this.loop.on) {
      const bl = this.beatLen() || 0.5;
      this.loop.e = this.loop.s + nb * bl;
      this.audio.setLoop(true, this.loop.s, this.loop.e);
      const p = this.audio.pos();
      if (p > this.loop.e) this.audio.seek(this.loop.s + ((p - this.loop.s) % (this.loop.e - this.loop.s)));
    }
    this.updateButtons();
  }
  updateButtons() {
    const playing = this.audio && this.audio.playing;
    this.el.play.classList.toggle('on', !!playing);
    this.el.play.textContent = playing ? '❚❚' : '▶';
    this.el.cue.classList.toggle('on', this.cuePreview);
    this.el.sync.classList.toggle('on', this.sync);
    this.el.lp.classList.toggle('on', this.loop.on);
    const b = this.loop.beats;
    this.el.lp.innerHTML = `循环<small>${b >= 1 ? b : '1/' + Math.round(1 / b)} 拍</small>`;
  }

  // ---------- 每帧刷新 ----------
  frame(now) {
    if (!this.audio) return;
    const pos = this.audio.posAt(now);
    this.pos = pos;
    if (!this.song) return;
    if (this.view === 'platter') {
      this.el.disc.style.transform = `rotate(${(pos * 200) % 360}deg)`;
      const arm = 113.9 + 18.1 * clamp(pos / (this.duration || 1), 0, 1);
      if (Math.abs(arm - (this.armA || 0)) > 0.02) { this.armA = arm; this.el.arm.setAttribute('transform', `rotate(${arm.toFixed(2)} 108 10)`); }
    }
    const dur = this.duration;
    const sec = Math.floor(pos);
    if (this.lastTxt.sec !== sec) {
      this.lastTxt.sec = sec;
      this.el.rm.textContent = '-' + fmtTime(dur - pos);
      this.el.elT.textContent = fmtTime(pos) + ' / ' + fmtTime(dur);
      $(this.i ? '#laneBr' : '#laneAr').textContent = '-' + fmtTime(dur - pos);
      // 快结束时提醒
      this.el.rm.style.color = dur - pos < 30 && this.audio.playing ? 'var(--bad)' : '';
    }
    const bt = this.curBpm();
    const bk = this.bpm ? bt.toFixed(1) : '—';
    if (this.lastTxt.bpm !== bk) { this.lastTxt.bpm = bk; this.el.bpm.textContent = bk; }
    const bl = this.beatLen();
    let bi = -1;
    if (bl) bi = ((Math.floor((pos - this.t0) / bl + 0.001) % 4) + 4) % 4;
    if (this.lastTxt.bi !== bi) {
      this.lastTxt.bi = bi;
      this.el.beats.forEach((e, k) => { e.classList.toggle('on', k <= bi); e.classList.toggle('first', k === 0 && bi === 0); });
    }
    if (this.audio.rep.playing !== this.lastTxt.playing) { this.lastTxt.playing = this.audio.rep.playing; this.updateButtons(); }
    this.drawOverview(pos);
  }

  meters() {
    if (!this.song) return;
    if (this.isMulti && this.view === 'stems') {
      this.stems.forEach((s, j) => {
        const l = this.audio.chains[j].level();
        s.lv = Math.max(l, (s.lv || 0) * 0.86);
        s.ui.meter.style.setProperty('--l', Math.min(1, Math.sqrt(s.lv)).toFixed(3));
      });
    }
  }

  // ---------- 总览波形 ----------
  drawOverviewBase() {
    const c = this.el.ov;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(10, Math.round(c.clientWidth * dpr)), H = Math.max(10, Math.round(c.clientHeight * dpr));
    c.width = W; c.height = H;
    if (!this.base) this.base = document.createElement('canvas');
    const b = this.base; b.width = W; b.height = H;
    const g = b.getContext('2d');
    g.clearRect(0, 0, W, H);
    this.ovDirty = false;
    if (!this.wave || !this.song) return;
    const arrs = this.wave.data;
    const N = arrs[0].length;
    const mid = H / 2, half = H / 2 - 1;
    const multi = this.isMulti;
    const cum = new Float32Array(W);
    const layers = multi ? arrs.map((a, j) => ({ a, color: this.stems[j] ? this.stems[j].color : '#888', g: this.stems[j] ? this.stems[j].eff : 0, sc: this.waveScale }))
      : [{ a: arrs[0], color: '#2f6bff', g: 1, sc: 1 }, { a: arrs[1], color: '#ff9a3c', g: 0.85, sc: 1, over: true }, { a: arrs[2], color: '#eef2f8', g: 0.55, sc: 1, over: true }];
    for (const L of layers) {
      if (L.g <= 0) continue;
      g.fillStyle = L.color;
      g.beginPath();
      for (let x = 0; x < W; x++) {
        const i0 = Math.floor(x / W * N), i1 = Math.max(i0 + 1, Math.floor((x + 1) / W * N));
        let m = 0; for (let i = i0; i < i1; i++) if (L.a[i] > m) m = L.a[i];
        const hh = m / 255 * half * L.sc * (multi ? L.g : L.g);
        if (multi) { g.rect(x, mid - cum[x] - hh, 1, hh * 2 + cum[x] * 2); cum[x] += hh; }
        else g.rect(x, mid - hh, 1, hh * 2);
      }
      if (multi) { g.globalCompositeOperation = 'destination-over'; }
      g.fill();
      g.globalCompositeOperation = 'source-over';
    }
  }
  drawOverview(pos) {
    const c = this.el.ov;
    if (this.ovDirty || c.width !== Math.round(c.clientWidth * (window.devicePixelRatio || 1))) this.drawOverviewBase();
    const g = c.getContext('2d');
    const W = c.width, H = c.height, dur = this.duration || 1;
    g.clearRect(0, 0, W, H);
    if (this.base) g.drawImage(this.base, 0, 0);
    const x = pos / dur * W;
    g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, 0, x, H);
    if (this.loop.on) { g.fillStyle = 'rgba(62,224,143,.35)'; g.fillRect(this.loop.s / dur * W, 0, Math.max(2, (this.loop.e - this.loop.s) / dur * W), H); }
    g.fillStyle = '#ffcc33'; const cx = this.cue / dur * W; g.beginPath(); g.moveTo(cx - 5, 0); g.lineTo(cx + 5, 0); g.lineTo(cx, 7); g.fill();
    g.fillStyle = '#fff'; g.fillRect(x - 1, 0, 2, H);
  }
}

// =====================================================================
// 混音台
// =====================================================================
class Mixer {
  constructor() {
    const box = $('#mstrips');
    for (const d of decks) {
      const strip = h('div', { class: 'mstrip ' + (d.i ? 'b' : 'a') });
      const mk = (label, key, def, fn) => new Knob({ label, value: def, def, onChange: fn });
      d.knobs = {
        trim: mk('增益', 'trim', 0, (v) => d.setTrim(v)),
        hi: mk('高', 'hi', 0, (v) => d.setEq('hi', v)),
        mid: mk('中', 'mid', 0, (v) => d.setEq('mid', v)),
        lo: mk('低', 'lo', 0, (v) => d.setEq('lo', v)),
        filter: mk('滤波', 'filter', 0, (v) => d.setFilter(v)),
      };
      d.chFader = new Fader({ orient: 'v', value: 1, def: 1, caps: 46, onChange: (v) => d.setFader(v) });
      const vu = h('div', { class: 'vu' }, h('i'));
      d.vu = vu.firstChild;
      strip.append(h('div', { class: 'chtag' }, d.L), d.knobs.trim.el, d.knobs.hi.el, d.knobs.mid.el, d.knobs.lo.el, d.knobs.filter.el,
        h('div', { class: 'mfw' }, vu, d.chFader.el), h('div', { class: 'flab' }, '总控'));
      box.append(strip);
    }
    this.x = 0.5;
    this.xf = new Fader({ orient: 'h', value: 0.5, def: 0.5, cls: 'xf', caps: 28, onChange: (v) => this.setXf(v, true) });
    $('#xfader').replaceWith(this.xf.el);
    this.master = new Fader({ orient: 'h', value: 0.9, def: 0.9, caps: 18, onChange: (v) => engine && engine.setMaster(faderGain(v) * 1.25) });
    $('#masterFader').replaceWith(this.master.el);
  }
  setXf(v, user = false) {
    this.x = v;
    if (!user) this.xf.set(v);
    const [a, b] = xfGains(v);
    if (decks[0].audio) { decks[0].audio.setXf(a); decks[1].audio.setXf(b); }
  }
  meters() {
    for (const d of decks) {
      if (!d.audio) continue;
      const l = d.audio.level();
      d.vl = Math.max(l, (d.vl || 0) * 0.85);
      d.vu.style.setProperty('--l', Math.min(1, Math.sqrt(d.vl)).toFixed(3));
    }
    if (engine) {
      const l = engine.level(); this.ml = Math.max(l, (this.ml || 0) * 0.85);
      $('#masterMeter i').style.setProperty('--l', Math.min(1, Math.sqrt(this.ml)).toFixed(3));
    }
  }
}

// =====================================================================
// 顶部滚动波形
// =====================================================================
const ZOOMS = [35, 55, 80, 115, 165, 240, 340];
class Waves {
  constructor() {
    this.c = $('#waveCanvas');
    this.g = this.c.getContext('2d');
    this.cols0 = new Int32Array(0); this.cols1 = new Int32Array(0); this.cum = new Float32Array(0);
    $('#zoomIn').onclick = () => { settings.zoom = Math.min(ZOOMS.length - 1, settings.zoom + 1); saveSettings(); };
    $('#zoomOut').onclick = () => { settings.zoom = Math.max(0, settings.zoom - 1); saveSettings(); };
    this.bindScratch();
  }
  get Z() { return ZOOMS[clamp(settings.zoom, 0, ZOOMS.length - 1)]; }
  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.W = this.c.clientWidth; this.H = this.c.clientHeight; this.dpr = dpr;
    this.c.width = Math.round(this.W * dpr); this.c.height = Math.round(this.H * dpr);
    this.cols0 = new Int32Array(Math.ceil(this.W) + 2); this.cols1 = new Int32Array(Math.ceil(this.W) + 2); this.cum = new Float32Array(Math.ceil(this.W) + 2);
  }
  // 在波形上左右拖动 = 搓碟
  bindScratch() {
    const c = this.c;
    const ptrs = new Map();
    c.addEventListener('pointerdown', (e) => {
      const r = c.getBoundingClientRect();
      const d = decks[(e.clientY - r.top) < r.height / 2 ? 0 : 1];
      if (!d || !d.song || !d.audio) return;
      e.preventDefault();
      try { c.setPointerCapture(e.pointerId); } catch (_) {}
      ptrs.set(e.pointerId, { d, x: e.clientX });
      d.audio.scratch(true);
    });
    c.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId); if (!p) return;
      const dx = e.clientX - p.x; p.x = e.clientX;
      p.d.audio.scratchMove(-dx / this.Z * p.d.rate());
    });
    const up = (e) => { const p = ptrs.get(e.pointerId); if (!p) return; ptrs.delete(e.pointerId); p.d.audio.scratch(false); };
    c.addEventListener('pointerup', up); c.addEventListener('pointercancel', up);
  }
  draw() {
    if (!this.W || this.c.clientWidth !== this.W || this.c.clientHeight !== this.H) this.resize();
    const g = this.g, W = this.W, H = this.H;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = '#05060a'; g.fillRect(0, 0, W, H);
    const lh = (H - 2) / 2;
    this.lane(decks[0], 0, lh);
    this.lane(decks[1], lh + 2, lh);
    g.fillStyle = '#1b1f29'; g.fillRect(0, lh, W, 2);
    g.fillStyle = '#fff'; g.fillRect(W / 2 - 1, 0, 2, H);
  }
  lane(d, y0, LH) {
    const g = this.g, W = this.W;
    if (!d || !d.song || !d.wave) return;
    const pos = d.pos || 0;
    const spp = d.rate() / this.Z;          // 每个像素多少秒（按真实时间缩放，两边同步时节拍线对齐）
    const cx = W / 2;
    const tStart = pos - cx * spp;
    const R = d.wave.rate || WAVE_RATE;
    const arrs = d.wave.data;
    const N = arrs[0].length;
    const c0 = this.cols0, c1 = this.cols1, cum = this.cum;
    const cols = Math.ceil(W);
    for (let x = 0; x < cols; x++) {
      const t = tStart + x * spp;
      let i0 = Math.floor(t * R), i1 = Math.floor((t + spp) * R);
      if (i1 <= i0) i1 = i0 + 1;
      c0[x] = i0; c1[x] = i1; cum[x] = 0;
    }
    const mid = y0 + LH / 2, half = LH / 2 - 2;
    g.save();
    g.beginPath(); g.rect(0, y0, W, LH); g.clip();
    // 循环区域
    if (d.loop.on) {
      g.fillStyle = 'rgba(62,224,143,.16)';
      const xs = cx + (d.loop.s - pos) / spp, xe = cx + (d.loop.e - pos) / spp;
      g.fillRect(xs, y0, xe - xs, LH);
    }
    const peak = (a, x) => { const i0 = c0[x], i1 = c1[x]; if (i0 < 0 || i0 >= N) return 0; let m = 0; for (let i = i0; i < i1 && i < N; i++) if (a[i] > m) m = a[i]; return m; };
    if (d.isMulti) {
      const sc = d.waveScale * half / 255;
      d.stems.forEach((s, j) => {
        const ga = s.eff; if (ga <= 0 || !arrs[j]) return;
        const a = arrs[j];
        g.fillStyle = s.color; g.beginPath();
        for (let x = 0; x < cols; x++) {
          const hh = peak(a, x) * sc * ga;
          if (hh < 0.3) continue;
          const cu = cum[x];
          g.rect(x, mid - cu - hh, 1, hh); g.rect(x, mid + cu, 1, hh);
          cum[x] = cu + hh;
        }
        g.fill();
      });
    } else {
      const sets = [[arrs[0], '#2f6bff', 1], [arrs[1], '#ff9a3c', 0.85], [arrs[2], '#eef2f8', 0.55]];
      for (const [a, col, f] of sets) {
        g.fillStyle = col; g.beginPath();
        const sc = half / 255 * f;
        for (let x = 0; x < cols; x++) { const hh = peak(a, x) * sc; if (hh > 0.3) g.rect(x, mid - hh, 1, hh * 2); }
        g.fill();
      }
    }
    // 已播放部分压暗
    g.fillStyle = 'rgba(5,6,10,.38)'; g.fillRect(0, y0, cx, LH);
    // 节拍网格
    const bl = d.beatLen();
    if (bl) {
      const pxBeat = bl / spp;
      const n0 = Math.ceil((tStart - d.t0) / bl), tEnd = tStart + W * spp;
      for (let n = n0; d.t0 + n * bl <= tEnd; n++) {
        const isBar = ((n % 4) + 4) % 4 === 0;
        if (!isBar && pxBeat < 7) continue;
        const x = cx + (d.t0 + n * bl - pos) / spp;
        g.fillStyle = isBar ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.16)';
        g.fillRect(Math.round(x), y0, 1, isBar ? LH : LH * 0.22);
        if (!isBar) g.fillRect(Math.round(x), y0 + LH * 0.78, 1, LH * 0.22);
      }
    }
    // CUE 点
    const xc = cx + (d.cue - pos) / spp;
    if (xc > -10 && xc < W + 10) { g.fillStyle = '#ffcc33'; g.beginPath(); g.moveTo(xc - 6, y0); g.lineTo(xc + 6, y0); g.lineTo(xc, y0 + 9); g.fill(); }
    g.restore();
    // 左边的唱盘颜色条
    g.fillStyle = d.i ? '#ff8a3d' : '#2ad4ff'; g.fillRect(0, y0, 3, LH);
  }
}

// =====================================================================
// 曲库界面
// =====================================================================
let songs = [];
let sheetTab = 'lib';
let sheetTarget = -1;

async function refreshSongs() {
  try { songs = await lib.allSongs(); } catch (e) { songs = []; toast('读取曲库失败：' + (e.message || e)); }
  // 清掉列表里已经删掉的歌
  const ids = new Set(songs.map((s) => s.id));
  am.queue = am.queue.filter((id) => ids.has(id));
  settings.queue = am.queue; saveSettings();
  renderSheet();
}

function openSheet(tab = 'lib', target = -1) {
  sheetTab = tab; sheetTarget = target;
  $('#sheet').classList.add('show');
  for (const b of $$('#sheetTabs button')) b.classList.toggle('on', b.dataset.t === tab);
  renderSheet();
}
function closeSheet() { $('#sheet').classList.remove('show'); }

function songSwatch(s) {
  const sw = h('div', { class: 'swatch' });
  if (s.type === 'multi') for (const st of s.stems) sw.append(h('i', { style: `background:${st.color}` }));
  else sw.append(h('i', { style: 'background:#5fd4ff' }));
  return sw;
}
function songInfo(s) {
  const mode = s.type === 'multi' ? modeName(s.stems) : '单曲';
  return h('div', { class: 'ri' }, h('div', { class: 'rt' }, s.title),
    h('div', { class: 'rs' }, h('span', { class: 'mode', style: `--dc:${s.type === 'multi' ? '#3ee08f' : '#8a93a6'}` }, mode), s.type === 'multi' ? s.stems.map((x) => x.label).join(' · ') : ''));
}

function renderSheet() {
  const body = $('#sbody');
  body.innerHTML = '';
  const foot = $('#sfoot');
  $('#search').style.display = sheetTab === 'lib' ? '' : 'none';
  $('#btnImport').style.display = sheetTab === 'lib' ? '' : 'none';
  if (sheetTab === 'lib') {
    const q = $('#search').value.trim().toLowerCase();
    const list = songs.filter((s) => !q || s.title.toLowerCase().includes(q));
    if (!songs.length) {
      body.append(h('div', { class: 'emptylib', html: '曲库是空的。<br>点右上角「＋ 导入音频」，在「文件」里一次多选分好轨的音频（也可以是普通整首歌）。<br>软件会按文件名自动认出每一轨，并把同一首歌的分轨归到一起。<br><span style="color:#5d6577">支持 wav / mp3 / flac（m4a 也可以试试）</span>' }));
    }
    for (const s of list) {
      const row = h('div', { class: 'row' });
      const la = h('button', { class: 'btn la' + (sheetTarget === 0 ? ' primary' : '') }, '→A');
      const lb = h('button', { class: 'btn lb' + (sheetTarget === 1 ? ' primary' : '') }, '→B');
      la.onclick = () => manualLoad(0, s.id);
      lb.onclick = () => manualLoad(1, s.id);
      const inQ = am.queue.includes(s.id);
      const add = h('button', { class: 'btn' }, inQ ? '✓ 列表' : '＋ 列表');
      add.onclick = () => { if (!am.queue.includes(s.id)) { am.queue.push(s.id); saveQueue(); toast(`已加入自动混音列表（第 ${am.queue.length} 首）`); } renderSheet(); };
      const more = h('button', { class: 'btn' }, '⋯');
      more.onclick = () => songMenu(s);
      row.append(songSwatch(s), songInfo(s),
        h('div', { class: 'rm num' }, h('div', {}, s.bpm ? s.bpm.toFixed(1) + ' BPM' : '— BPM'), h('div', {}, fmtTime(s.duration))),
        h('div', { class: 'rb' }, la, lb, add, more));
      body.append(row);
    }
    foot.innerHTML = '';
    foot.append(h('span', {}, `共 ${songs.length} 首`));
    lib.estimate().then((est) => { if (est && est.usage !== undefined) foot.append(h('span', {}, `占用约 ${(est.usage / 1048576).toFixed(0)} MB`)); });
  } else {
    renderAmTab(body);
    foot.innerHTML = '';
    foot.append(h('span', {}, `列表里 ${am.queue.length} 首 · 自动混音会按顺序一首接一首地过渡`));
  }
}

async function songMenu(s) {
  const r = await modal({ title: s.title, body: `<p style="color:var(--dim)">${s.type === 'multi' ? '多音轨 · ' + modeName(s.stems) + '<br>' + s.stems.map((x) => escapeHtml(x.label) + '：' + escapeHtml(x.name)).join('<br>') : '单曲 · ' + escapeHtml(s.stems[0].name)}</p>`,
    buttons: [{ label: '删除', value: 'del', danger: true }, { label: '重命名', value: 'ren' }, { label: '关闭', value: null, primary: true }] });
  if (r === 'ren') {
    const t = await promptBox('重命名', s.title);
    if (t && t.trim()) { s.title = t.trim(); await lib.putSong(s); for (const d of decks) if (d.song && d.song.id === s.id) { d.song.title = s.title; d.el.name.textContent = s.title; } refreshSongs(); }
  } else if (r === 'del') {
    if (await confirmBox('删除这首歌？', `「${escapeHtml(s.title)}」和它的分轨会从曲库里删除（不会删掉「文件」App 里的原文件）。`, '删除', true)) {
      await lib.deleteSong(s); refreshSongs(); toast('已删除');
    }
  }
}

async function manualLoad(i, id) {
  if (am.on) { const ok = await confirmBox('停止自动混音？', '手动载入歌曲会停止自动混音。', '停止并载入'); if (!ok) return; amStop(); }
  closeSheet();
  await loadSong(decks[i], id);
}

async function loadSong(deck, id, { force = false } = {}) {
  if (!engine) return false;
  if (!force && deck.audio.playing) {
    const ok = await confirmBox('替换正在播放的歌？', `唱盘 ${deck.L} 正在播放，确定要换成新的歌吗？`, '替换');
    if (!ok) return false;
  }
  const token = ++deck.loadToken;
  deck.setBusy(true, '读取曲库…', 0);
  try {
    const song = await lib.getSong(id);
    if (!song) throw new Error('找不到这首歌');
    const wave = await lib.getWave(id);
    const n = Math.min(song.stems.length, MAX_STEMS);
    const data = [];
    for (let j = 0; j < n; j++) {
      deck.setBusy(true, `载入 ${song.type === 'multi' ? '分轨 ' + (j + 1) + '/' + n + '：' + song.stems[j].label : '音频'}`, j / n);
      const rec = await lib.getFile(song.stems[j].fileId);
      if (!rec) throw new Error('音频文件丢失：' + song.stems[j].label);
      const buf = await engine.decode(rec.data);
      if (token !== deck.loadToken) return false;
      data.push(toInt16(buf));
      deck.setBusy(true, undefined, (j + 1) / n);
      await nextFrame();
    }
    if (token !== deck.loadToken) return false;
    deck.audio.pause();
    deck.audio.load(data);
    deck.setSong(song, wave);
    deck.setBusy(false);
    return true;
  } catch (e) {
    console.error(e);
    if (token === deck.loadToken) deck.setBusy(false);
    toast('载入失败：' + (e.message || e), 4000);
    return false;
  }
}

// ---------- 导入 ----------
async function onFiles(fileList) {
  if (!engine) return;
  const files = [...fileList].filter((f) => /\.(wav|wave|mp3|flac|m4a|aac|aif|aiff|ogg|opus)$/i.test(f.name) || (f.type || '').startsWith('audio'));
  if (!files.length) { toast('没有可以导入的音频文件'); return; }
  const groups = groupFiles(files);
  const box = h('div');
  const multiN = groups.filter((g) => g.type === 'multi').length;
  box.append(h('p', { style: 'color:var(--dim)' }, `一共 ${files.length} 个文件，识别成 ${groups.length} 首歌（${multiN} 首多音轨，${groups.length - multiN} 首单曲）：`));
  for (const g of groups) {
    const chips = h('div', { class: 'chips' });
    for (const it of g.items) chips.append(h('span', { class: 'chip', style: `--c:${it.color}` }, it.label));
    box.append(h('div', { class: 'prev-song' }, h('div', { class: 'pt' }, g.title), h('div', { style: 'font-size:12px;color:var(--dim)' }, g.type === 'multi' ? '多音轨 · ' + modeName(g.items.map((x) => ({ kind: x.kind }))) : '单曲'), chips));
  }
  const ok = await modal({ title: '导入预览', body: box, wide: true, buttons: [{ label: '取消', value: false }, { label: `导入 ${groups.length} 首`, value: true, primary: true }] });
  if (!ok) return;
  await lib.persist();
  let n = 0; const fails = [];
  for (const g of groups) {
    n++;
    const pre = `导入 ${n}/${groups.length}：${g.title}`;
    try { await importOne(g, (m) => toast(`${pre} · ${m}`, 0)); }
    catch (e) { console.error(e); fails.push(`${g.title}：${e.message || e}`); }
  }
  hideToast();
  await refreshSongs();
  if (fails.length) modal({ title: '有些歌没导入成功', body: '<p>' + fails.map(escapeHtml).join('<br>') + '</p>' });
  else toast(`导入完成：${groups.length} 首`);
}

async function importOne(g, progress) {
  const sr = engine.ctx.sampleRate;
  const id = uid();
  const multi = g.type === 'multi';
  const kinds = g.items.map((i) => i.kind);
  // 测 BPM 用哪些轨：有鼓用鼓，没有鼓用伴奏，再没有就用除人声以外的
  let use;
  if (!multi) use = () => true;
  else if (kinds.some((k) => k === 'drums' || k === 'perc')) use = (k) => k === 'drums' || k === 'perc';
  else if (kinds.includes('inst')) use = (k) => k === 'inst';
  else if (kinds.some((k) => KIND_MAP[k] && KIND_MAP[k].role !== 'vox')) use = (k) => KIND_MAP[k].role !== 'vox';
  else use = () => true;
  const stems = [], fileIds = [], peaks = [];
  let bands = null, mono = null, duration = 0;
  try {
    for (let j = 0; j < g.items.length; j++) {
      const it = g.items[j];
      progress(`读取 ${j + 1}/${g.items.length}`);
      const ab = await it.file.arrayBuffer();
      const fileId = uid();
      await lib.putFile({ id: fileId, name: it.file.name, type: it.file.type || '', data: ab });
      fileIds.push(fileId);
      progress(`分析 ${it.label}`);
      let buf;
      try { buf = await engine.decode(ab); } catch (e) { throw new Error(`「${it.file.name}」无法解码，可能格式不支持`); }
      duration = Math.max(duration, buf.duration);
      const L = buf.getChannelData(0), R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
      if (multi) peaks.push(stemPeaks([L, R], sr)); else bands = bandPeaks([L, R], sr);
      if (use(it.kind)) {
        if (!mono || mono.length < buf.length) { const m2 = new Float32Array(buf.length); if (mono) m2.set(mono); mono = m2; }
        for (let i = 0; i < buf.length; i++) mono[i] += (L[i] + R[i]) * 0.5;
      }
      stems.push({ label: it.label, kind: it.kind, color: it.color, fileId, name: it.file.name });
      buf = null;
      await nextFrame();
    }
    progress('测 BPM');
    await nextFrame();
    const rh = mono ? analyzeRhythm(mono, sr) : { bpm: 0, t0: 0 };
    mono = null;
    const data = multi ? toBytes(peaks) : toBytes([bands.low, bands.mid, bands.high]);
    const range = audibleRange(data);
    const song = { id, title: g.title, type: multi ? 'multi' : 'single', stems, duration, bpm: rh.bpm, t0: rh.t0, first: range.first, last: Math.min(duration, range.last), addedAt: Date.now() };
    await lib.putWave({ id, rate: WAVE_RATE, data });
    await lib.putSong(song);
  } catch (e) {
    for (const f of fileIds) { try { await lib.deleteSong({ id: '__none__', stems: [{ fileId: f }] }); } catch (_) {} }
    throw e;
  }
}

// =====================================================================
// 自动混音
// =====================================================================
const am = { on: false, queue: settings.queue || [], idx: -1, cur: 0, phase: 'idle', tr: null, loading: false, glide: null };
function saveQueue() { settings.queue = am.queue; saveSettings(); }

function renderAmTab(body) {
  const s = settings.am;
  const seg = (opts, val, fn) => {
    const e = h('div', { class: 'seg' });
    for (const [v, label] of opts) { const b = h('button', { class: v === val ? 'on' : '' }, label); b.onclick = () => { fn(v); saveSettings(); renderSheet(); }; e.append(b); }
    return e;
  };
  const set = h('div', { class: 'amset' },
    h('label', {}, '过渡长度', seg([[8, '8 拍'], [16, '16 拍'], [32, '32 拍']], s.beats, (v) => (s.beats = v))),
    h('label', {}, '过渡方式', seg([['auto', '自动'], ['stems', '分轨渐入'], ['eq', '低频交换'], ['filter', '滤波'], ['fade', '淡入淡出']], s.style, (v) => (s.style = v))),
    h('label', {}, '匹配速度', seg([[true, '开'], [false, '关']], s.match, (v) => (s.match = v))),
  );
  body.append(set);
  const tools = h('div', { style: 'display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap' });
  const addAll = h('button', { class: 'btn small' }, '把曲库全部加入'); addAll.onclick = () => { for (const x of songs) if (!am.queue.includes(x.id)) am.queue.push(x.id); saveQueue(); renderSheet(); };
  const shuf = h('button', { class: 'btn small' }, '打乱顺序'); shuf.onclick = () => { const fixed = am.on ? am.queue.slice(0, am.idx + 2) : []; const rest = am.queue.slice(fixed.length); for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; } am.queue = fixed.concat(rest); saveQueue(); renderSheet(); };
  const clr = h('button', { class: 'btn small' }, '清空列表'); clr.onclick = async () => { if (am.on) amStop(); if (await confirmBox('清空自动混音列表？', '只是清空列表，不会删除曲库里的歌。', '清空')) { am.queue = []; saveQueue(); renderSheet(); } };
  const go = h('button', { class: 'btn small primary' }, am.on ? '停止自动混音' : '▶ 开始自动混音'); go.onclick = () => { if (am.on) amStop(); else { closeSheet(); amStart(); } };
  tools.append(go, addAll, shuf, clr);
  body.append(tools);
  if (!am.queue.length) body.append(h('div', { class: 'emptylib', html: '列表是空的。到「曲库」里点歌后面的「＋ 列表」把歌加进来，<br>然后点「开始自动混音」，软件会自动在两个唱盘之间一首接一首地混。' }));
  am.queue.forEach((id, k) => {
    const s = songs.find((x) => x.id === id); if (!s) return;
    const row = h('div', { class: 'row' + (am.on && k === am.idx ? ' cur' : '') });
    const up = h('button', { class: 'btn' }, '↑'); up.onclick = () => { if (k > 0) { [am.queue[k - 1], am.queue[k]] = [am.queue[k], am.queue[k - 1]]; saveQueue(); renderSheet(); } };
    const dn = h('button', { class: 'btn' }, '↓'); dn.onclick = () => { if (k < am.queue.length - 1) { [am.queue[k + 1], am.queue[k]] = [am.queue[k], am.queue[k + 1]]; saveQueue(); renderSheet(); } };
    const rm = h('button', { class: 'btn' }, '✕'); rm.onclick = () => { am.queue.splice(k, 1); if (am.on && k <= am.idx) am.idx--; saveQueue(); renderSheet(); };
    row.append(h('div', { class: 'idx' }, am.on && k === am.idx ? '▶' : String(k + 1)), songSwatch(s), songInfo(s),
      h('div', { class: 'rm num' }, h('div', {}, s.bpm ? s.bpm.toFixed(1) + ' BPM' : '— BPM'), h('div', {}, fmtTime(s.duration))),
      h('div', { class: 'rb' }, up, dn, rm));
    body.append(row);
  });
}

function amUpdateUi() {
  $('#btnAm').classList.toggle('on', am.on);
  $('#btnAm').style.setProperty('--dc', '#3ee08f');
  $('#btnAm').textContent = am.on ? '■ 停止自动混音' : '⟳ 自动混音';
  $('#btnAmNext').disabled = !am.on;
}
function amSetStatus(t) { const e = $('#amStatus'); e.textContent = t; e.classList.toggle('live', am.on); }

async function amStart() {
  if (!engine) return;
  if (!am.queue.length) { toast('先在「自动混音列表」里加几首歌'); openSheet('am'); return; }
  am.on = true; am.phase = 'idle'; am.tr = null; am.glide = null;
  amUpdateUi();
  const playingIdx = decks.findIndex((d) => d.song && d.audio.playing);
  if (playingIdx >= 0) {
    am.cur = playingIdx;
    const qi = am.queue.indexOf(decks[playingIdx].song.id);
    am.idx = qi;          // 不在列表里就是 -1，从列表第一首接上
  } else {
    am.idx = 0; am.cur = 0;
    const d = decks[0];
    amSetStatus('载入第一首…');
    const ok = await loadSong(d, am.queue[0], { force: true });
    if (!am.on) return;
    if (!ok) { amStop('第一首载入失败'); return; }
    amResetAuto(d); d.setSync(false); d.setTempo(0);
    mixer.setXf(0);
    d.play();
  }
  for (const d of decks) d.sync = false, d.updateButtons();
  await amPrepareNext();
}

function amStop(msg) {
  if (!am.on) return;
  am.on = false;
  if (am.phase === 'trans') for (const d of decks) amResetAuto(d);
  am.phase = 'idle'; am.tr = null; am.glide = null;
  amUpdateUi(); amSetStatus(msg || '');
  if (msg) toast(msg);
  if ($('#sheet').classList.contains('show')) renderSheet();
}

function amResetAuto(d) {
  if (!d.audio) return;
  for (const c of d.audio.chains) c.setAuto(1, 0.05);
}

async function amPrepareNext() {
  am.phase = 'idle'; am.tr = null;
  const ni = am.idx + 1;
  if (ni >= am.queue.length) { am.phase = 'last'; amSetStatus('最后一首'); return; }
  const inc = decks[1 - am.cur];
  am.loading = true;
  amSetStatus('准备下一首…');
  const ok = await loadSong(inc, am.queue[ni], { force: true });
  am.loading = false;
  if (!am.on) return;
  if (!ok) { am.queue.splice(ni, 1); saveQueue(); return amPrepareNext(); }
  inc.sync = false; inc.updateButtons();
  amResetAuto(inc);
  inc.setEq('lo', 0); inc.setFilter(0);
  am.tr = amPlan();
  am.phase = 'wait';
  if ($('#sheet').classList.contains('show')) renderSheet();
}

function amPlan() {
  const out = decks[am.cur];
  const bl = out.beatLen() || 0.5;
  let L = settings.am.beats * bl;
  const dur = out.duration;
  const end = Math.min(out.song.last || dur, dur);
  let s = end - L;
  if (out.bpm) s = out.t0 + Math.floor((s - out.t0) / (4 * bl)) * 4 * bl;
  const p = out.audio.pos();
  if (s < p + 1.5) { s = out.nextBar(p + 1.5); L = Math.max(4 * bl, Math.min(L, end - s)); }
  return { start: s, len: L, scheduled: false };
}

function amSkip() {
  if (!am.on) return;
  if (am.loading) { toast('下一首还在载入…'); return; }
  if (am.phase === 'last') { toast('已经是列表最后一首了'); return; }
  if (am.phase === 'wait' && am.tr && !am.tr.scheduled) {
    const out = decks[am.cur];
    const bl = out.beatLen() || 0.5;
    am.tr.start = out.nextBar(out.audio.pos() + 0.6);
    am.tr.len = Math.min(am.tr.len, 8 * bl);
    toast('下一个小节开始过渡');
  }
}

function amStyle() {
  const st = settings.am.style;
  if (st !== 'auto') return st;
  return (decks[0].isMulti || decks[1].isMulti) ? 'stems' : 'eq';
}

function amSchedule() {
  const out = decks[am.cur], inc = decks[1 - am.cur];
  const ctx = engine.ctx;
  let matched = false;
  if (settings.am.match && out.bpm && inc.bpm) {
    const r = bestRatio(out.curBpm() / inc.bpm);
    if (Math.abs(r - 1) <= 0.1) { inc.setTempo(r - 1, true); matched = true; } else inc.setTempo(0, true);
  } else inc.setTempo(0, true);
  am.tr.matched = matched;
  am.tr.style = amStyle();
  const outPlaying = out.audio.playing;
  let t;
  if (!outPlaying) { t = ctx.currentTime + 0.05; am.tr.immediate = true; }
  else {
    t = ctx.currentTime + (am.tr.start - out.audio.pos()) / out.rate();
    if (t < ctx.currentTime + 0.02) t = ctx.currentTime + 0.02;
  }
  const intro = matched ? inc.barIntro() : inc.introPoint();
  const delay = intro < 0 ? -intro / inc.rate() : 0;
  amApply(0);
  inc.audio.startAt(t + delay, Math.max(0, intro));
  inc.audio.rep.playing = true;
  am.tr.t = t; am.tr.scheduled = true;
  am.phase = 'trans';
}

// 过渡进度 p（0..1）→ 推子 / EQ / 分轨音量
function amApply(p) {
  const out = decks[am.cur], inc = decks[1 - am.cur];
  const style = am.tr.style || amStyle();
  const setA = (a) => mixer.setXf(am.cur === 0 ? a : 1 - a);  // a=0 只有当前，0.5 两边都满，1 只有下一首
  const bassSwap = () => { inc.setEq('lo', -1 + ramp(p, 0.45, 0.55)); out.setEq('lo', -ramp(p, 0.45, 0.55)); };
  if (style === 'fade') setA(p);
  else if (style === 'eq') { setA(p); bassSwap(); }
  else if (style === 'filter') { setA(p); out.setFilter(ramp(p, 0.3, 1) * 0.85); }
  else {
    // 分轨渐入：两边都开着，用每条分轨的音量做过渡
    setA(p < 0.85 ? 0.5 : 0.5 + ramp(p, 0.85, 1) * 0.5);
    for (const [d, isIn] of [[out, false], [inc, true]]) {
      if (d.isMulti) {
        d.stems.forEach((s, j) => {
          const role = (KIND_MAP[s.kind] && KIND_MAP[s.kind].role) || 'music';
          let g;
          if (isIn) g = role === 'drums' ? ramp(p, 0, 0.25) : role === 'inst' ? ramp(p, 0, 0.35) : role === 'bass' ? ramp(p, 0.45, 0.55) : role === 'vox' ? ramp(p, 0.7, 0.9) : ramp(p, 0.25, 0.6);
          else g = 1 - (role === 'vox' ? ramp(p, 0, 0.25) : role === 'music' ? ramp(p, 0.4, 0.75) : role === 'bass' ? ramp(p, 0.45, 0.55) : role === 'inst' ? ramp(p, 0.6, 0.95) : ramp(p, 0.75, 1));
          d.audio.chains[j].setAuto(g);
        });
      } else {
        d.audio.chains[0].setAuto(isIn ? ramp(p, 0, 0.5) : 1 - ramp(p, 0.5, 1));
        if (isIn) d.setEq('lo', -1 + ramp(p, 0.45, 0.55)); else d.setEq('lo', -ramp(p, 0.45, 0.55));
      }
    }
  }
}

function amFinish() {
  const out = decks[am.cur], inc = decks[1 - am.cur];
  out.pause();
  amResetAuto(out); amResetAuto(inc);
  out.setEq('lo', 0); out.setFilter(0); inc.setEq('lo', 0); inc.setFilter(0);
  mixer.setXf(am.cur === 0 ? 1 : 0);
  if (am.tr && am.tr.matched && Math.abs(inc.tempo) > 0.0005) am.glide = { deck: inc, from: inc.tempo, t: performance.now() };
  am.cur = 1 - am.cur; am.idx++;
  amPrepareNext();
}

let amLastStatus = 0;
function amTick() {
  if (!am.on || !engine) return;
  if (am.glide) {
    const f = (performance.now() - am.glide.t) / 14000;
    if (f >= 1) { am.glide.deck.setTempo(0, true); am.glide = null; }
    else am.glide.deck.setTempo(am.glide.from * (1 - f), true);
  }
  const out = decks[am.cur], inc = decks[1 - am.cur];
  if (!out.song) return;
  const p = out.audio.pos();
  if (am.phase === 'wait' && am.tr && !am.tr.scheduled) {
    const ended = !out.audio.playing && p >= out.duration - 0.3;
    if (ended || (out.audio.playing && p >= am.tr.start - 0.35 * out.rate())) amSchedule();
  } else if (am.phase === 'trans') {
    let prog = am.tr.immediate ? (engine.ctx.currentTime - am.tr.t) / 3 : (p - am.tr.start) / am.tr.len;
    prog = clamp(prog, 0, 1);
    amApply(prog);
    am.tr.prog = prog;
    if (prog >= 1 || (!out.audio.playing && !am.tr.immediate && engine.ctx.currentTime > am.tr.t + 0.3)) amFinish();
  } else if (am.phase === 'last') {
    if (!out.audio.playing && p >= out.duration - 0.5) { amStop('自动混音放完了'); return; }
  }
  const now = performance.now();
  if (now - amLastStatus > 250) {
    amLastStatus = now;
    if (am.phase === 'wait' && am.tr) {
      const left = (am.tr.start - p) / out.rate();
      const nx = songs.find((s) => s.id === am.queue[am.idx + 1]);
      amSetStatus(`自动混音中 · 下一首「${nx ? nx.title : ''}」${left > 0 ? ' · ' + fmtTime(left) + ' 后开始过渡' : ''}${out.audio.playing ? '' : '（当前唱盘已暂停）'}`);
    } else if (am.phase === 'trans') amSetStatus(`过渡中 ${Math.round((am.tr.prog || 0) * 100)}%`);
    else if (am.phase === 'last') amSetStatus('自动混音中 · 最后一首');
  }
}

// =====================================================================
// BPM / 节拍网格调整
// =====================================================================
let bpmDeck = null, taps = [];
function openBpmPop(d) {
  const pop = $('#bpmpop');
  if (bpmDeck === d && pop.classList.contains('show')) { pop.classList.remove('show'); bpmDeck = null; return; }
  if (!d.song) return;
  bpmDeck = d; taps = [];
  renderBpmPop();
  const r = d.el.bpmbox.getBoundingClientRect(), m = $('#main').getBoundingClientRect();
  let left = r.left - m.left + r.width / 2 - 140;
  left = clamp(left, 8, m.width - 288);
  pop.style.left = left + 'px'; pop.style.top = (r.bottom - m.top + 6) + 'px';
  pop.classList.add('show');
}
function renderBpmPop() {
  const d = bpmDeck; const pop = $('#bpmpop');
  pop.innerHTML = '';
  const btn = (label, fn) => { const b = h('button', { class: 'btn' }, label); b.onclick = fn; return b; };
  const change = (bpm, t0) => {
    if (bpm !== undefined) d.bpm = Math.max(0, Math.round(bpm * 100) / 100);
    if (t0 !== undefined) { const bar = 240 / (d.bpm || 120); d.t0 = ((t0 % bar) + bar) % bar; }
    d.song.bpm = d.bpm; d.song.t0 = d.t0;
    lib.putSong(d.song).then(() => { const s = songs.find((x) => x.id === d.song.id); if (s) { s.bpm = d.bpm; s.t0 = d.t0; } });
    if (d.sync) d.followSync(); else if (d.other.sync) d.other.followSync();
    d.lastTxt.bpm = null;
    renderBpmPop();
  };
  const bl = d.beatLen() || 0.5;
  const tap = btn('TAP', () => {
    const t = performance.now();
    if (taps.length && t - taps[taps.length - 1] > 2000) taps = [];
    taps.push(t); if (taps.length > 9) taps.shift();
    if (taps.length >= 4) { const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1); change(60000 / iv); }
    else { tap.textContent = `TAP ${taps.length}`; }
  });
  pop.append(h('div', { class: 'bt' }, h('span', {}, `唱盘 ${d.L} · 原速 ${d.bpm ? d.bpm.toFixed(2) : '—'} BPM`), btn('✕', () => { pop.classList.remove('show'); bpmDeck = null; })),
    h('div', { class: 'g' }, btn('÷2', () => change(d.bpm / 2)), btn('×2', () => change(d.bpm * 2)), btn('−0.1', () => change(d.bpm - 0.1)), btn('+0.1', () => change(d.bpm + 0.1)),
      btn('网格◀', () => change(undefined, d.t0 - 0.01)), btn('网格▶', () => change(undefined, d.t0 + 0.01)), btn('重拍◀', () => change(undefined, d.t0 - bl)), btn('重拍▶', () => change(undefined, d.t0 + bl))),
    h('div', { class: 'g', style: 'grid-template-columns:1fr' }, tap),
    h('div', { class: 'hint' }, '测得不准时在这里改，会自动保存到曲库。<br>「网格」把节拍线前后挪一点（10 毫秒）；「重拍」把小节第一拍挪一拍；TAP 跟着节奏连续点 4 下以上。'));
}

// =====================================================================
// 启动
// =====================================================================
let wakeLockObj = null;
async function wakeLock() {
  try { if (navigator.wakeLock && !wakeLockObj) { wakeLockObj = await navigator.wakeLock.request('screen'); wakeLockObj.addEventListener('release', () => (wakeLockObj = null)); } } catch (e) {}
}

function buildStatic() {
  decks = [new Deck(0), new Deck(1)];
  mixer = new Mixer();
  waves = new Waves();
  $('#btnLib').onclick = () => { if ($('#sheet').classList.contains('show') && sheetTab === 'lib') closeSheet(); else openSheet('lib'); };
  $('#sheetClose').onclick = closeSheet;
  for (const b of $$('#sheetTabs button')) b.onclick = () => openSheet(b.dataset.t, sheetTarget);
  $('#search').addEventListener('input', () => renderSheet());
  $('#fileIn').addEventListener('change', (e) => { const f = e.target.files; const arr = f ? [...f] : []; e.target.value = ''; if (arr.length) onFiles(arr); });
  $('#btnAm').onclick = () => (am.on ? amStop('已停止自动混音') : amStart());
  $('#btnAmNext').onclick = amSkip;
  $('#modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'modal') closeModal(null); });
  document.addEventListener('pointerdown', (e) => {
    const pop = $('#bpmpop');
    if (pop.classList.contains('show') && !pop.contains(e.target) && !e.target.closest('.bpmbox')) { pop.classList.remove('show'); bpmDeck = null; }
  });
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());
  // 拖文件进来也能导入（电脑上测试用）
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) { openSheet('lib'); onFiles([...e.dataTransfer.files]); } });
  amUpdateUi();
}

async function start() {
  const err = $('#startErr');
  err.textContent = '';
  try {
    if (!window.isSecureContext) throw new Error('需要用 https 网址打开（GitHub Pages 的网址就是 https）');
    if (!window.AudioWorkletNode) throw new Error('这个浏览器不支持 AudioWorklet，请用最新版 Safari');
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    engine = new Engine();
    await engine.init();
    if (engine.ctx.state !== 'running') await engine.ctx.resume();
    engine.setMaster(faderGain(mixer.master.value) * 1.25);
    decks.forEach((d, i) => d.attach(engine.decks[i]));
    mixer.setXf(0.5);
    $('#start').classList.add('hide');
    window.addEventListener('resize', () => { for (const d of decks) d.ovDirty = true; });
    engine.ctx.addEventListener('statechange', checkCtx);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkCtx(); if (decks.some((d) => d.audio && d.audio.playing)) wakeLock(); } });
    $('#resume button').onclick = async () => { try { await engine.ctx.resume(); } catch (e) {} checkCtx(); };
    requestAnimationFrame(loop);
    setInterval(amTick, 30);
    await refreshSongs();
    if (!songs.length) openSheet('lib');
    if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  } catch (e) {
    console.error(e);
    err.textContent = '启动失败：' + (e.message || e);
  }
}
function checkCtx() {
  if (!engine) return;
  $('#resume').classList.toggle('show', engine.ctx.state !== 'running' && !document.hidden);
}

let frameN = 0, lastFrameT = 0;
function loop(t) {
  requestAnimationFrame(loop);
  // 高刷屏上限制到 60 帧左右，省电
  if (t - lastFrameT < 14) return;
  lastFrameT = t;
  const now = engine.ctx.currentTime;
  for (const d of decks) d.frame(now);
  waves.draw();
  if ((frameN++ & 1) === 0) { mixer.meters(); for (const d of decks) d.meters(); }
}

buildStatic();
$('#startBtn').onclick = start;
window.__dj = { decks: () => decks, engine: () => engine, am, lib, settings, loadSong, onFiles, amStart, amSkip, refreshSongs };
