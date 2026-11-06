// 認識ミスの記録
// 「認識ミス（正解にする）」を押した字の書き方（線の座標）と認識結果を、この端末の中だけに残す。
// 設定画面から1行のコード（ANIKANINK1-…）にしてコピーでき、認識の改善の調査に使う。
import { packCode } from './savedata.js';

const KEY = 'anikan:misreads';
const MAX = 20;

export function list() {
  try {
    const a = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(a) ? a : [];
  } catch (e) {
    return [];
  }
}

// ほとんど動いていない点を省いてデータを小さくする（最初と最後の点は残す）
function thin(ink) {
  return ink.map(([xs, ys, ts]) => {
    const X = [xs[0]], Y = [ys[0]], T = [ts[0]];
    for (let i = 1; i < xs.length; i++) {
      const last = X.length - 1;
      if (i === xs.length - 1 || Math.abs(xs[i] - X[last]) + Math.abs(ys[i] - Y[last]) >= 2) {
        X.push(xs[i]); Y.push(ys[i]); T.push(ts[i]);
      }
    }
    return [X, Y, T];
  });
}

/** @param {{mode:string, target:string, name?:string, cands:string[], info?:object, w:number, h:number, ink:Array, pen?:boolean}} r */
export function add(r) {
  if (!r || !r.ink || !r.ink.length) return;
  const all = list();
  all.push({
    t: Date.now(),
    mode: r.mode,
    target: r.target,
    ...(r.name ? { name: r.name } : {}),
    cands: (r.cands || []).slice(0, 5),
    raw: (r.info && r.info.raw) || null,
    raw2: (r.info && r.info.raw2) || null,
    w: Math.round(r.w), h: Math.round(r.h),
    pen: !!r.pen,
    ink: thin(r.ink),
  });
  while (all.length > MAX) all.shift();
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch (e) { /* 容量不足なら記録しない */ }
}

export function clear() {
  try { localStorage.removeItem(KEY); } catch (e) { /* noop */ }
}

export function encode(records = list()) {
  return packCode('ANIKANINK', { app: 'anikan-misreads', v: 1, ua: navigator.userAgent, records });
}
