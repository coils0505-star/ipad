// 学習データの保存・読み込み（localStorage）
const KEY = 'anikan:v1';

export const DEFAULT_SETTINGS = {
  judge: 'auto',          // 'auto' = 手書き自動認識 / 'self' = 自己採点
  strict: 1,              // 認識候補の何位までを正解とみなすか（1 / 3 / 5）
  penOnly: 'auto',        // 'auto' = ペンを検出したら指を無視 / 'on' / 'off'
  lineWidth: 1,           // 線の太さ倍率 0.7 / 1 / 1.4
  reviewSize: 20,         // 1回の復習の出題数
  showHint: false,        // ヒント（部首・画数）を最初から表示
  guide: true,            // 十字ガイド線
  remindTime: '20:00',    // カレンダー通知の時刻
};

function freshState() {
  return {
    v: 1,
    created: Date.now(),
    cleared: {},     // { stageGlobalIndex: bestScore }
    attempts: {},    // { stageGlobalIndex: count }
    exams: {},       // { rank: bestScore }  rank = 1..10
    srs: {},         // { 漢字: {S, due, last, reps, lapses, ease, rl, pS} }
    csrs: {},        // チャレンジで間違えたタイトル・キャラ名 { 't:鬼滅の刃': {…同上} }
    challenge: { best: {}, plays: 0 },  // ベスト記録 { mix: 12, title: 8, char: 5 }
    days: {},        // { 'YYYY-MM-DD': {n: 解答数, ok: 正解数, learned: 新規数} }
    settings: { ...DEFAULT_SETTINGS },
  };
}

let state = null;
let saveTimer = null;

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.v === 1) {
        state = { ...freshState(), ...s, settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) } };
        return state;
      }
    }
  } catch (e) {
    console.warn('load failed', e);
  }
  state = freshState();
  return state;
}

export function get() {
  return state || load();
}

export function save(immediate = false) {
  clearTimeout(saveTimer);
  const doSave = () => {
    try {
      state.savedAt = Date.now();
      localStorage.setItem(KEY, JSON.stringify(state));
      window.dispatchEvent(new CustomEvent('anikan:saved'));
    } catch (e) {
      console.warn('save failed', e);
      window.dispatchEvent(new CustomEvent('anikan:savefail'));
    }
  };
  if (immediate) doSave();
  else saveTimer = setTimeout(doSave, 300);
}

// 現在の学習状況のコピー（スロット保存・セーブコード用）
export function snapshot() {
  return JSON.parse(JSON.stringify(state));
}

// セーブデータとして正しい形か確認し、足りない項目を補って返す
export function validate(data) {
  if (!data || data.v !== 1 || typeof data.srs !== 'object' || typeof data.cleared !== 'object') {
    throw new Error('アニ漢のセーブデータではありません');
  }
  return { ...freshState(), ...data, settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) } };
}

export function replaceState(data) {
  const prevBackup = state && state.lastBackup;
  state = validate(JSON.parse(JSON.stringify(data)));
  if (!state.lastBackup && prevBackup) state.lastBackup = prevBackup;
  save(true);
  return state;
}

export function exportJSON() {
  return JSON.stringify({ app: 'anikan', exported: new Date().toISOString(), data: state });
}

// バックアップファイル（JSON）の中身を取り出す
export function parseJSON(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new Error('ファイルの形式が正しくありません');
  }
  const data = obj && obj.app === 'anikan' ? obj.data : obj;
  return validate(data);
}

export function importJSON(text) {
  return replaceState(parseJSON(text));
}

export function markBackup() {
  state.lastBackup = Date.now();
  save(true);
}

export function reset() {
  const settings = state ? state.settings : { ...DEFAULT_SETTINGS };
  state = freshState();
  state.settings = settings;
  state.seenIntro = true;
  save(true);
  return state;
}

export function dayKey(t = Date.now()) {
  const d = new Date(t);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function logAnswer(correct, learnedNew) {
  const k = dayKey();
  const d = state.days[k] || (state.days[k] = { n: 0, ok: 0, learned: 0 });
  d.n++;
  if (correct) d.ok++;
  if (learnedNew) d.learned++;
}

export function streak() {
  let n = 0;
  const t = new Date();
  // 今日まだ学習していなくても昨日まで続いていれば継続中とみなす
  if (!state.days[dayKey(t)]) t.setDate(t.getDate() - 1);
  while (state.days[dayKey(t)]) {
    n++;
    t.setDate(t.getDate() - 1);
  }
  return n;
}

// Safari のストレージ自動削除を避けるため永続化をリクエスト
export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist) {
      return await navigator.storage.persist();
    }
  } catch (e) { /* noop */ }
  return false;
}
