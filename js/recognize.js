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
          ink,
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
    // 1文字の候補を優先（複数文字の候補は先頭の文字として扱う）
    const out = [];
    for (const c of cands) {
      const ch = Array.from(c.trim())[0];
      if (ch && !out.includes(ch)) out.push(ch);
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @returns {Promise<string[]>} 認識候補（確からしい順）
 * @param {boolean} rare 難読字なら中国語（繁体字）モデルの候補も併用する
 */
export async function recognize(ink, w, h, { target = null, rare = false, timeoutMs = 6000 } = {}) {
  const primary = await requestOnce(ink, w, h, 'ja', timeoutMs);
  if (!target || !rare || primary.slice(0, 5).includes(target)) return primary;
  // 日本語モデルが知らない難読字は繁体字モデルでも試す
  try {
    const extra = await requestOnce(ink, w, h, 'zh_TW', timeoutMs, false);
    if (extra[0] === target) {
      return [target, ...primary.filter((c) => c !== target)];
    }
    return primary.concat(extra.filter((c) => !primary.includes(c)));
  } catch (e) {
    return primary;
  }
}

export function judge(cands, target, strict = 1) {
  const top = cands.slice(0, Math.max(1, strict));
  return top.includes(target);
}
