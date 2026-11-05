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
