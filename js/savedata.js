// セーブコード: 学習状況を1行の文字列（ANIKAN1-…）にして、端末やアプリ間で引き継ぐ
//   ANIKAN1-<base64url(gzip(JSON))>   圧縮できるブラウザ
//   ANIKAN0-<base64url(JSON)>         圧縮に未対応のブラウザ
const MIN = 60000;

function round(n, digits) {
  const p = Math.pow(10, digits);
  return Math.round(n * p) / p;
}

// 復習データを配列に詰めて短くする
function compact(state) {
  const s = {};
  for (const ch in state.srs) {
    const it = state.srs[ch];
    s[ch] = [
      round(it.S, it.S < 1 ? 5 : 3), round(it.ease, 2), it.reps, it.lapses, it.rl ? 1 : 0,
      Math.round(it.last / MIN), Math.round(it.due / MIN), round(it.pS || 0, 3), Math.round((it.first || it.last) / MIN),
    ];
  }
  const { srs, ...rest } = state;
  return { ...rest, srs: s, _c: 1 };
}

function expand(obj) {
  if (!obj || obj._c !== 1) return obj;
  const srs = {};
  for (const ch in obj.srs) {
    const [S, ease, reps, lapses, rl, last, due, pS, first] = obj.srs[ch];
    srs[ch] = { S, ease, reps, lapses, rl: !!rl, last: last * MIN, due: due * MIN, first: first * MIN };
    if (pS) srs[ch].pS = pS;
  }
  const { _c, ...rest } = obj;
  return { ...rest, srs };
}

function toB64url(bytes) {
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes, stream) {
  const res = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await res.arrayBuffer());
}

export async function encodeCode(state) {
  const json = new TextEncoder().encode(JSON.stringify(compact(state)));
  if (typeof CompressionStream !== 'undefined') {
    try {
      return `ANIKAN1-${toB64url(await pipe(json, new CompressionStream('gzip')))}`;
    } catch (e) { /* 圧縮できなければ非圧縮で */ }
  }
  return `ANIKAN0-${toB64url(json)}`;
}

export async function decodeCode(text) {
  const code = String(text || '').replace(/\s+/g, '');
  const m = code.match(/^ANIKAN([01])-([A-Za-z0-9_-]+)$/);
  if (!m) throw new Error('セーブコードの形式が正しくありません（ANIKAN で始まる文字列を全部貼り付けてください）');
  let bytes;
  try {
    bytes = fromB64url(m[2]);
    if (m[1] === '1') {
      if (typeof DecompressionStream === 'undefined') {
        throw new Error('このブラウザでは読み込めません。iPadOS を最新にしてください');
      }
      bytes = await pipe(bytes, new DecompressionStream('gzip'));
    }
    return expand(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (e) {
    if (e.message && e.message.includes('iPadOS')) throw e;
    throw new Error('セーブコードが途中で切れているか、壊れています');
  }
}
