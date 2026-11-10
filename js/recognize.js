// 手書き文字認識
// Google 手書き入力（Input Tools）の認識エンドポイントを利用します。
// ネットワークに接続できない場合は呼び出し側で自己採点に切り替えます。
const ENDPOINTS = [
  'https://inputtools.google.com/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8',
  'https://www.google.com/inputtools/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8',
];
let endpointIdx = 0;
let downUntil = 0;

export function isDown() {
  return Date.now() < downUntil;
}

async function requestOnce(ink, w, h, language, timeoutMs, markDown = true) {
  let lastErr;
  for (let k = 0; k < ENDPOINTS.length; k++) {
    const idx = (endpointIdx + k) % ENDPOINTS.length;
    try {
      const out = await requestEndpoint(ENDPOINTS[idx], ink, w, h, language, timeoutMs);
      endpointIdx = idx;
      downUntil = 0;
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  // しばらくは問い合わせずに自己採点にする
  if (markDown) downUntil = Date.now() + 60000;
  throw lastErr;
}

// Apple Pencil は1秒に約240回座標を送るため、ゆっくり書くと1字で数千点になる。
// 細かすぎる点と1px単位の揺れがあると、認識サービスが字の右側や後半を無視して
// 左の部品だけで判断してしまう（護 →「言」、砂 →「石」、八 →「ル」など）。
// 送る前に、点と点の間が枠の大きさの1%以上になるよう間引く（各画の最初と最後の点は残す）。
export function simplifyInk(ink, w, h) {
  const d = Math.max(2.5, Math.min(w || 0, h || 0) * 0.01);
  return ink.map(([xs, ys, ts]) => {
    const X = [xs[0]], Y = [ys[0]], T = [ts[0]];
    for (let i = 1; i < xs.length; i++) {
      const k = X.length - 1;
      if (i === xs.length - 1 || Math.hypot(xs[i] - X[k], ys[i] - Y[k]) >= d) {
        X.push(xs[i]); Y.push(ys[i]); T.push(ts[i]);
      }
    }
    return [X, Y, T];
  });
}

async function requestEndpoint(url, ink, w, h, language, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        options: 'enable_pre_space',
        requests: [{
          writing_guide: { writing_area_width: Math.round(w), writing_area_height: Math.round(h) },
          ink: simplifyInk(ink, w, h),
          language,
          max_num_results: 10,
          max_completions: 0,
        }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || data[0] !== 'SUCCESS') throw new Error('認識に失敗しました');
    const cands = (data[1] && data[1][0] && data[1][0][1]) || [];
    return cands.map((c) => String(c).trim()).filter(Boolean);
  } finally {
    clearTimeout(timer);
  }
}

// ---- 1字が2字に分かれて読まれたときの読み直し ----
// 部品の間が大きく空いていたり、字全体が縦長・横長だったりすると、認識サービスが
// 1つの字を2字と判断することがある（例: 響 → 「郷音」、好 → 「女子」）。
// そのときは、部品の間の何も書かれていない帯を詰め、縦横比を正方形に近づけたインクで読み直す。
const BINS = 64;
const GAP_MIN = 0.05;   // 字の幅（高さ）の5%以上の空白を「部品の間の隙間」とみなす
const GAP_KEEP = 0.03;  // 詰めたあとに残す隙間
const ASPECT = 1.12;    // これより縦長・横長なら正方形に近づける

function bounds(ink) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [xs, ys] of ink) {
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] < x0) x0 = xs[i];
      if (xs[i] > x1) x1 = xs[i];
      if (ys[i] < y0) y0 = ys[i];
      if (ys[i] > y1) y1 = ys[i];
    }
  }
  return { x0, y0, x1, y1 };
}

// axis 方向に投影したとき、字の中ほど（15%〜85%）にある最も広い空白の帯
function findGap(ink, axis) {
  const b = bounds(ink);
  const lo = axis ? b.y0 : b.x0;
  const span = Math.max(1, axis ? b.y1 - b.y0 : b.x1 - b.x0);
  const cov = new Uint8Array(BINS);
  const bin = (v) => Math.floor(((v - lo) / span) * (BINS - 1));
  for (const s of ink) {
    const v = s[axis];
    for (let i = 0; i < v.length; i++) {
      const p = v[i], q = i + 1 < v.length ? v[i + 1] : v[i];
      for (let k = bin(Math.min(p, q)), e = bin(Math.max(p, q)); k <= e; k++) cov[k] = 1;
    }
  }
  let best = null;
  for (let k = Math.floor(BINS * 0.15), end = Math.floor(BINS * 0.85); k < end;) {
    if (cov[k]) { k++; continue; }
    let j = k;
    while (j < BINS && !cov[j]) j++;
    if (!best || j - k > best[1] - best[0]) best = [k, j];
    k = j;
  }
  if (!best || (best[1] - best[0]) / BINS < GAP_MIN) return null;
  return { a: lo + (best[0] / (BINS - 1)) * span, b: lo + (best[1] / (BINS - 1)) * span, span };
}

function closeGap(ink, axis) {
  const g = findGap(ink, axis);
  if (!g) return null;
  const shift = g.b - g.a - GAP_KEEP * g.span;
  return ink.map((s) => {
    const t = [s[0], s[1], s[2]];
    t[axis] = s[axis].map((v) => (v >= g.b ? v - shift : v));
    return t;
  });
}

function transform(ink, w, h, sx, sy) {
  const b = bounds(ink);
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  return ink.map(([xs, ys, ts]) => [
    xs.map((x) => Math.round(w / 2 + (x - cx) * sx)),
    ys.map((y) => Math.round(h / 2 + (y - cy) * sy)),
    ts,
  ]);
}

/** 隙間を詰めて正方形に近づけたインク。手を加える必要がなければ null */
export function normalizeInk(ink, w, h) {
  if (!ink || !ink.length) return null;
  let cur = ink;
  let changed = false;
  for (let n = 0; n < 4; n++) {
    let moved = false;
    for (const axis of [0, 1]) {
      const v = closeGap(cur, axis);
      if (v) { cur = v; moved = changed = true; }
    }
    if (!moved) break;
  }
  const b = bounds(cur);
  const bw = Math.max(1, b.x1 - b.x0), bh = Math.max(1, b.y1 - b.y0);
  let sx = 1, sy = 1;
  if (bh / bw > ASPECT) sy = bw / bh;
  else if (bw / bh > ASPECT) sx = bh / bw;
  if (!changed && sx === 1 && sy === 1) return null;
  return transform(cur, w, h, sx, sy);
}

// 漢字と形が同じカタカナ・記号（枠には漢字を書くので漢字として扱う）
const LOOKALIKE = {
  'ニ': '二', 'ロ': '口', 'カ': '力', 'エ': '工', 'タ': '夕', 'ハ': '八', 'ト': '卜',
  'ヒ': '匕', 'ノ': '丿', 'ム': '厶', 'メ': '乂',
  'ー': '一', '－': '一', '-': '一', '―': '一', '—': '一', '‐': '一', '─': '一',
};

// 認識結果（文字列の候補）→ 1字の候補の一覧
// 2字以上の候補は「字が分かれて読まれた」ものなので、先頭の字を1字の候補より後ろに置く
function chars(raw) {
  const out = [];
  const add = (c) => {
    const k = LOOKALIKE[c] || c;
    if (!out.includes(k)) out.push(k);
  };
  for (const c of raw) if (Array.from(c).length === 1) add(c);
  for (const c of raw) {
    const ch = Array.from(c)[0];
    if (ch) add(ch);
  }
  // 枠に入るのは漢字だけなので、カタカナ・ひらがな・記号の候補は漢字の候補より後ろに回す（八 →「ル」など）
  return out.filter(isKanji).concat(out.filter((c) => !isKanji(c)));
}

function isKanji(c) {
  return /^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff々〆]$|^[\u{20000}-\u{3134f}]$/u.test(c);
}

const isSplit = (raw) => raw.slice(0, 2).some((c) => Array.from(c).length > 1);

/**
 * @returns {Promise<string[]>} 認識候補（確からしい順）
 * @param {boolean} rare 難読字なら中国語（繁体字）モデルの候補も併用する
 * @param {number} strokes 正解の字の画数（読み直しで別の字を正解にしないための目安）
 */
export async function recognize(ink, w, h, { target = null, rare = false, strokes = 0, timeoutMs = 6000 } = {}) {
  const raw = await requestOnce(ink, w, h, 'ja', timeoutMs);
  // 認識サービスの生の結果（認識ミスの記録用）
  const info = { raw: raw.slice(0, 8) };
  const done = (list) => Object.assign(list, { info });
  let cands = chars(raw);
  if (!target) return done(cands);
  // 上位の候補が2字 → 1字が部品ごとに別の字として読まれている（響 →「郷音」、胎 →「月台」など）
  const split = isSplit(raw);
  if (cands[0] === target && !split) return done(cands);
  const fixed = normalizeInk(ink, w, h);
  // 画数が正解よりずっと多いときは別の字を書いたとみなし、読み直しで正解にはしない
  const tooMany = strokes > 0 && ink.length > strokes * 1.3 + 2;
  if (fixed && (split || !tooMany)) {
    try {
      const raw2 = await requestOnce(fixed, w, h, 'ja', timeoutMs, false);
      info.raw2 = raw2.slice(0, 8);
      const again = chars(raw2);
      if (split) {
        // 部品の隙間を詰めて正方形に整えたインクの結果で判定する
        cands = again.concat(cands.filter((c) => !again.includes(c)));
      } else if (again[0] === target) {
        cands = [target, ...cands.filter((c) => c !== target)];
      }
    } catch (e) { /* 元の認識結果で判定する */ }
  }
  if (cands[0] === target || !rare || cands.slice(0, 5).includes(target)) return done(cands);
  // 日本語モデルが知らない難読字は繁体字モデルでも試す
  try {
    const rawZh = await requestOnce(split && fixed ? fixed : ink, w, h, 'zh_TW', timeoutMs, false);
    info.zh = rawZh.slice(0, 8);
    const extra = chars(rawZh);
    if (extra[0] === target) {
      return done([target, ...cands.filter((c) => c !== target)]);
    }
    return done(cands.concat(extra.filter((c) => !cands.includes(c))));
  } catch (e) {
    return done(cands);
  }
}

export function judge(cands, target, strict = 1) {
  const top = cands.slice(0, Math.max(1, strict));
  return top.includes(target);
}
