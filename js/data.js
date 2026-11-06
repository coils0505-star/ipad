// 漢字データ（data/kanji-data.js が window.KANJI_DATA に読み込む）へのアクセス
const D = window.KANJI_DATA;

export const KANJI = D.kanji;
export const TOTAL = KANJI.length;
export const PER_RANK = D.perRank;
export const PER_STAGE = D.perStage;
export const RANKS = Math.ceil(TOTAL / PER_RANK);
export const STAGES_PER_RANK = PER_RANK / PER_STAGE;
export const TOTAL_STAGES = Math.ceil(TOTAL / PER_STAGE);
export const RANK_NAMES = D.rankNames;
export const WORKS = D.works;

const index = new Map();
KANJI.forEach((e, i) => index.set(e.k, i));

export function indexOf(ch) {
  return index.has(ch) ? index.get(ch) : -1;
}

export function byChar(ch) {
  const i = indexOf(ch);
  return i >= 0 ? KANJI[i] : null;
}

export function rankOfIndex(i) {
  return Math.floor(i / PER_RANK) + 1;
}

export function stageOfIndex(i) {
  return Math.floor(i / PER_STAGE); // 通しのステージ番号 0..999
}

export function stageRank(g) {
  return Math.floor(g / STAGES_PER_RANK) + 1;
}

export function stageNo(g) {
  return (g % STAGES_PER_RANK) + 1; // ランク内のステージ番号 1..100
}

export function stageChars(g) {
  return KANJI.slice(g * PER_STAGE, (g + 1) * PER_STAGE).map((e) => e.k);
}

export function rankChars(r) {
  return KANJI.slice((r - 1) * PER_RANK, r * PER_RANK).map((e) => e.k);
}

export function rankLabel(r) {
  return `ランク${r}「${RANK_NAMES[r - 1]}」`;
}

/* ---------------- レベル（昇格の単位） ----------------
 * ランク1〜3は200字ごとのサブランク（1-1〜1-5 など）に細分化し、
 * ランク4以降は1000字で1レベル。各レベルの昇格試験に合格すると次のレベルへ進める。 */
export const SUB_RANKS = 3;
export const SUB_SIZE = 200;
const SUB_NUMERALS = ['壱', '弐', '参', '肆', '伍', '陸', '漆', '捌', '玖', '拾'];

export const LEVELS = [];
for (let r = 1; r <= RANKS; r++) {
  const rankStart = (r - 1) * PER_RANK;
  const rankSize = Math.min(PER_RANK, TOTAL - rankStart);
  if (r <= SUB_RANKS) {
    const n = Math.ceil(rankSize / SUB_SIZE);
    for (let s = 1; s <= n; s++) {
      const start = rankStart + (s - 1) * SUB_SIZE;
      LEVELS.push({ key: `${r}-${s}`, rank: r, sub: s, subCount: n, start, size: Math.min(SUB_SIZE, rankStart + rankSize - start), name: `${RANK_NAMES[r - 1]}・${SUB_NUMERALS[s - 1]}` });
    }
  } else {
    LEVELS.push({ key: String(r), rank: r, sub: 0, subCount: 0, start: rankStart, size: rankSize, name: RANK_NAMES[r - 1] });
  }
}
LEVELS.forEach((L, i) => {
  L.idx = i;
  L.firstStage = L.start / PER_STAGE;
  L.stages = Math.ceil(L.size / PER_STAGE);
});
const LEVEL_BY_KEY = new Map(LEVELS.map((L) => [L.key, L]));

export function levelByKey(key) {
  return LEVEL_BY_KEY.get(String(key)) || null;
}

export function levelOfStage(g) {
  const i = g * PER_STAGE;
  for (const L of LEVELS) if (i >= L.start && i < L.start + L.size) return L;
  return LEVELS[LEVELS.length - 1];
}

export function levelOfIndex(i) {
  return levelOfStage(stageOfIndex(i));
}

export function levelsOfRank(r) {
  return LEVELS.filter((L) => L.rank === r);
}

export function levelChars(L) {
  return KANJI.slice(L.start, L.start + L.size).map((e) => e.k);
}

export function levelLabel(L) {
  return `ランク${L.key}「${L.name}」`;
}

export function levelRange(L) {
  return `${L.start + 1}〜${L.start + L.size}字目`;
}

export function stageNoInLevel(g) {
  return g - levelOfStage(g).firstStage + 1;
}

// 訓読み表記 "あつ.い" → "あつ(い)"、接頭・接尾の "-" → "〜"
export function fmtKun(r) {
  let s = r.replace(/\./, '(');
  if (s.includes('(')) s += ')';
  return s.replace(/^-/, '〜').replace(/-$/, '〜');
}

export function exampleLabel(ex) {
  const kind = ex[2];
  if (kind === 't') return 'アニメタイトル';
  if (kind === 'c') return `『${WORKS[ex[3]] ?? ''}』の登場人物`;
  if (kind === 'v') return 'アニメ頻出語';
  if (kind === 'w') return 'ことば';
  if (kind === 'n') return '人名';
  if (kind === 'p') return '地名';
  return '';
}

export function searchKanji(q, limit = 300) {
  q = q.trim();
  if (!q) return [];
  const hira = q.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
  const kata = q.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const out = [];
  const seen = new Set();
  // 漢字そのもの（複数文字可）
  for (const ch of Array.from(q)) {
    const i = indexOf(ch);
    if (i >= 0 && !seen.has(i)) { out.push(i); seen.add(i); }
  }
  if (/^[ぁ-ゖァ-ヶー]+$/.test(q)) {
    for (let i = 0; i < TOTAL && out.length < limit; i++) {
      if (seen.has(i)) continue;
      const e = KANJI[i];
      const hit = e.on.some((r) => r.replace(/-/g, '') === kata) ||
        e.kun.some((r) => r.replace(/[-]/g, '').split('.')[0] === hira || r.replace(/[.-]/g, '') === hira) ||
        (e.n && e.n.includes(hira));
      if (hit) { out.push(i); seen.add(i); }
    }
  } else if (/^[a-zA-Z ]+$/.test(q)) {
    const re = new RegExp(`\\b${q.toLowerCase()}`);
    for (let i = 0; i < TOTAL && out.length < limit; i++) {
      if (re.test(KANJI[i].m.toLowerCase())) out.push(i);
    }
  }
  return out;
}
