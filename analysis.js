// 分析模块：文件名识别分轨、分组成歌曲、测 BPM/节拍网格、生成波形数据
// 纯计算，不依赖页面，方便单独测试

export const WAVE_RATE = 150; // 波形数据每秒多少个点

// ---------- 分轨种类 ----------
export const STEM_KINDS = [
  { kind: 'vocals', label: '人声', color: '#ff4f8b', role: 'vox', words: ['lead vocals', 'lead vocal', 'leadvocals', 'vocals', 'vocal', 'vox', 'voice', 'voices', 'acapella', 'a cappella', 'singing', '人声', '主唱', '歌声', 'ボーカル', 'ヴォーカル'] },
  { kind: 'backing', label: '和声', color: '#ff9ec0', role: 'vox', words: ['backing vocals', 'backing vocal', 'backing', 'bvox', 'harmony', '和声', '伴唱', 'コーラス'] },
  { kind: 'drums', label: '鼓', color: '#ffcf33', role: 'drums', words: ['drums', 'drum', 'drumkit', '鼓', '鼓组', '架子鼓', 'ドラム'] },
  { kind: 'perc', label: '打击乐', color: '#ff9f2e', role: 'drums', words: ['percussion', 'perc', '打击乐', 'パーカッション'] },
  { kind: 'bass', label: '贝斯', color: '#8a5cff', role: 'bass', words: ['bass', 'bassline', '贝斯', '低音', 'ベース'] },
  { kind: 'guitar', label: '吉他', color: '#35d88f', role: 'music', words: ['guitars', 'guitar', 'gtr', '吉他', 'ギター'] },
  { kind: 'piano', label: '钢琴', color: '#3fb8ff', role: 'music', words: ['piano', 'keys', 'keyboards', 'keyboard', '钢琴', '键盘', 'ピアノ'] },
  { kind: 'synth', label: '合成器', color: '#c08bff', role: 'music', words: ['synths', 'synth', 'synthesizer', '合成器', 'シンセ'] },
  { kind: 'strings', label: '弦乐', color: '#ff8a65', role: 'music', words: ['strings', '弦乐', 'ストリングス'] },
  { kind: 'wind', label: '管乐', color: '#ffc178', role: 'music', words: ['brass', 'horns', 'woodwinds', 'woodwind', '管乐', '铜管', '木管'] },
  { kind: 'fx', label: '音效', color: '#9be15d', role: 'music', words: ['sfx', 'fx', 'effects', '音效'] },
  { kind: 'custom', label: '', color: '#6fd0ff', role: 'music', words: [] },
  { kind: 'other', label: '其他', color: '#9aa3b5', role: 'music', words: ['others', 'other', 'rest', 'residual', 'misc', '其他', '其它', 'その他'] },
  { kind: 'inst', label: '伴奏', color: '#2fd3c4', role: 'inst', words: ['instrumentals', 'instrumental', 'instrum', 'inst', 'accompaniment', 'no vocals', 'novocals', 'karaoke', 'minus one', 'off vocal', 'offvocal', 'backing track', '伴奏', '纯音乐', 'オフボーカル', 'カラオケ'] },
];
export const KIND_MAP = Object.fromEntries(STEM_KINDS.map((k, i) => [k.kind, { ...k, order: i }]));
const CUSTOM_COLORS = ['#6fd0ff', '#f78fff', '#ffd98f', '#8fffcf', '#ffa28f', '#b5b8ff'];

const SEP = "[\\s_\\-.()\\[\\]（）【】「」『』~～·・,，+=#]";
const SEP_RE = new RegExp(SEP, 'u');
const isCJK = (w) => /[぀-ヿ㐀-鿿]/.test(w);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// 所有关键词，按长度从长到短
const ALL_WORDS = [];
for (const k of STEM_KINDS) for (const w of k.words) ALL_WORDS.push({ w, kind: k.kind });
ALL_WORDS.sort((a, b) => b.w.length - a.w.length);
const WORD_RES = ALL_WORDS.map(({ w, kind }) => {
  const body = escapeRe(w).replace(/ /g, '[\\s_\\-]*');
  const re = isCJK(w) ? new RegExp(body, 'giu') : new RegExp(`(?<=^|${SEP})${body}(?=$|${SEP}|\\d)`, 'giu');
  return { re, kind, w };
});

export function stripExt(name) { return name.replace(/\.[a-z0-9]{2,5}$/i, ''); }
export function cleanTitle(s) {
  s = s.replace(/^\s*\d{1,3}\s*[._\-\s]\s*/, '');                 // 去掉开头的编号 01_ / 01 - / 01.
  s = s.replace(/[\s_\-~～.·・,，+=#(（\[【「『]+$/u, '');          // 去掉结尾的分隔符和没闭合的左括号
  s = s.replace(/^[\s_\-~～.·・,，+=#)）\]】」』]+/u, '');          // 去掉开头的分隔符
  return s.trim();
}
const normKey = (s) => s.toLowerCase().replace(/[\s_]+/g, ' ').trim();

// 识别一个文件名里的分轨信息
export function parseStemName(filename) {
  const base = stripExt(filename);
  let best = null;
  for (const { re, kind } of WORD_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(base))) {
      const start = m.index, end = m.index + m[0].length;
      if (!best || end > best.end || (end === best.end && start < best.start)) best = { start, end, kind };
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  if (best) {
    // 匹配后面剩下的尾巴必须很短（比如模型名 _MDX、(UVR)），否则当作歌名里恰好出现的词
    const tail = base.slice(best.end);
    if (tail.replace(new RegExp(SEP, 'gu'), '').length > 24) best = null;
  }
  if (!best) return { base, stem: null, key: normKey(cleanTitle(base) || base), title: cleanTitle(base) || base };
  const head = base.slice(0, best.start);
  const title = cleanTitle(head);
  return { base, stem: best.kind, key: normKey(title), title };
}

// 把一批文件分组成歌曲
// 返回 [{title, type:'single'|'multi', items:[{file, kind, label, color}]}]
export function groupFiles(files) {
  const parsed = files.map((file) => ({ file, ...parseStemName(file.name) }));
  const groups = new Map();
  const singles = [];
  for (const p of parsed) {
    if (!p.stem) { singles.push(p); continue; }
    if (!groups.has(p.key)) groups.set(p.key, { title: p.title, items: [] });
    groups.get(p.key).items.push(p);
  }
  // 认不出种类的文件：如果开头和某首多轨歌一样，就当这首歌的一条自定义分轨
  const rest = [];
  for (const p of singles) {
    const t = normKey(cleanTitle(p.base));
    let attached = false;
    for (const [k, g] of groups) {
      if (k && t.startsWith(k) && t.length > k.length) {
        const label = cleanTitle(cleanTitle(p.base).slice(g.title.length)) || p.base;
        if (label.length <= 24) { g.items.push({ ...p, stem: 'custom', customLabel: label }); attached = true; break; }
      }
    }
    if (!attached) rest.push(p);
  }
  // 剩下的：按最后一个下划线前面的部分分组，两个以上同名开头的当成多轨
  const byPrefix = new Map();
  for (const p of rest) {
    const i = p.base.lastIndexOf('_');
    if (i > 0 && i < p.base.length - 1) {
      const k = normKey(cleanTitle(p.base.slice(0, i)));
      if (!byPrefix.has(k)) byPrefix.set(k, []);
      byPrefix.get(k).push(p);
    } else {
      byPrefix.set('\u0000' + p.base + Math.random(), [p]);
    }
  }
  const out = [];
  for (const [k, arr] of byPrefix) {
    if (arr.length >= 2 && !k.startsWith('\u0000')) {
      const title = cleanTitle(arr[0].base.slice(0, arr[0].base.lastIndexOf('_')));
      if (!groups.has(k)) groups.set(k, { title, items: [] });
      for (const p of arr) groups.get(k).items.push({ ...p, stem: 'custom', customLabel: cleanTitle(p.base.slice(p.base.lastIndexOf('_') + 1)) });
    } else {
      for (const p of arr) out.push({ title: cleanTitle(p.base) || p.base, type: 'single', items: [{ file: p.file, kind: 'mix', label: '整轨', color: '#5fd4ff' }] });
    }
  }
  for (const [, g] of groups) {
    if (g.items.length === 1) {
      // 只有一个文件：当普通歌曲
      const p = g.items[0];
      out.push({ title: cleanTitle(p.base) || p.base, type: 'single', items: [{ file: p.file, kind: 'mix', label: '整轨', color: '#5fd4ff' }] });
      continue;
    }
    g.items.sort((a, b) => (KIND_MAP[a.stem].order - KIND_MAP[b.stem].order) || a.base.localeCompare(b.base));
    const used = {};
    let ci = 0;
    const items = g.items.map((p) => {
      const k = KIND_MAP[p.stem];
      let label = p.stem === 'custom' ? (p.customLabel || '分轨') : k.label;
      const color = p.stem === 'custom' ? CUSTOM_COLORS[ci++ % CUSTOM_COLORS.length] : k.color;
      used[label] = (used[label] || 0) + 1;
      if (used[label] > 1) label += ' ' + used[label];
      return { file: p.file, kind: p.stem, label, color };
    });
    out.push({ title: g.title || '未命名歌曲', type: 'multi', items });
  }
  return out;
}

// 根据分轨组合给出模式名
export function modeName(stems) {
  if (!stems || stems.length <= 1) return '单曲';
  const kinds = new Set(stems.map((s) => s.kind));
  const n = stems.length;
  const has = (...k) => k.every((x) => kinds.has(x));
  if (n === 2 && has('vocals', 'inst')) return '2轨模式 · 人声+伴奏';
  if (n === 4 && has('vocals', 'drums', 'bass', 'other')) return '4轨模式';
  if (n === 5 && has('vocals', 'drums', 'bass', 'piano', 'other')) return '5轨模式';
  if (n === 6 && has('vocals', 'drums', 'bass', 'guitar', 'piano', 'other')) return '6轨模式';
  return `${n}轨模式`;
}

// ---------- 节奏分析 ----------
function onsetEnvelope(x, sr) {
  const hop = Math.max(1, Math.round(sr / 200));
  const fr = sr / hop;
  const N = Math.floor(x.length / hop);
  const aL = Math.exp(-2 * Math.PI * 150 / sr), aH = Math.exp(-2 * Math.PI * 2500 / sr);
  let lp = 0, lp2 = 0, lpb = 0;
  const eL = new Float32Array(N), eH = new Float32Array(N), eA = new Float32Array(N);
  let meanA = 0;
  for (let i = 0; i < N; i++) {
    let sl = 0, sh = 0, sa = 0;
    const b = i * hop;
    for (let j = 0; j < hop; j++) {
      const v = x[b + j];
      lp = v + (lp - v) * aL; lpb = lp + (lpb - lp) * aL; lp2 = v + (lp2 - v) * aH;
      const h = v - lp2;
      sl += lpb * lpb; sh += h * h; sa += v * v;
    }
    eL[i] = sl; eH[i] = sh; eA[i] = sa; meanA += sa;
  }
  meanA = meanA / Math.max(1, N) + 1e-12;
  let mL = 0, mH = 0; for (let i = 0; i < N; i++) { mL += eL[i]; mH += eH[i]; }
  mL = mL / Math.max(1, N) + 1e-12; mH = mH / Math.max(1, N) + 1e-12;
  const O = new Float32Array(N), Olow = new Float32Array(N);
  let pl = 0, ph = 0, pa = 0;
  for (let i = 0; i < N; i++) {
    const l = Math.log1p(eL[i] / mL * 20), h = Math.log1p(eH[i] / mH * 20), a = Math.log1p(eA[i] / meanA * 20);
    if (i > 0) {
      const dl = Math.max(0, l - pl), dh = Math.max(0, h - ph), da = Math.max(0, a - pa);
      O[i] = dl + 0.7 * dh + 0.5 * da; Olow[i] = dl;
    }
    pl = l; ph = h; pa = a;
  }
  // 减去局部平均，突出起音
  const W = Math.round(fr * 0.2);
  const out = new Float32Array(N);
  let acc = 0;
  const cs = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) { acc += O[i]; cs[i + 1] = acc; }
  for (let i = 0; i < N; i++) {
    const a = Math.max(0, i - W), b = Math.min(N, i + W + 1);
    const avg = (cs[b] - cs[a]) / (b - a);
    out[i] = Math.max(0, O[i] - avg);
  }
  // 轻微平滑
  const sm = new Float32Array(N);
  for (let i = 1; i < N - 1; i++) sm[i] = 0.25 * out[i - 1] + 0.5 * out[i] + 0.25 * out[i + 1];
  return { O: sm, Olow, fr, hop };
}

function combScore(O, p, step, interp) {
  // 对周期 p（帧），找最佳相位，返回 {score, phase}
  const N = O.length;
  let best = -1, bestPh = 0;
  for (let ph = 0; ph < p; ph += step) {
    let s = 0, c = 0;
    for (let t = ph; t < N - 1; t += p) {
      if (interp) { const i = t | 0, f = t - i; s += O[i] + (O[i + 1] - O[i]) * f; }
      else s += O[Math.round(t)];
      c++;
    }
    s /= Math.max(1, c);
    if (s > best) { best = s; bestPh = ph; }
  }
  return { score: best, phase: bestPh };
}

// 输入单声道音频，输出 {bpm, t0}，t0 是一个小节第一拍（重拍）的时间（秒）
export function analyzeRhythm(x, sr, opts = {}) {
  const lo = opts.min || 70, hi = opts.max || 180;
  // 太长的歌只用中间 6 分钟
  let data = x;
  const maxLen = sr * 360;
  let offsetSamples = 0;
  if (x.length > maxLen) { offsetSamples = Math.floor((x.length - maxLen) / 2); data = x.subarray(offsetSamples, offsetSamples + maxLen); }
  const { O, Olow, fr, hop } = onsetEnvelope(data, sr);
  if (O.length < fr * 4) return { bpm: 0, t0: 0 };
  let total = 0; for (let i = 0; i < O.length; i++) total += O[i];
  if (total < 1e-6) return { bpm: 0, t0: 0 };

  // 粗搜
  const scores = [];
  for (let b = lo; b <= hi; b += 0.5) {
    const p = fr * 60 / b;
    const { score } = combScore(O, p, 1, false);
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(b / 125) / 0.9, 2));
    scores.push({ b, s: score * prior, raw: score });
  }
  scores.sort((a, b) => b.s - a.s);
  let b0 = scores[0].b;
  // 快歌常被测成一半：如果两倍速度的节拍也几乎一样强，说明中间那些拍也是真拍
  if (b0 * 2 <= hi + 0.01) {
    const r1 = combScore(O, fr * 60 / b0, 1, false).score;
    const r2 = combScore(O, fr * 60 / (b0 * 2), 1, false).score;
    if (opts.debug) console.log('double check', b0, r2 / r1);
    if (r2 > r1 * 0.72) b0 = b0 * 2;
  }
  // 细搜
  let bestB = b0, bestS = -1, bestPh = 0;
  for (let b = b0 - 0.6; b <= b0 + 0.6; b += 0.02) {
    const p = fr * 60 / b;
    const r = combScore(O, p, 0.5, true);
    if (r.score > bestS) { bestS = r.score; bestB = b; bestPh = r.phase; }
  }
  // 接近整数就取整
  let bpm = bestB;
  if (Math.abs(bpm - Math.round(bpm)) < 0.06) {
    const br = Math.round(bpm);
    const r = combScore(O, fr * 60 / br, 0.5, true);
    if (r.score >= bestS * 0.97) { bpm = br; bestPh = r.phase; }
  }
  const p = fr * 60 / bpm;
  // 找重拍：低频起音最强的那一组（每 4 拍）
  const sums = [0, 0, 0, 0];
  let k = 0;
  for (let t = bestPh; t < Olow.length - 1; t += p, k++) {
    const i = Math.round(t);
    sums[k & 3] += Olow[i] + 0.5 * O[i];
  }
  let m = 0; for (let j = 1; j < 4; j++) if (sums[j] > sums[m]) m = j;
  const beatSec = 60 / bpm, barSec = beatSec * 4;
  let t0 = (bestPh + m * p) / fr + offsetSamples / sr;
  t0 = ((t0 % barSec) + barSec) % barSec;
  return { bpm: Math.round(bpm * 100) / 100, t0 };
}

// ---------- 波形 ----------
// 每条分轨：每个点取峰值（浮点，之后统一归一化）
export function stemPeaks(channels, sr) {
  const hop = sr / WAVE_RATE;
  const len = channels[0].length;
  const N = Math.ceil(len / hop);
  const out = new Float32Array(N);
  const L = channels[0], R = channels[1] || channels[0];
  for (let i = 0; i < N; i++) {
    const a = Math.floor(i * hop), b = Math.min(len, Math.floor((i + 1) * hop));
    let m = 0;
    for (let j = a; j < b; j++) { const v = Math.abs(L[j]) > Math.abs(R[j]) ? Math.abs(L[j]) : Math.abs(R[j]); if (v > m) m = v; }
    out[i] = m;
  }
  return out;
}

// 整轨：分成低/中/高三个频段的峰值
export function bandPeaks(channels, sr) {
  const hop = sr / WAVE_RATE;
  const len = channels[0].length;
  const N = Math.ceil(len / hop);
  const low = new Float32Array(N), mid = new Float32Array(N), high = new Float32Array(N);
  const L = channels[0], R = channels[1] || channels[0];
  const a1 = Math.exp(-2 * Math.PI * 220 / sr), a2 = Math.exp(-2 * Math.PI * 2200 / sr);
  let l1 = 0, l1b = 0, l2 = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.floor(i * hop), b = Math.min(len, Math.floor((i + 1) * hop));
    let ml = 0, mm = 0, mh = 0;
    for (let j = a; j < b; j++) {
      const v = (L[j] + R[j]) * 0.5;
      l1 = v + (l1 - v) * a1; l1b = l1 + (l1b - l1) * a1; l2 = v + (l2 - v) * a2;
      const lo = Math.abs(l1b), mi = Math.abs(l2 - l1b), hi = Math.abs(v - l2);
      if (lo > ml) ml = lo; if (mi > mm) mm = mi; if (hi > mh) mh = hi;
    }
    low[i] = ml; mid[i] = mm; high[i] = mh;
  }
  return { low, mid, high };
}

// 浮点峰值 → 0..255（开方压缩，让小声的部分也看得见）
export function toBytes(arrs) {
  let g = 1e-9;
  for (const a of arrs) for (let i = 0; i < a.length; i++) if (a[i] > g) g = a[i];
  return arrs.map((a) => {
    const o = new Uint8Array(a.length);
    for (let i = 0; i < a.length; i++) o[i] = Math.min(255, Math.round(Math.sqrt(a[i] / g) * 255));
    return o;
  });
}

// 有声音的开始/结束时间（秒）
export function audibleRange(arrs) {
  const N = Math.max(...arrs.map((a) => a.length));
  const sum = new Float32Array(N);
  for (const a of arrs) for (let i = 0; i < a.length; i++) sum[i] = Math.max(sum[i], a[i]);
  let mx = 0; for (let i = 0; i < N; i++) if (sum[i] > mx) mx = sum[i];
  const th = mx * 0.06; // 字节值是开方后的，0.06 ≈ -49dB
  let a = 0, b = N - 1;
  while (a < N && sum[a] < th) a++;
  while (b > a && sum[b] < th) b--;
  return { first: a / WAVE_RATE, last: (b + 1) / WAVE_RATE };
}

export function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${ss.toString().padStart(2, '0')}`;
}
