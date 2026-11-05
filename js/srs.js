// 忘却曲線（エビングハウス）に基づく復習スケジューラ
//
// 記憶保持率 R(t) = 0.9 ^ (t / S)
//   t: 最後に答えてからの経過日数, S: 記憶の安定度（日）
//   t = S のとき保持率がちょうど 90% まで下がる → その時点で復習を出題する。
// 正解するたびに S が ease 倍（約2.5倍）に伸び、間違えると短い間隔からやり直す。
// 例: 1日 → 2.5日 → 6日 → 16日 → 39日 → 98日 …
import * as store from './store.js';

const DAY = 86400000;
const MIN = 60000;
export const TARGET_R = 0.9;
export const MASTERED_DAYS = 21;     // 安定度21日以上で「定着」
const RELEARN_MIN = 10;              // 間違えた字は10分後に再出題

export function retention(item, now = Date.now()) {
  if (!item) return 0;
  const t = Math.max(0, (now - item.last) / DAY);
  return Math.pow(TARGET_R, t / item.S);
}

export function retentionAt(S, days) {
  return Math.pow(TARGET_R, days / S);
}

export function status(item) {
  if (!item) return 'new';
  if (item.rl) return 'weak';
  if (item.S >= MASTERED_DAYS) return 'master';
  return 'learning';
}

function schedule(item, now) {
  item.last = now;
  item.due = now + item.S * DAY;
}

// 新しく出会った字（ステージテスト・昇格試験で初出題）
export function learn(ch, correct, now = Date.now()) {
  const srs = store.get().srs;
  const item = { S: 1, ease: 2.5, reps: 1, lapses: 0, rl: false, first: now };
  if (!correct) {
    item.S = RELEARN_MIN / 1440;
    item.rl = true;
    item.pS = 1;
    item.lapses = 1;
  }
  schedule(item, now);
  srs[ch] = item;
  return item;
}

// 復習で解答
export function review(ch, correct, now = Date.now()) {
  const srs = store.get().srs;
  let item = srs[ch];
  if (!item) return learn(ch, correct, now);
  const elapsed = Math.max(0, (now - item.last) / DAY);
  item.reps++;
  if (correct) {
    if (item.rl) {
      // 再学習の正解: 以前の記憶の一部が残っているとみなして復帰
      item.S = Math.max(1, item.pS || 1);
      item.rl = false;
    } else {
      // 予定より早い復習ほど伸びは小さく、遅れて正解できたなら大きく伸ばす
      const ratio = Math.min(elapsed / item.S, 2);
      const gain = 1 + (item.ease - 1) * Math.max(ratio, 0.15);
      item.S = Math.max(item.S * gain, item.S + 0.5);
    }
    item.ease = Math.min(3.0, item.ease + 0.05);
  } else {
    item.lapses++;
    item.ease = Math.max(1.3, item.ease - 0.2);
    item.pS = Math.max(1, (item.rl ? item.pS : item.S) * 0.3);
    item.S = RELEARN_MIN / 1440;
    item.rl = true;
  }
  item.S = Math.min(item.S, 3650);
  schedule(item, now);
  return item;
}

// ステージ再挑戦など、予定より前の解答は記憶の伸びに使わず、間違いだけ反映する
export function softUpdate(ch, correct, now = Date.now()) {
  const item = store.get().srs[ch];
  if (!item) return learn(ch, correct, now);
  if (now >= item.due) return review(ch, correct, now);
  if (!correct) return review(ch, false, now);
  return item;
}

export function dueList(now = Date.now()) {
  const srs = store.get().srs;
  const list = [];
  for (const ch in srs) {
    if (srs[ch].due <= now) list.push(ch);
  }
  // 忘れかけている（保持率が低い）順
  list.sort((a, b) => retention(srs[a], now) - retention(srs[b], now));
  return list;
}

export function nextDue(now = Date.now()) {
  const srs = store.get().srs;
  let min = Infinity;
  for (const ch in srs) {
    if (srs[ch].due > now && srs[ch].due < min) min = srs[ch].due;
  }
  return min === Infinity ? null : min;
}

// 今後 n 日の復習予定数（0 = 今日中）
export function forecast(days = 7, now = Date.now()) {
  const srs = store.get().srs;
  const out = new Array(days).fill(0);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  for (const ch in srs) {
    const d = Math.floor((srs[ch].due - start.getTime()) / DAY);
    const idx = Math.max(0, d);
    if (idx < days) out[idx]++;
  }
  return out;
}

export function summary(now = Date.now()) {
  const srs = store.get().srs;
  let learned = 0, master = 0, weak = 0, due = 0, sumR = 0;
  for (const ch in srs) {
    const it = srs[ch];
    learned++;
    const st = status(it);
    if (st === 'master') master++;
    if (st === 'weak') weak++;
    if (it.due <= now) due++;
    sumR += retention(it, now);
  }
  return { learned, master, weak, due, avgR: learned ? sumR / learned : 0 };
}

export function weakList(limit = 50) {
  const srs = store.get().srs;
  return Object.keys(srs)
    .filter((ch) => srs[ch].lapses > 0)
    .sort((a, b) => srs[b].lapses - srs[a].lapses || retention(srs[a]) - retention(srs[b]))
    .slice(0, limit);
}

export function formatInterval(ms) {
  const m = Math.round(ms / MIN);
  if (m < 60) return `${Math.max(1, m)}分`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}時間`;
  const d = Math.round(ms / DAY);
  if (d < 31) return `${d}日`;
  if (d < 365) return `${Math.round(d / 30)}か月`;
  return `${(d / 365).toFixed(1)}年`;
}
