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

function mapOf(name) {
  const st = store.get();
  return st[name] || (st[name] = {});
}

// 新しく出会った項目（ステージテスト・昇格試験・チャレンジで初出題）
function _learn(map, key, correct, now) {
  const item = { S: 1, ease: 2.5, reps: 1, lapses: 0, rl: false, first: now };
  if (!correct) {
    item.S = RELEARN_MIN / 1440;
    item.rl = true;
    item.pS = 1;
    item.lapses = 1;
  }
  schedule(item, now);
  map[key] = item;
  return item;
}

// 復習で解答
function _review(map, key, correct, now) {
  const item = map[key];
  if (!item) return _learn(map, key, correct, now);
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

// 予定より前の解答は記憶の伸びに使わず、間違いだけ反映する
function _softUpdate(map, key, correct, now) {
  const item = map[key];
  if (!item) return _learn(map, key, correct, now);
  if (now >= item.due) return _review(map, key, correct, now);
  if (!correct) return _review(map, key, false, now);
  return item;
}

function _dueList(map, now) {
  const list = [];
  for (const k in map) {
    if (map[k].due <= now) list.push(k);
  }
  // 忘れかけている（保持率が低い）順
  list.sort((a, b) => retention(map[a], now) - retention(map[b], now));
  return list;
}

function _nextDue(map, now) {
  let min = Infinity;
  for (const k in map) {
    if (map[k].due > now && map[k].due < min) min = map[k].due;
  }
  return min === Infinity ? null : min;
}

// 今後 n 日の復習予定数（0 = 今日中）
function _forecast(map, days, now) {
  const out = new Array(days).fill(0);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  for (const k in map) {
    const d = Math.floor((map[k].due - start.getTime()) / DAY);
    const idx = Math.max(0, d);
    if (idx < days) out[idx]++;
  }
  return out;
}

function _summary(map, now) {
  let learned = 0, master = 0, weak = 0, due = 0, sumR = 0;
  for (const k in map) {
    const it = map[k];
    learned++;
    const st = status(it);
    if (st === 'master') master++;
    if (st === 'weak') weak++;
    if (it.due <= now) due++;
    sumR += retention(it, now);
  }
  return { learned, master, weak, due, avgR: learned ? sumR / learned : 0 };
}

function _weakList(map, limit) {
  return Object.keys(map)
    .filter((k) => map[k].lapses > 0)
    .sort((a, b) => map[b].lapses - map[a].lapses || retention(map[a]) - retention(map[b]))
    .slice(0, limit);
}

function api(name) {
  return {
    learn: (k, ok, now = Date.now()) => _learn(mapOf(name), k, ok, now),
    review: (k, ok, now = Date.now()) => _review(mapOf(name), k, ok, now),
    softUpdate: (k, ok, now = Date.now()) => _softUpdate(mapOf(name), k, ok, now),
    dueList: (now = Date.now()) => _dueList(mapOf(name), now),
    nextDue: (now = Date.now()) => _nextDue(mapOf(name), now),
    forecast: (days = 7, now = Date.now()) => _forecast(mapOf(name), days, now),
    summary: (now = Date.now()) => _summary(mapOf(name), now),
    weakList: (limit = 50) => _weakList(mapOf(name), limit),
    get: (k) => mapOf(name)[k],
  };
}

// 漢字1字ごとの復習
const kanji = api('srs');
export const { learn, review, softUpdate, dueList, nextDue, forecast, summary, weakList } = kanji;

// チャレンジモードで間違えたタイトル・キャラクター名の復習
export const names = api('csrs');

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
