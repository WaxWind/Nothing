// 通用界面控件：旋钮、推子、按钮、弹窗、提示
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// 双击检测
function dbl(state) {
  const t = performance.now();
  const r = t - (state.last || 0) < 320;
  state.last = r ? 0 : t;
  return r;
}

function polar(a, r = 19, c = 24) { const rad = (a - 90) * Math.PI / 180; return [c + r * Math.cos(rad), c + r * Math.sin(rad)]; }
function arcPath(a0, a1) {
  if (Math.abs(a1 - a0) < 0.8) return '';
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const [x0, y0] = polar(lo), [x1, y1] = polar(hi);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A19 19 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export class Knob {
  constructor({ label = '', value = 0, def = 0, min = -1, max = 1, bipolar = true, onChange, cls = '' }) {
    Object.assign(this, { value, def, min, max, bipolar, onChange });
    this.el = h('div', { class: 'knob ' + cls });
    let ticks = '';
    for (let a = -135; a <= 135; a += 27) {
      const c = a === 0 || (!bipolar && a === -135);
      const r0 = c ? 21 : 22.6, r1 = 24.6;
      const p0 = polar(a, r0, 25), p1 = polar(a, r1, 25);
      ticks += `<line${c ? ' class="c"' : ''} x1="${p0[0].toFixed(2)}" y1="${p0[1].toFixed(2)}" x2="${p1[0].toFixed(2)}" y2="${p1[1].toFixed(2)}"/>`;
    }
    this.el.innerHTML = `<div class="kbody"><svg class="kscale" viewBox="0 0 50 50">${ticks}</svg><div class="kcap"><i class="kline"></i></div></div>` + (label ? `<span class="klab">${label}</span>` : '');
    this.cap = this.el.querySelector('.kcap');
    const st = {};
    let sy = 0, sv = 0, id = null;
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (dbl(st)) { this.set(this.def, true); return; }
      id = e.pointerId; sy = e.clientY; sv = this.value;
      try { this.el.setPointerCapture(id); } catch (_) {}
      this.el.classList.add('active');
    });
    this.el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const v = clamp(sv + (sy - e.clientY) / 170 * (this.max - this.min), this.min, this.max);
      this.set(v, true);
    });
    const up = (e) => { if (e.pointerId === id) { id = null; this.el.classList.remove('active'); } };
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
    this.draw();
  }
  set(v, emit = false) {
    v = clamp(v, this.min, this.max);
    // 在中间附近吸附
    if (this.bipolar && Math.abs(v - (this.min + this.max) / 2) < (this.max - this.min) * 0.012) v = (this.min + this.max) / 2;
    if (v === this.value && !emit) { this.draw(); return; }
    this.value = v; this.draw();
    if (emit && this.onChange) this.onChange(v);
  }
  draw() {
    const a = -135 + (this.value - this.min) / (this.max - this.min) * 270;
    this.cap.style.transform = `rotate(${a.toFixed(1)}deg)`;
    this.el.classList.toggle('off-center', this.bipolar && Math.abs(this.value - this.def) > 0.001);
  }
}

export class Fader {
  constructor({ orient = 'v', value = 0.8, def = 0.8, min = 0, max = 1, onChange, cls = '', center = false, caps = 24, sens = 1 }) {
    Object.assign(this, { orient, value, def, min, max, onChange, caps, sens });
    this.el = h('div', { class: `fader ${orient} ${cls}`, style: `--cap:${caps}px` },
      h('div', { class: 'fscale' }), center ? h('div', { class: 'fcenter' }) : null, h('div', { class: 'ftrack' }), h('div', { class: 'ffill' }), h('div', { class: 'fcap' }));
    this.cap = this.el.querySelector('.fcap');
    this.span = 0;
    // 推子帽用 transform 移动（显卡合成，不触发重新排版，拖动更顺）
    if (window.ResizeObserver) {
      new ResizeObserver(() => { this.measure(); this.draw(); }).observe(this.el);
    }
    const st = {};
    let s0 = 0, v0 = 0, id = null, span = 1;
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (dbl(st)) { this.set(this.def, true); return; }
      id = e.pointerId;
      const r = this.el.getBoundingClientRect();
      span = Math.max(20, (this.orient === 'v' ? r.height : r.width) - this.caps);
      this.span = span;
      s0 = this.orient === 'v' ? e.clientY : e.clientX; v0 = this.value;
      try { this.el.setPointerCapture(id); } catch (_) {}
      this.el.classList.add('active');
    });
    this.el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const d = this.orient === 'v' ? (s0 - e.clientY) : (e.clientX - s0);
      this.set(v0 + d / span * (this.max - this.min) * this.sens, true);
    });
    const up = (e) => { if (e.pointerId === id) { id = null; this.el.classList.remove('active'); } };
    this.el.addEventListener('pointerup', up);
    this.el.addEventListener('pointercancel', up);
    this.draw();
  }
  set(v, emit = false) {
    v = clamp(v, this.min, this.max);
    if (v === this.value && !emit) { this.draw(); return; }
    this.value = v; this.draw();
    if (emit && this.onChange) this.onChange(v);
  }
  measure() {
    const sz = this.orient === 'v' ? this.el.clientHeight : this.el.clientWidth;
    if (sz > 0) this.span = Math.max(0, sz - this.caps);
  }
  draw() {
    const p = (this.value - this.min) / (this.max - this.min);
    if (!this.span) this.measure();
    const px = this.orient === 'v' ? (1 - p) * this.span : p * this.span;
    this.cap.style.transform = this.orient === 'v' ? `translate3d(0,${px.toFixed(2)}px,0)` : `translate3d(${px.toFixed(2)}px,0,0)`;
  }
}

// ---------- 弹窗 ----------
let modalResolve = null;
export function modal({ title = '', body = '', buttons = [{ label: '好', value: true, primary: true }], wide = false }) {
  const root = $('#modal');
  const box = $('#modal .mbox');
  box.className = 'mbox' + (wide ? ' wide' : '');
  box.innerHTML = '';
  box.append(h('div', { class: 'mtitle' }, title));
  const b = h('div', { class: 'mbody' });
  if (typeof body === 'string') b.innerHTML = body; else b.append(body);
  box.append(b);
  const row = h('div', { class: 'mbtns' });
  return new Promise((resolve) => {
    modalResolve = resolve;
    for (const bt of buttons) {
      row.append(h('button', { class: 'btn' + (bt.primary ? ' primary' : '') + (bt.danger ? ' danger' : ''), onclick: () => close(typeof bt.value === 'function' ? bt.value() : bt.value) }, bt.label));
    }
    box.append(row);
    root.classList.add('show');
  });
}
export function close(v) {
  $('#modal').classList.remove('show');
  if (modalResolve) { const r = modalResolve; modalResolve = null; r(v); }
}
export async function confirmBox(title, text, okLabel = '确定', danger = false) {
  return await modal({ title, body: `<p>${text}</p>`, buttons: [{ label: '取消', value: false }, { label: okLabel, value: true, primary: !danger, danger }] });
}
export async function promptBox(title, value = '') {
  const inp = h('input', { class: 'tin', value });
  const p = modal({ title, body: inp, buttons: [{ label: '取消', value: null }, { label: '确定', value: () => inp.value, primary: true }] });
  setTimeout(() => { inp.focus(); inp.select(); }, 50);
  return await p;
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  if (ms > 0) toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
export function hideToast() { $('#toast').classList.remove('show'); }

export function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
