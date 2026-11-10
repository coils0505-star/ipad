import * as store from './store.js';
import * as srs from './srs.js';
import * as K from './data.js';
import { InkPad } from './ink.js';
import { recognize, judge, isDown } from './recognize.js';
import * as slots from './slots.js';
import * as savedata from './savedata.js';
import * as misreads from './misreads.js';

const PASS = 90;
const DAY = 86400000;
const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let S = store.load();
let stack = [];
let pad = null;
let quiz = null;
let lastResult = null;
let alertShown = false;

/* ------------------------------------------------------------------ */
/* 進行状況                                                             */
/* ------------------------------------------------------------------ */
// 昇格の単位は「レベル」: ランク1〜3は200字ごと（1-1〜3-5）、ランク4以降は1000字ごと。
// S.exams のキーはレベルのキー（"1-2" や "4"）。ランク1〜3のランク番号キー（"1"〜"3"）は
// 1000字まとめての飛び級試験で、合格するとそのランクの全サブランクが合格扱いになる。
const bestOf = (g) => S.cleared[g] ?? null;
const isCleared = (g) => (S.cleared[g] ?? -1) >= PASS;
const examPassed = (key) => (S.exams[key] ?? -1) >= PASS;

function levelPassed(L) {
  return examPassed(L.key) || (L.sub > 0 && examPassed(String(L.rank)));
}

function levelOpen(L) {
  return L.idx === 0 || levelPassed(K.LEVELS[L.idx - 1]);
}

function rankOpen(r) {
  return levelOpen(K.levelsOfRank(r)[0]);
}

function rankPassed(r) {
  const ls = K.levelsOfRank(r);
  return levelPassed(ls[ls.length - 1]);
}

function stageOpen(g) {
  const L = K.levelOfStage(g);
  if (!levelOpen(L)) return false;
  return g === L.firstStage || isCleared(g - 1);
}

function clearedInLevel(L) {
  let n = 0;
  for (let g = L.firstStage; g < L.firstStage + L.stages; g++) if (isCleared(g)) n++;
  return n;
}

function clearedCount(r) {
  return K.levelsOfRank(r).reduce((a, L) => a + clearedInLevel(L), 0);
}

function topLevel() {
  let i = 0;
  while (i < K.LEVELS.length - 1 && levelOpen(K.LEVELS[i + 1])) i++;
  return K.LEVELS[i];
}

function frontier() {
  const L = topLevel();
  for (let g = L.firstStage; g < L.firstStage + L.stages; g++) {
    if (stageOpen(g) && !isCleared(g)) return { type: 'stage', g, L };
  }
  if (!levelPassed(L)) return { type: 'exam', L };
  return { type: 'done', L };
}

// 昇格試験の内容（key = レベルのキー、またはランク1〜3のまとめ飛び級ならランク番号）
function examSpec(key) {
  key = String(key);
  const L = K.levelByKey(key);
  if (L) {
    const all = clearedInLevel(L) === L.stages;
    const name = all || levelPassed(L) ? '昇格試験' : '飛び級試験';
    return {
      key, L, rank: L.rank, chars: K.levelChars(L), size: L.size, name,
      title: `ランク${L.key} ${name}`, label: K.levelLabel(L),
      next: K.LEVELS[L.idx + 1] || null, open: levelOpen(L),
    };
  }
  const r = Number(key);
  const ls = K.levelsOfRank(r);
  const last = ls[ls.length - 1];
  return {
    key, L: null, rank: r, chars: K.rankChars(r), size: K.rankChars(r).length, name: 'まとめて飛び級試験',
    title: `ランク${r} まとめて飛び級試験`, label: K.rankLabel(r),
    next: K.LEVELS[last.idx + 1] || null, open: rankOpen(r),
  };
}

function summaryOf(state = S) {
  const learned = Object.keys(state.srs || {}).length;
  const stages = Object.values(state.cleared || {}).filter((v) => v >= PASS).length;
  let top = K.LEVELS[0];
  const passed = (key) => ((state.exams || {})[key] ?? -1) >= PASS;
  for (const L of K.LEVELS.slice(1)) {
    const prev = K.LEVELS[L.idx - 1];
    if (passed(prev.key) || (prev.sub > 0 && passed(String(prev.rank)))) top = L; else break;
  }
  return { learned, stages, level: top.key, levelName: top.name };
}

/* ------------------------------------------------------------------ */
/* ルーティング                                                         */
/* ------------------------------------------------------------------ */
const TABS = ['home', 'ranks', 'challenge', 'review', 'dict', 'settings'];

function go(name, params = {}, opts = {}) {
  if (opts.reset) stack = [];
  if (opts.replace) stack.pop();
  stack.push({ name, params });
  render();
}

function back() {
  if (current().name === 'quiz') {
    confirmQuit();
    return;
  }
  if (current().name === 'cgame') {
    confirmChallengeQuit();
    return;
  }
  if (stack.length > 1) stack.pop();
  render();
}

const current = () => stack[stack.length - 1];

function render() {
  if (pad) { pad.destroy(); pad = null; }
  const { name, params } = current();
  const app = $('#app');
  app.dataset.view = name;
  const tab = TABS.includes(name) ? name : ({ rank: 'ranks', stage: 'ranks', quiz: null, result: null, save: null, cgame: null, cresult: 'challenge' }[name] ?? null);
  document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#btn-back').hidden = stack.length <= 1 && name !== 'quiz' && name !== 'cgame';
  $('#topbar-right').innerHTML = name === 'quiz' || name === 'save' || name === 'cgame'
    ? ''
    : `<button class="save-btn" data-top="save" aria-label="セーブ画面を開く">${SAVE_SVG}<span>セーブ</span></button>`;
  view.scrollTop = 0;
  window.scrollTo(0, 0);
  const fn = VIEWS[name];
  fn(params);
  updateBadge();
}

function setTitle(t) {
  $('#topbar-title').textContent = t;
  document.title = t === 'アニ漢' ? 'アニ漢 — アニメ漢字テスト' : `${t} | アニ漢`;
}

function updateBadge() {
  const due = srs.dueList().length + srs.names.dueList().length;
  const b = $('#tab-badge');
  b.hidden = due === 0;
  b.textContent = due > 99 ? '99+' : String(due);
  try {
    if (navigator.setAppBadge) {
      if (due) navigator.setAppBadge(due).catch(() => {});
      else navigator.clearAppBadge().catch(() => {});
    }
  } catch (e) { /* noop */ }
}

/* ------------------------------------------------------------------ */
/* 共通 UI                                                              */
/* ------------------------------------------------------------------ */
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}

function openModal(html, { onMount, wide = false, onClose } = {}) {
  const root = $('#modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <button class="modal-close icon-btn" aria-label="閉じる"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button>
      <div class="modal-body">${html}</div></div>`;
  root.appendChild(wrap);
  const close = () => {
    if (wrap._pad) wrap._pad.destroy();
    wrap.remove();
    if (onClose) onClose();
  };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  wrap.querySelector('.modal-close').addEventListener('click', close);
  requestAnimationFrame(() => wrap.classList.add('open'));
  if (onMount) onMount(wrap.querySelector('.modal-body'), close, wrap);
  return close;
}

function confirmDialog(message, okLabel = 'OK', cancelLabel = 'キャンセル') {
  return new Promise((resolve) => {
    let done = false;
    const close = openModal(`<p class="confirm-msg">${message}</p>
      <div class="btn-row"><button class="btn ghost" data-r="0">${cancelLabel}</button><button class="btn primary" data-r="1">${okLabel}</button></div>`, {
      onMount(body, closeFn) {
        body.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => {
          done = true;
          closeFn();
          resolve(b.dataset.r === '1');
        }));
      },
      onClose() { if (!done) resolve(false); },
    });
    return close;
  });
}

function bar(pct, cls = '') {
  return `<div class="meter ${cls}"><div class="meter-fill" style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%"></div></div>`;
}

function fmtDate(t) {
  const d = new Date(t);
  const now = new Date();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.toDateString() === now.toDateString();
  const tmr = new Date(now); tmr.setDate(now.getDate() + 1);
  if (sameDay) return `今日 ${hm}`;
  if (d.toDateString() === tmr.toDateString()) return `明日 ${hm}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function fmtDays(d) {
  if (d < 1 / 24) return `${Math.round(d * 1440)}分`;
  if (d < 1) return `${Math.round(d * 24)}時間`;
  if (d < 60) return `${Math.round(d)}日`;
  if (d < 730) return `${Math.round(d / 30)}か月`;
  return `${(d / 365).toFixed(1)}年`;
}

const STATUS_LABEL = { new: '未学習', learning: '学習中', weak: '要復習', master: '定着' };

/* --------------------------- チャート ------------------------------ */
function tipLayer(container) {
  let tip = container.querySelector('.chart-tip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'chart-tip';
    tip.hidden = true;
    container.appendChild(tip);
  }
  return tip;
}

function placeTip(container, tip, html, x, y) {
  tip.innerHTML = html;
  tip.hidden = false;
  const cw = container.clientWidth;
  const tw = tip.offsetWidth;
  let left = x - tw / 2;
  left = Math.max(4, Math.min(cw - tw - 4, left));
  tip.style.left = `${left}px`;
  tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
}

// 今後7日間の復習予定（棒グラフ）
function chartWidth(inModal = false) {
  const avail = inModal ? Math.min(820, window.innerWidth - 32) - 50 : Math.min(1120, view.clientWidth) - 74;
  return Math.round(Math.max(300, Math.min(900, avail)));
}

function forecastChart(arr) {
  if (!arr.some((v) => v > 0)) {
    return '<p class="muted chart-empty">まだ復習予定はありません。ステージをクリアすると、ここに日ごとの復習数が表示されます。</p>';
  }
  const W = chartWidth(), H = 190, pl = 36, pr = 12, pt = 24, pb = 30;
  const max = Math.max(4, ...arr);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const bw = (W - pl - pr) / arr.length;
  const thick = Math.min(24, bw * 0.55);
  const ys = (v) => pt + (1 - v / top) * (H - pt - pb);
  const labels = arr.map((_, i) => {
    if (i === 0) return '今日';
    if (i === 1) return '明日';
    const d = new Date(); d.setDate(d.getDate() + i);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  });
  let grid = '';
  for (let v = 0; v <= top; v += step) {
    grid += `<line class="grid${v === 0 ? ' base' : ''}" x1="${pl}" x2="${W - pr}" y1="${ys(v)}" y2="${ys(v)}"/>
      <text class="tick" x="${pl - 8}" y="${ys(v) + 4}" text-anchor="end">${v}</text>`;
  }
  let bars = '';
  arr.forEach((v, i) => {
    const cx = pl + bw * i + bw / 2;
    const x = cx - thick / 2;
    const y = ys(v);
    const h = ys(0) - y;
    const r = Math.min(4, h);
    const path = h > 0
      ? `M${x},${ys(0)}V${y + r}Q${x},${y} ${x + r},${y}H${x + thick - r}Q${x + thick},${y} ${x + thick},${y + r}V${ys(0)}Z`
      : '';
    bars += `<g class="hit" data-tip="${esc(labels[i])}：${v}字">
      <rect x="${pl + bw * i}" y="${pt}" width="${bw}" height="${H - pt - pb}" fill="transparent"/>
      ${path ? `<path class="bar" d="${path}"/>` : ''}
      <text class="val" x="${cx}" y="${y - 6}" text-anchor="middle">${v}</text>
      <text class="tick" x="${cx}" y="${H - 10}" text-anchor="middle">${labels[i]}</text></g>`;
  });
  return `<div class="chart" data-chart="bars"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="今後7日間の復習予定数">${grid}${bars}</svg>
    <table class="sr-only"><tr>${labels.map((l) => `<th>${l}</th>`).join('')}</tr><tr>${arr.map((v) => `<td>${v}</td>`).join('')}</tr></table></div>`;
}

function niceStep(max) {
  const raw = max / 4;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 5, 10]) if (raw <= m * p) return Math.max(1, m * p);
  return Math.max(1, 10 * p);
}

function bindBarTips(root) {
  root.querySelectorAll('[data-chart="bars"]').forEach((c) => {
    const tip = tipLayer(c);
    c.querySelectorAll('.hit').forEach((g) => {
      const show = (e) => {
        const r = c.getBoundingClientRect();
        placeTip(c, tip, esc(g.dataset.tip), e.clientX - r.left, e.clientY - r.top);
        c.querySelectorAll('.hit').forEach((o) => o.classList.toggle('dim', o !== g));
      };
      g.addEventListener('pointerenter', show);
      g.addEventListener('pointerdown', show);
      g.addEventListener('pointerleave', () => {
        tip.hidden = true;
        c.querySelectorAll('.hit').forEach((o) => o.classList.remove('dim'));
      });
    });
  });
}

// 忘却曲線（記憶保持率の予測）
function curveChart(item) {
  const W = chartWidth(true), H = 230, pl = 44, pr = 16, pt = 18, pb = 34;
  const now = Date.now();
  const el = Math.max(0, (now - item.last) / DAY);
  const maxX = Math.max(item.S * 2.2, el * 1.15, 2 / 1440);
  const xs = (d) => pl + (d / maxX) * (W - pl - pr);
  const ys = (r) => pt + (1 - r) * (H - pt - pb);
  let path = '';
  for (let i = 0; i <= 120; i++) {
    const d = (maxX * i) / 120;
    path += `${i ? 'L' : 'M'}${xs(d).toFixed(1)},${ys(srs.retentionAt(item.S, d)).toFixed(1)}`;
  }
  const area = `${path}L${xs(maxX).toFixed(1)},${ys(0)}L${xs(0)},${ys(0)}Z`;
  let grid = '';
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    grid += `<line class="grid${v === 0 ? ' base' : ''}" x1="${pl}" x2="${W - pr}" y1="${ys(v)}" y2="${ys(v)}"/>
      <text class="tick" x="${pl - 8}" y="${ys(v) + 4}" text-anchor="end">${v * 100}%</text>`;
  }
  let xt = '';
  for (let i = 0; i <= 4; i++) {
    const d = (maxX * i) / 4;
    xt += `<text class="tick" x="${xs(d)}" y="${H - 12}" text-anchor="${i === 0 ? 'start' : i === 4 ? 'end' : 'middle'}">${i === 0 ? '前回' : fmtDays(d) + '後'}</text>`;
  }
  const rNow = srs.retentionAt(item.S, el);
  const dueX = xs(item.S);
  return `<div class="chart" data-chart="curve" data-s="${item.S}" data-max="${maxX}">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="忘却曲線: 現在の記憶保持率 ${Math.round(rNow * 100)}%">
      ${grid}
      <line class="ref" x1="${pl}" x2="${W - pr}" y1="${ys(0.9)}" y2="${ys(0.9)}"/>
      <text class="ref-label" x="${W - pr}" y="${ys(0.9) - 6}" text-anchor="end">復習ライン 90%</text>
      <line class="due" x1="${dueX}" x2="${dueX}" y1="${pt}" y2="${ys(0)}"/>
      <text class="ref-label" x="${dueX + 6}" y="${ys(0.5)}">復習予定</text>
      <path class="area" d="${area}"/>
      <path class="line" d="${path}"/>
      <line class="cross" x1="0" x2="0" y1="${pt}" y2="${ys(0)}" visibility="hidden"/>
      <circle class="dot" cx="${xs(el)}" cy="${ys(rNow)}" r="5"/>
      <text class="dot-label" x="${xs(el)}" y="${ys(rNow) + 20}" text-anchor="${xs(el) > W - 80 ? 'end' : 'middle'}">今 ${Math.round(rNow * 100)}%</text>
      ${xt}
      <rect class="hitarea" x="${pl}" y="${pt}" width="${W - pl - pr}" height="${H - pt - pb}" fill="transparent"/>
    </svg></div>`;
}

function bindCurveTips(root) {
  root.querySelectorAll('[data-chart="curve"]').forEach((c) => {
    const S_ = Number(c.dataset.s);
    const maxX = Number(c.dataset.max);
    const svg = c.querySelector('svg');
    const cross = c.querySelector('.cross');
    const hit = c.querySelector('.hitarea');
    const tip = tipLayer(c);
    const move = (e) => {
      const r = svg.getBoundingClientRect();
      const vb = svg.viewBox.baseVal;
      const sx = ((e.clientX - r.left) / r.width) * vb.width;
      const x0 = Number(hit.getAttribute('x'));
      const w = Number(hit.getAttribute('width'));
      const d = Math.max(0, Math.min(1, (sx - x0) / w)) * maxX;
      const rr = srs.retentionAt(S_, d);
      cross.setAttribute('x1', sx); cross.setAttribute('x2', sx);
      cross.setAttribute('visibility', 'visible');
      placeTip(c, tip, `${d < 0.01 ? '前回の解答直後' : fmtDays(d) + '後'}<br><b>保持率 ${Math.round(rr * 100)}%</b>`,
        e.clientX - r.left, (e.clientY - r.top));
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); });
  });
}

/* ------------------------------------------------------------------ */
/* 漢字の表示部品                                                       */
/* ------------------------------------------------------------------ */
function readingsHTML(e, { compact = false } = {}) {
  const on = e.on.length ? e.on.join('・') : '—';
  const kun = e.kun.length ? e.kun.map(K.fmtKun).join('・') : '—';
  let html = `<dl class="readings ${compact ? 'compact' : ''}"><dt>音</dt><dd>${esc(on)}</dd><dt>訓</dt><dd>${esc(kun)}</dd>`;
  if (!compact && e.n && e.n.length) html += `<dt>名</dt><dd>${esc(e.n.join('・'))}</dd>`;
  html += '</dl>';
  return html;
}

function exampleHTML(ex, ch, mode = 'show') {
  const chars = Array.from(ex[0]);
  const body = chars.map((c) => {
    if (c !== ch) return esc(c);
    if (mode === 'blank') return '<span class="blank" aria-label="空欄"></span>';
    return `<span class="fill">${esc(c)}</span>`;
  }).join('');
  return `<span class="ex-text">${body}</span>`;
}

function kanjiCard(ch, extra = '') {
  const e = K.byChar(ch);
  const it = S.srs[ch];
  const st = srs.status(it);
  const ex = e.ex[0];
  return `<button class="kcard st-${st}" data-act="kanji" data-ch="${esc(ch)}">
    <span class="kcard-k">${esc(ch)}</span>
    <span class="kcard-r">${esc((e.kun[0] ? K.fmtKun(e.kun[0]) : '') || e.on[0] || '')}</span>
    ${ex ? `<span class="kcard-ex">${exampleHTML(ex, ch)}</span>` : ''}
    ${extra}
  </button>`;
}

function showKanji(ch) {
  const e = K.byChar(ch);
  const i = K.indexOf(ch);
  const g = K.stageOfIndex(i);
  const it = S.srs[ch];
  const st = srs.status(it);
  const exs = e.ex.map((ex) => `<li><div class="ex-line">${exampleHTML(ex, ch)}<span class="ex-read">${esc(ex[1])}</span></div><div class="ex-src">${esc(K.exampleLabel(ex))}</div></li>`).join('');
  let memory = '<p class="muted">まだ学習していません。ステージテストで出題されると、忘却曲線に沿って復習予定が組まれます。</p>';
  if (it) {
    const r = srs.retention(it);
    memory = `<div class="mem-stats">
        <div><span class="lbl">状態</span><span class="pill st-${st}">${STATUS_LABEL[st]}</span></div>
        <div><span class="lbl">記憶保持率</span><b>${Math.round(r * 100)}%</b></div>
        <div><span class="lbl">次回の復習</span><b>${it.due <= Date.now() ? '今すぐ' : fmtDate(it.due)}</b></div>
        <div><span class="lbl">記憶の安定度</span><b>${fmtDays(it.S)}</b></div>
        <div><span class="lbl">正解/出題</span><b>${it.reps - it.lapses}/${it.reps}</b></div>
      </div>
      <h4 class="chart-title">忘却曲線 <small>このまま復習しなかった場合の記憶保持率</small></h4>
      ${curveChart(it)}`;
  }
  openModal(`
    <div class="kdetail">
      <div class="kdetail-head">
        <div class="kdetail-k">${esc(ch)}</div>
        <div class="kdetail-meta">
          <div class="kdetail-rank">${esc(K.levelLabel(K.levelOfStage(g)))}・ステージ${K.stageNoInLevel(g)}・No.${i + 1}</div>
          ${readingsHTML(e)}
          <div class="kdetail-tags">
            ${e.b ? `<span class="tag">部首 ${esc(e.b)}</span>` : ''}
            <span class="tag">${e.s}画</span>
            ${e.v ? `<span class="tag">異体字 ${esc(e.v)}</span>` : ''}
            ${e.g ? `<span class="tag">${e.g <= 8 ? '常用漢字' : '人名用漢字'}</span>` : ''}
          </div>
          ${e.m ? `<div class="kdetail-m">意味: ${esc(e.m)}</div>` : ''}
        </div>
      </div>
      ${exs ? `<h4>使われ方</h4><ul class="ex-list">${exs}</ul>` : ''}
      <h4>記憶</h4>
      ${memory}
      <div class="btn-row"><button class="btn primary" data-trace="1">なぞり書きで練習</button></div>
    </div>`, {
    wide: true,
    onMount(body, close) {
      bindCurveTips(body);
      body.querySelector('[data-trace]').addEventListener('click', () => { close(); tracePractice(ch); });
    },
  });
}

function tracePractice(ch) {
  openModal(`<div class="trace">
      <h3>なぞり書き「${esc(ch)}」</h3>
      <p class="muted">うすく表示されたお手本をなぞって形を覚えましょう。</p>
      <div class="trace-pad"></div>
      <div class="btn-row">
        <button class="btn ghost" data-a="ghost">お手本 ON/OFF</button>
        <button class="btn ghost" data-a="undo">1画戻す</button>
        <button class="btn ghost" data-a="clear">消す</button>
      </div></div>`, {
    onMount(body, close, wrap) {
      const p = new InkPad(body.querySelector('.trace-pad'), padOpts());
      p.setGhost(ch);
      wrap._pad = p;
      let ghost = true;
      body.querySelector('[data-a="ghost"]').addEventListener('click', () => { ghost = !ghost; p.setGhost(ghost ? ch : ''); });
      body.querySelector('[data-a="undo"]').addEventListener('click', () => p.undo());
      body.querySelector('[data-a="clear"]').addEventListener('click', () => p.clear());
    },
  });
}

function padOpts() {
  const st = S.settings;
  return { penOnly: st.penOnly, lineWidth: Number(st.lineWidth) || 1, guide: st.guide };
}

/* ------------------------------------------------------------------ */
/* 画面: ホーム                                                         */
/* ------------------------------------------------------------------ */
function viewHome() {
  setTitle('アニ漢');
  const sum = srs.summary();
  const f = frontier();
  const L = f.L;
  const r = L.rank;
  const cc = clearedInLevel(L);
  const next = srs.nextDue();
  const today = S.days[store.dayKey()] || { n: 0, ok: 0 };
  let cta = '';
  if (f.type === 'stage') {
    cta = `<button class="btn primary big" data-act="stage" data-g="${f.g}">ステージ${K.stageNoInLevel(f.g)}に挑戦<small>${esc(K.stageChars(f.g).join(''))}</small></button>`;
  } else if (f.type === 'exam') {
    const nx = K.LEVELS[L.idx + 1];
    cta = `<button class="btn primary big" data-act="exam" data-key="${L.key}">昇格試験に挑戦<small>20問・90点以上で${nx ? `ランク${nx.key}へ` : '全ランク制覇'}</small></button>`;
  } else {
    cta = '<div class="done-msg">全ランク制覇！復習で記憶をキープしましょう。</div>';
  }
  const dueBox = sum.due > 0
    ? `<div class="card review-card alert">
        <div class="review-head"><span class="review-num">${sum.due}</span><span>字が復習ラインを下回りました</span></div>
        <p class="muted">忘却曲線では、記憶保持率が90%を切った今が復習のベストタイミングです。</p>
        <button class="btn accent big" data-act="review">今すぐ復習する</button></div>`
    : `<div class="card review-card">
        <div class="review-head"><span class="review-num ok">0</span><span>復習待ちはありません</span></div>
        <p class="muted">${next ? `次の復習は <b>${fmtDate(next)}</b> です。` : 'ステージをクリアすると復習予定が組まれます。'}</p></div>`;

  view.innerHTML = `
    <section class="hero card">
      <div class="hero-rank">
        <div class="rank-emblem r${r} ${L.sub ? 'has-sub' : ''}">${L.sub ? `<span>${r}</span><small>-${L.sub}</small>` : r}</div>
        <div>
          <div class="hero-label">現在のランク ${esc(L.key)}</div>
          <div class="hero-name">${esc(L.name)}</div>
          <div class="hero-sub">${K.levelRange(L)}・ステージ ${cc}/${L.stages} クリア</div>
        </div>
      </div>
      ${bar((cc / L.stages) * 100)}
      ${L.sub ? `<div class="sub-chips">${K.levelsOfRank(r).map((x) => `<span class="sub-chip ${levelPassed(x) ? 'passed' : levelOpen(x) ? 'open' : 'locked'}">${x.key}</span>`).join('')}</div>` : ''}
      <div class="hero-cta">${cta}</div>
    </section>
    ${dueBox}
    ${challengeCard()}
    ${backupNotice(sum)}
    <section class="tiles">
      <div class="tile"><span class="tile-lbl">学習した漢字</span><span class="tile-val">${sum.learned.toLocaleString()}<small>/ ${K.TOTAL.toLocaleString()}</small></span></div>
      <div class="tile"><span class="tile-lbl">定着した漢字</span><span class="tile-val">${sum.master.toLocaleString()}</span></div>
      <div class="tile"><span class="tile-lbl">平均記憶保持率</span><span class="tile-val">${sum.learned ? Math.round(sum.avgR * 100) + '%' : '—'}</span></div>
      <div class="tile"><span class="tile-lbl">連続学習</span><span class="tile-val">${store.streak()}<small>日</small></span></div>
      <div class="tile"><span class="tile-lbl">今日の解答</span><span class="tile-val">${today.n}<small>問 正解${today.n ? Math.round((today.ok / today.n) * 100) : 0}%</small></span></div>
    </section>
    <section class="card">
      <h3 class="chart-title">今後7日間の復習予定 <small>忘却曲線から計算</small></h3>
      ${forecastChart(srs.forecast(7))}
    </section>
    <section class="card howto">
      <h3>あそびかた</h3>
      <ol>
        <li><b>学習</b> — ステージの10字を見て覚える</li>
        <li><b>テスト</b> — Apple Pencil で書いて解答。<b>100点中90点以上</b>で次のステージへ</li>
        <li><b>昇格試験</b> — ランク1〜3は200字（20ステージ）ごと、ランク4以降は1000字（100ステージ）ごと。20問で90点以上なら次のランクへ</li>
        <li><b>復習</b> — 忘却曲線に沿って、忘れかけた字が自動で出題されます</li>
        <li><b>セーブ</b> — 学習状況は自動でセーブ。右上の「セーブ」からスロット保存・ファイル書き出し・セーブコードで引き継ぎ</li>
      </ol>
    </section>`;
  bindBarTips(view);

  if (!S.seenIntro) {
    S.seenIntro = true;
    store.save();
    showIntro();
  } else if (sum.due > 0 && !alertShown) {
    alertShown = true;
    showReviewAlert(sum.due);
  }
}

function challengeCard() {
  const best = (S.challenge && S.challenge.best) || {};
  const top = Math.max(0, ...Object.values(best));
  const nd = srs.names.dueList().length;
  return `<section class="card challenge-card">
      <div class="ch-badge small" aria-hidden="true">挑</div>
      <div class="challenge-card-body">
        <b>チャレンジモード</b>
        <div class="muted small">アニメタイトル・キャラ名を全部書けるか挑戦。ライフ${LIVES}つ。ベスト ${top}問${nd ? `・<b class="accent-text">名前の復習待ち ${nd}件</b>` : ''}</div>
      </div>
      ${nd ? '<button class="btn accent" data-act="name-review">名前を復習</button>' : ''}
      <button class="btn primary" data-act="challenge-home">挑戦する</button>
    </section>`;
}

function showIntro() {
  openModal(`<div class="intro">
    <div class="intro-k">漢</div>
    <h2>アニ漢へようこそ</h2>
    <p>アニメのタイトルやキャラクター名によく使われる漢字を、<b>1万字</b>収録した書き取りテストです。</p>
    <ul>
      <li>1000字ごとに<b>10ランク</b>。ランク1〜3は<b>200字ごと</b>の5段階に細分化</li>
      <li>テストは<b>100点満点・90点以上で合格</b></li>
      <li><b>忘却曲線</b>に沿って最適なタイミングで復習を出題</li>
      <li>解答は <b>Apple Pencil</b>（指でもOK）で手書き</li>
    </ul>
    <p class="muted small">Safari の共有ボタンから「ホーム画面に追加」すると全画面で使え、学習データも消えにくくなります。手書きの自動判定にはインターネット接続が必要です（オフライン時は自己採点）。</p>
    <div class="btn-row"><button class="btn primary" data-ok>はじめる</button></div></div>`, {
    onMount(body, close) { body.querySelector('[data-ok]').addEventListener('click', close); },
  });
  store.requestPersist();
}

function showReviewAlert(n) {
  openModal(`<div class="intro">
    <div class="intro-k alert">復</div>
    <h2>復習の時間です</h2>
    <p><b>${n}字</b>の記憶保持率が90%を下回りました。忘れる前に復習すると、次の復習までの間隔がぐっと伸びます。</p>
    <div class="btn-row"><button class="btn ghost" data-later>あとで</button><button class="btn accent" data-go>復習する</button></div></div>`, {
    onMount(body, close) {
      body.querySelector('[data-later]').addEventListener('click', close);
      body.querySelector('[data-go]').addEventListener('click', () => { close(); startReview(); });
    },
  });
}

/* ------------------------------------------------------------------ */
/* 画面: ランク一覧 / ランク詳細 / ステージ                             */
/* ------------------------------------------------------------------ */
function viewRanks() {
  setTitle('ランク');
  let html = '<div class="rank-list">';
  for (let r = 1; r <= K.RANKS; r++) {
    const open = rankOpen(r);
    const ls = K.levelsOfRank(r);
    const total = ls.reduce((a, L) => a + L.stages, 0);
    const cc = clearedCount(r);
    let status;
    if (ls.length > 1) {
      const np = ls.filter(levelPassed).length;
      status = `ステージ ${cc}/${total}・サブランク ${np}/${ls.length} 合格
        <div class="sub-chips">${ls.map((L) => `<span class="sub-chip ${levelPassed(L) ? 'passed' : levelOpen(L) ? 'open' : 'locked'}">${L.key}</span>`).join('')}</div>`;
    } else {
      const ex = S.exams[String(r)];
      status = `ステージ ${cc}/${total}${rankPassed(r) ? `・<b class="good">昇格試験 合格 ${ex}点</b>` : ex != null ? `・昇格試験 最高${ex}点` : ''}`;
    }
    html += `<button class="rank-item card ${open ? '' : 'locked'}" data-act="rank" data-r="${r}">
      <div class="rank-emblem r${r}">${open ? r : '🔒'}</div>
      <div class="rank-info">
        <div class="rank-title">ランク${r}「${esc(K.RANK_NAMES[r - 1])}」${ls.length > 1 ? `<span class="rank-tag">200字×${ls.length}段階</span>` : ''}</div>
        <div class="rank-sub">${(r - 1) * K.PER_RANK + 1}〜${(r - 1) * K.PER_RANK + total * K.PER_STAGE}字目 <span class="rank-sample">${esc(K.rankChars(r).slice(0, 12).join(''))}…</span></div>
        ${bar((cc / total) * 100)}
        <div class="rank-sub">${status}</div>
      </div></button>`;
  }
  html += '</div>';
  view.innerHTML = html;
}

function stageCells(L) {
  let cells = '';
  for (let n = 1; n <= L.stages; n++) {
    const g = L.firstStage + n - 1;
    const so = stageOpen(g);
    const b = bestOf(g);
    const cl = isCleared(g);
    cells += `<button class="stage-cell ${cl ? 'cleared' : so ? 'open' : 'locked'}" data-act="stage" data-g="${g}" ${so || cl ? '' : 'aria-disabled="true"'}>
      <span class="stage-no">${n}</span>
      <span class="stage-k">${esc(K.stageChars(g).slice(0, 3).join(''))}</span>
      <span class="stage-score">${cl ? '★' + b : b != null ? b + '点' : so ? '挑戦' : ''}</span></button>`;
  }
  return `<div class="stage-grid">${cells}</div>`;
}

function levelExamButton(L, cls = '') {
  if (!levelOpen(L)) return '';
  if (levelPassed(L)) {
    const ex = S.exams[L.key];
    return `<span class="pill passed">合格${ex != null ? ` ${ex}点` : ''}</span>`;
  }
  const all = clearedInLevel(L) === L.stages;
  return `<button class="btn ${all ? 'primary' : 'ghost'} ${cls}" data-act="exam" data-key="${L.key}">${all ? '昇格試験' : '飛び級試験'}（20問）</button>`;
}

function viewRank({ r, focus }) {
  setTitle(K.rankLabel(r));
  const ls = K.levelsOfRank(r);
  const open = rankOpen(r);
  const cc = clearedCount(r);
  const total = ls.reduce((a, L) => a + L.stages, 0);
  const prevLabel = r > 1 ? `ランク${K.levelsOfRank(r - 1).slice(-1)[0].key}` : '';
  let head;
  let body;
  if (ls.length === 1) {
    const L = ls[0];
    head = levelExamButton(L);
    body = `${open && !levelPassed(L) && clearedInLevel(L) < L.stages ? '<p class="muted small center">「飛び級試験」はこのランク1000字からの20問。90点以上で次のランクが開放されます。</p>' : ''}
      ${stageCells(L)}`;
  } else {
    head = open && !rankPassed(r)
      ? `<button class="btn ghost" data-act="exam" data-key="${r}">まとめて飛び級（1000字から20問）</button>`
      : rankPassed(r) ? '<span class="pill passed">全段階 合格</span>' : '';
    body = `<p class="muted small center">ランク${r}は200字ずつ5段階。各段階の20ステージをクリアして昇格試験（20問・90点以上）に合格すると次の段階へ進めます。</p>
      ${ls.map((L) => {
        const lo = levelOpen(L);
        const cl = clearedInLevel(L);
        return `<section class="card level-sec ${lo ? '' : 'locked'} ${levelPassed(L) ? 'passed' : ''}" id="lv-${L.key}">
          <div class="level-head">
            <div class="level-badge r${r}">${L.key}</div>
            <div class="level-info">
              <div class="level-title">${esc(L.name)}</div>
              <div class="rank-sub">${K.levelRange(L)}・ステージ ${cl}/${L.stages} クリア</div>
              ${bar((cl / L.stages) * 100)}
            </div>
            <div class="level-actions">${levelExamButton(L)}</div>
          </div>
          ${!lo ? `<p class="muted small">ランク${K.LEVELS[L.idx - 1].key}の昇格試験に合格すると挑戦できます。</p>` : ''}
          ${stageCells(L)}
        </section>`;
      }).join('')}`;
  }
  view.innerHTML = `
    <section class="card rank-head">
      <div class="rank-emblem r${r}">${r}</div>
      <div class="rank-info">
        <div class="rank-sub">${(r - 1) * K.PER_RANK + 1}〜${(r - 1) * K.PER_RANK + total * K.PER_STAGE}字目</div>
        ${bar((cc / total) * 100)}
        <div class="rank-sub">ステージ ${cc}/${total} クリア${rankPassed(r) ? '・<b class="good">昇格済み</b>' : ''}</div>
      </div>
      <div class="rank-actions">${head}</div>
    </section>
    ${!open ? `<p class="notice">${prevLabel}の昇格試験に合格すると挑戦できます。</p>` : ''}
    ${body}`;
  if (focus) {
    const el = document.getElementById(`lv-${focus}`);
    if (el && ls.length > 1) requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
  }
}

function viewStage({ g }) {
  const L = K.levelOfStage(g);
  const n = K.stageNoInLevel(g);
  setTitle(`ランク${L.key} ステージ${n}`);
  const chars = K.stageChars(g);
  const b = bestOf(g);
  view.innerHTML = `
    <section class="card stage-head">
      <div>
        <div class="stage-title">ステージ${n}<small>${esc(K.levelLabel(L))}・全${L.stages}ステージ</small></div>
        <div class="muted">${b != null ? `最高 <b>${b}点</b>${isCleared(g) ? '（合格）' : ''}` : 'まずは10字を確認してからテストに挑戦しましょう'}</div>
      </div>
      <button class="btn primary big" data-act="start-stage" data-g="${g}" ${stageOpen(g) || isCleared(g) ? '' : 'disabled'}>テスト開始<small>10問・90点以上で合格</small></button>
    </section>
    <h3 class="sec-title">このステージの漢字 <small>タップで詳しく</small></h3>
    <div class="kcard-grid">${chars.map((c) => kanjiCard(c)).join('')}</div>`;
}

/* ------------------------------------------------------------------ */
/* 画面: 復習                                                           */
/* ------------------------------------------------------------------ */
function viewReview() {
  setTitle('復習');
  const due = srs.dueList();
  const sum = srs.summary();
  const weak = srs.weakList(30);
  const next = srs.nextDue();
  const size = Number(S.settings.reviewSize) || 20;
  view.innerHTML = `
    <section class="card review-main ${due.length ? 'alert' : ''}">
      <div class="review-head"><span class="review-num ${due.length ? '' : 'ok'}">${due.length}</span><span>字が復習待ち</span></div>
      <p class="muted">${due.length ? `記憶保持率の低い順に最大${size}問出題します。` : next ? `次の復習は <b>${fmtDate(next)}</b>。それまでは記憶がしっかり残っています。` : 'まだ学習した漢字がありません。'}</p>
      <div class="btn-row left">
        <button class="btn accent big" data-act="review" ${due.length ? '' : 'disabled'}>復習をはじめる</button>
        ${!due.length && sum.learned ? '<button class="btn ghost" data-act="ahead">前倒しで復習</button>' : ''}
      </div>
    </section>
    ${nameReviewCard()}
    <section class="card">
      <h3 class="chart-title">今後7日間の復習予定 <small>字数</small></h3>
      ${forecastChart(srs.forecast(7))}
    </section>
    <section class="card">
      <h3>忘却曲線とは？</h3>
      <p class="muted">人は覚えたことを時間とともに忘れていきます（エビングハウスの忘却曲線）。このアプリでは字ごとに「記憶の安定度」を記録し、保持率が<b>90%</b>まで下がる頃に出題します。正解するたびに次の復習までの間隔が約2.5倍に伸び（1日→3日→6日→2週間→1か月…）、間違えると10分後から覚え直します。</p>
    </section>
    <section class="card">
      <h3>苦手な漢字 <small class="muted">${weak.length}字</small></h3>
      ${weak.length ? `<div class="mini-grid">${weak.map((c) => `<button class="mini-k st-${srs.status(S.srs[c])}" data-act="kanji" data-ch="${esc(c)}">${esc(c)}</button>`).join('')}</div>
        <div class="btn-row left"><button class="btn ghost" data-act="weak">苦手な漢字だけ練習</button></div>` : '<p class="muted">間違えた漢字がここに集まります。</p>'}
    </section>
    <section class="card">
      <h3>復習リマインダー</h3>
      <p class="muted">毎日決まった時刻に通知が来るよう、iPad のカレンダーに予定を追加できます。</p>
      <div class="btn-row left">
        <label class="inline">時刻 <input type="time" id="remind-time" value="${esc(S.settings.remindTime)}"></label>
        <button class="btn ghost" data-act="ics">カレンダーに追加</button>
      </div>
    </section>`;
  bindBarTips(view);
  $('#remind-time').addEventListener('change', (e) => { S.settings.remindTime = e.target.value || '20:00'; store.save(); });
}

function nameReviewCard() {
  const nd = srs.names.dueList();
  const all = Object.keys(S.csrs || {});
  if (!all.length) return '';
  const next = srs.names.nextDue();
  const weak = srs.names.weakList(40);
  return `<section class="card review-main ${nd.length ? 'alert' : ''}">
      <h3>タイトル・キャラ名の復習 <small>チャレンジで書けなかった名前 ${all.length}件</small></h3>
      <div class="review-head"><span class="review-num ${nd.length ? '' : 'ok'}">${nd.length}</span><span>件が復習待ち</span></div>
      <p class="muted">${nd.length ? '名前の漢字をすべて書いて答えます（ライフなし）。' : next ? `次の復習は <b>${fmtDate(next)}</b> です。` : ''}</p>
      <div class="name-chips">${weak.map((id) => `<button class="name-chip" data-act="name-item" data-id="${esc(id)}">${esc(id.slice(2).split('|')[0])}</button>`).join('')}</div>
      <div class="btn-row left"><button class="btn accent big" data-act="name-review" ${nd.length ? '' : 'disabled'}>名前の復習をはじめる</button></div>
    </section>`;
}

function downloadICS() {
  const [hh, mm] = (S.settings.remindTime || '20:00').split(':').map(Number);
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  if (d < new Date()) d.setDate(d.getDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  const local = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(hh)}${p(mm)}00`;
  const now = new Date();
  const stamp = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}00Z`;
  const url = location.href.split('#')[0];
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//anikan//kanji//JA', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', `UID:anikan-review-${Date.now()}@anikan`, `DTSTAMP:${stamp}`,
    `DTSTART:${local}`, 'DURATION:PT15M', 'RRULE:FREQ=DAILY',
    'SUMMARY:アニ漢 復習タイム', `DESCRIPTION:忘却曲線に沿った漢字の復習をしましょう。\\n${url}`, `URL:${url}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:アニ漢 復習タイム', 'TRIGGER:PT0M', 'END:VALARM',
    'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'anikan-review.ics';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  toast('ダウンロードした予定ファイルを開いてカレンダーに追加してください');
}

/* ------------------------------------------------------------------ */
/* 画面: 図鑑                                                           */
/* ------------------------------------------------------------------ */
let dictLevel = 0;
let dictQuery = '';

function viewDict() {
  setTitle('漢字図鑑');
  const chips = K.LEVELS
    .map((L) => `<button class="chip ${L.idx === dictLevel && !dictQuery ? 'active' : ''}" data-act="dict-rank" data-l="${L.idx}">ランク${L.key}</button>`).join('');
  view.innerHTML = `
    <div class="dict-tools">
      <input type="search" id="dict-q" placeholder="漢字・よみ（ひらがな/カタカナ）・英語で検索" value="${esc(dictQuery)}" autocomplete="off">
      <div class="chips">${chips}</div>
      <div class="legend">
        <span><i class="sw st-new"></i>未学習</span><span><i class="sw st-learning"></i>学習中</span>
        <span><i class="sw st-weak"></i>要復習</span><span><i class="sw st-master"></i>定着（21日以上）</span>
        <span><i class="sw due-dot"></i>復習待ち</span>
      </div>
    </div>
    <div id="dict-body"></div>`;
  const input = $('#dict-q');
  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(() => { dictQuery = input.value; renderDictBody(); view.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', !dictQuery && Number(c.dataset.l) === dictLevel)); }, 200);
  });
  renderDictBody();
  const active = view.querySelector('.chip.active');
  if (active) active.scrollIntoView({ inline: 'center', block: 'nearest' });
}

function renderDictBody() {
  const body = $('#dict-body');
  if (!body) return;
  const now = Date.now();
  let idxs;
  let head = '';
  if (dictQuery.trim()) {
    idxs = K.searchKanji(dictQuery);
    head = `<p class="muted">「${esc(dictQuery)}」の検索結果 ${idxs.length}字${idxs.length >= 300 ? '（先頭300字）' : ''}</p>`;
  } else {
    const L = K.LEVELS[dictLevel];
    idxs = Array.from({ length: L.size }, (_, i) => L.start + i);
    const learned = idxs.filter((i) => S.srs[K.KANJI[i].k]).length;
    head = `<p class="muted">${esc(K.levelLabel(L))}（${K.levelRange(L)}）：${learned}/${idxs.length}字 学習済み</p>`;
  }
  body.innerHTML = head + `<div class="dict-grid">${idxs.map((i) => {
    const ch = K.KANJI[i].k;
    const it = S.srs[ch];
    const st = srs.status(it);
    return `<button class="dict-k st-${st} ${it && it.due <= now ? 'due' : ''}" data-act="kanji" data-ch="${esc(ch)}" aria-label="${esc(ch)} ${STATUS_LABEL[st]}">${esc(ch)}</button>`;
  }).join('')}</div>`;
}

/* ------------------------------------------------------------------ */
/* 画面: 設定                                                           */
/* ------------------------------------------------------------------ */
function viewSettings() {
  setTitle('設定');
  const st = S.settings;
  const opt = (name, val, label, cur) => `<label class="seg-opt"><input type="radio" name="${name}" value="${val}" ${String(cur) === String(val) ? 'checked' : ''}><span>${label}</span></label>`;
  view.innerHTML = `
    <section class="card settings">
      <h3>採点</h3>
      <div class="set-row"><div class="set-lbl">判定方法<small>自動判定は手書き文字をインターネット経由（Google 手書き入力）で認識します</small></div>
        <div class="seg">${opt('judge', 'auto', '手書き自動判定', st.judge)}${opt('judge', 'self', '自己採点', st.judge)}</div></div>
      <div class="set-row"><div class="set-lbl">判定の厳しさ<small>認識候補の何位までに正解があれば○にするか</small></div>
        <div class="seg">${opt('strict', 1, '1位のみ（厳格）', st.strict)}${opt('strict', 3, '3位まで', st.strict)}${opt('strict', 5, '5位まで', st.strict)}</div></div>
      <div class="set-row"><div class="set-lbl">ヒントを最初から表示<small>部首・画数・読みなど</small></div>
        <div class="seg">${opt('showHint', 'false', 'しない', st.showHint)}${opt('showHint', 'true', 'する', st.showHint)}</div></div>
      <div class="set-row"><div class="set-lbl">1回の復習の出題数</div>
        <div class="seg">${opt('reviewSize', 10, '10問', st.reviewSize)}${opt('reviewSize', 20, '20問', st.reviewSize)}${opt('reviewSize', 30, '30問', st.reviewSize)}${opt('reviewSize', 50, '50問', st.reviewSize)}</div></div>
    </section>
    <section class="card settings">
      <h3>手書き</h3>
      <div class="set-row"><div class="set-lbl">指での入力<small>「自動」は Apple Pencil を使うと指・手のひらのタッチを無視します</small></div>
        <div class="seg">${opt('penOnly', 'auto', '自動', st.penOnly)}${opt('penOnly', 'on', 'ペンのみ', st.penOnly)}${opt('penOnly', 'off', '指も使う', st.penOnly)}</div></div>
      <div class="set-row"><div class="set-lbl">線の太さ</div>
        <div class="seg">${opt('lineWidth', 0.7, '細い', st.lineWidth)}${opt('lineWidth', 1, 'ふつう', st.lineWidth)}${opt('lineWidth', 1.4, '太い', st.lineWidth)}</div></div>
      <div class="set-row"><div class="set-lbl">十字ガイド線</div>
        <div class="seg">${opt('guide', 'true', '表示', st.guide)}${opt('guide', 'false', '非表示', st.guide)}</div></div>
      <div class="set-test"><div class="set-lbl">試し書き</div><div class="set-pad"></div><button class="btn ghost small" id="pad-clear">消す</button></div>
    </section>
    <section class="card settings" id="mr-card">
      <h3>認識ミスの記録</h3>
      <p class="muted small">「認識ミス（正解にする）」を押した字は、書いた線のデータと認識結果をこの端末の中に記録しています（最新20件）。うまく認識されない字があるときは、記録をコピーして開発者に送ると原因の調査に使えます。記録には書いた線・認識結果・端末の種類が含まれます。</p>
      <div class="mr-sum" id="mr-sum"></div>
      <div class="btn-row left">
        <button class="btn primary" id="mr-copy" disabled>記録をコピー</button>
        <button class="btn ghost" id="mr-clear" disabled>記録を消す</button>
      </div>
      <textarea class="code-box" id="mr-out" readonly hidden aria-label="認識ミスの記録コード"></textarea>
    </section>
    <section class="card settings">
      <h3>学習データ</h3>
      <p class="muted small">学習状況は自動でセーブされます。セーブスロットへの保存、ファイルへの書き出し、別の端末への引き継ぎは「セーブ」画面から行えます。</p>
      <div class="btn-row left"><button class="btn primary" id="go-save">セーブ画面を開く</button></div>
    </section>
    <section class="card about">
      <h3>このアプリについて</h3>
      <p class="small muted">収録 ${K.TOTAL.toLocaleString()}字（${K.RANKS}ランク × ${K.PER_RANK}字。ランク1〜${K.SUB_RANKS}は${K.SUB_SIZE}字ごとの${K.PER_RANK / K.SUB_SIZE}段階に細分化）。並び順はアニメのタイトル・キャラクター名・頻出語での出現と、一般語・人名での使用頻度から算出しています。</p>
      <p class="small muted">漢字・単語・人名データ: <a href="https://www.edrdg.org/wiki/index.php/KANJIDIC_Project" target="_blank" rel="noopener">KANJIDIC2</a> / <a href="https://www.edrdg.org/jmdict/j_jmdict.html" target="_blank" rel="noopener">JMdict</a> / JMnedict © Electronic Dictionary Research and Development Group（<a href="https://www.edrdg.org/edrdg/licence.html" target="_blank" rel="noopener">CC BY-SA 4.0</a>）。チャレンジ用の作品名・キャラクター名: Wikidata（CC0）／ Wikipedia 日本語版（CC BY-SA 4.0）／ mecab-ipadic-NEologd（Apache-2.0）。作品名・人名は各権利者に帰属します。</p>
    </section>`;

  view.querySelectorAll('.seg input').forEach((inp) => inp.addEventListener('change', () => {
    let v = inp.value;
    if (['strict', 'reviewSize', 'lineWidth'].includes(inp.name)) v = Number(v);
    if (['showHint', 'guide'].includes(inp.name)) v = v === 'true';
    S.settings[inp.name] = v;
    store.save();
    if (['penOnly', 'lineWidth', 'guide'].includes(inp.name)) mountTestPad();
    toast('設定を保存しました', 1200);
  }));
  const mountTestPad = () => {
    if (pad) pad.destroy();
    const holder = view.querySelector('.set-pad');
    holder.innerHTML = '';
    pad = new InkPad(holder, padOpts());
  };
  mountTestPad();
  $('#pad-clear').addEventListener('click', () => pad && pad.clear());
  $('#go-save').addEventListener('click', () => go('save'));
  setupMisreads();
}

// 設定画面の「認識ミスの記録」（コピーは操作直後でないと失敗するので事前にコードを作っておく）
function setupMisreads() {
  const recs = misreads.list();
  const sum = $('#mr-sum');
  const copyBtn = $('#mr-copy'), clearBtn = $('#mr-clear'), out = $('#mr-out');
  if (!recs.length) {
    sum.innerHTML = '<p class="small muted">まだ記録はありません。</p>';
    return;
  }
  const chips = recs.slice().reverse().map((r) => {
    const got = (r.cands && r.cands[0]) || '？';
    return `<span class="mr-chip"><b>${esc(r.target)}</b>→${esc(got)}</span>`;
  }).join('');
  sum.innerHTML = `<p class="small"><b>${recs.length}件</b>（書いた字 → 認識された字）</p><div class="mr-chips">${chips}</div>`;
  clearBtn.disabled = false;
  clearBtn.addEventListener('click', async () => {
    if (!(await confirmDialog('認識ミスの記録をすべて消去します。', '消去する'))) return;
    misreads.clear();
    toast('記録を消去しました');
    viewSettings();
  });
  misreads.encode(recs).then((code) => {
    out.value = code;
    copyBtn.disabled = false;
    copyBtn.addEventListener('click', async () => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(code);
        ok = true;
      } catch (e) {
        out.hidden = false;
        out.focus();
        out.select();
        try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      }
      if (ok) toast(`記録をコピーしました（${recs.length}件・${code.length.toLocaleString()}文字）`);
      else {
        out.hidden = false;
        toast('コピーできませんでした。枠内の文字を長押しして全選択→コピーしてください');
      }
    });
  }).catch(() => { sum.insertAdjacentHTML('beforeend', '<p class="small muted">記録のコードを作成できませんでした</p>'); });
}

/* ------------------------------------------------------------------ */
/* 画面: セーブ                                                         */
/* ------------------------------------------------------------------ */
const SLOT_IDS = ['slot1', 'slot2', 'slot3'];

function backupNotice(sum) {
  if (sum.learned < 20) return '';
  const last = S.lastBackup;
  if (last && Date.now() - last < 7 * DAY) return '';
  const days = last ? Math.floor((Date.now() - last) / DAY) : null;
  return `<div class="card backup-notice">
    <div><b>${days == null ? 'まだバックアップがありません' : `最後のバックアップから${days}日`}</b>
    <p class="muted small">iPad の故障や Safari のデータ削除に備えて、セーブデータをファイルに書き出しておきましょう。</p></div>
    <button class="btn ghost" data-act="save">セーブ画面へ</button></div>`;
}

function summaryLine(sm) {
  return `ランク${esc(sm.level)}「${esc(sm.levelName)}」・学習 ${sm.learned.toLocaleString()}字・クリア ${sm.stages}ステージ`;
}

function isStandalone() {
  return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
}

async function viewSave() {
  setTitle('セーブ');
  const sm = summaryOf();
  const sum = srs.summary();
  const savedAt = S.savedAt;
  let persisted = null;
  try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (e) { /* noop */ }
  if (current().name !== 'save') return;
  view.innerHTML = `
    <section class="card save-main">
      <div class="save-head">
        <div class="save-icon" aria-hidden="true">${SAVE_SVG}</div>
        <div>
          <div class="save-title">学習状況は<b>自動セーブ</b>されています</div>
          <div class="muted small">問題に答えるたびに、この端末に保存されます。最終セーブ: <b>${savedAt ? fmtDate(savedAt) : '—'}</b></div>
        </div>
      </div>
      <div class="tiles save-tiles">
        <div class="tile"><span class="tile-lbl">現在のランク</span><span class="tile-val">${esc(sm.level)}<small>${esc(sm.levelName)}</small></span></div>
        <div class="tile"><span class="tile-lbl">学習した漢字</span><span class="tile-val">${sm.learned.toLocaleString()}<small>字</small></span></div>
        <div class="tile"><span class="tile-lbl">クリアしたステージ</span><span class="tile-val">${sm.stages}</span></div>
        <div class="tile"><span class="tile-lbl">定着した漢字</span><span class="tile-val">${sum.master.toLocaleString()}<small>字</small></span></div>
      </div>
      <p class="small ${persisted ? 'good' : 'muted'}">${persisted
        ? '✓ この端末の保存領域は保護されています（自動では削除されません）。'
        : isStandalone()
          ? 'ホーム画面のアプリとして保存しています。念のため、ときどきファイルに書き出しておくと安心です。'
          : '⚠ Safari のタブで開いています。Safari はしばらく使わないサイトのデータを削除することがあります。ホーム画面に追加して使うか、ファイルに書き出しておきましょう。'}</p>
      <div class="btn-row left"><button class="btn primary" id="save-now">今すぐセーブ</button></div>
    </section>

    <section class="card">
      <h3>セーブスロット <small>この端末に最大3つまで保存</small></h3>
      <p class="muted small">今の学習状況をスロットに残しておき、あとでその時点に戻せます。家族で1台の iPad を使うときの切り替えにも使えます。</p>
      <div id="slots" class="slots"><p class="muted">読み込み中…</p></div>
    </section>

    <section class="card">
      <h3>ほかの端末・アプリに引き継ぐ</h3>
      <p class="muted small">Safari で開いたアプリと「ホーム画面に追加」したアプリは、保存場所が別々です。買い替えや別の iPad へ移すときも、下のどちらかで引き継げます。</p>
      <div class="transfer">
        <div class="transfer-box">
          <h4>ファイルで引き継ぐ</h4>
          <p class="muted small">セーブデータ（.json）を iCloud Drive や「ファイル」アプリに保存し、引き継ぎ先で読み込みます。</p>
          <div class="btn-row left">
            <button class="btn ghost" id="exp-file">ファイルに書き出す</button>
            <label class="btn ghost file-btn">ファイルから読み込む<input type="file" id="imp-file" accept="application/json,.json,text/plain,.txt" hidden></label>
          </div>
        </div>
        <div class="transfer-box">
          <h4>セーブコードで引き継ぐ</h4>
          <p class="muted small">学習状況を1行の文字列にします。コピーしてメモや AirDrop で送り、引き継ぎ先で貼り付けます。</p>
          <textarea id="code-out" class="code-box" readonly rows="3" placeholder="作成中…"></textarea>
          <div class="btn-row left">
            <button class="btn ghost" id="code-copy" disabled>セーブコードをコピー</button>
            <button class="btn ghost" id="code-in">セーブコードを貼り付けて読み込む</button>
          </div>
        </div>
      </div>
    </section>

    <section class="card">
      <h3>リセット</h3>
      <p class="muted small">すべての学習記録を消去して最初から始めます。消去前の状態は「自動バックアップ」スロットに残ります。</p>
      <div class="btn-row left"><button class="btn danger" id="rst">学習データをリセット</button></div>
    </section>`;

  $('#save-now').addEventListener('click', () => {
    store.save(true);
    toast('セーブしました');
    viewSave();
  });
  $('#exp-file').addEventListener('click', exportFile);
  $('#imp-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = (await file.text()).trim();
      const data = text.startsWith('ANIKAN') ? await savedata.decodeCode(text) : store.parseJSON(text);
      await loadState(data, 'ファイルのセーブデータ');
    } catch (err) {
      toast(`読み込めませんでした: ${err.message}`);
    }
  });
  $('#code-in').addEventListener('click', pasteCodeDialog);
  $('#rst').addEventListener('click', async () => {
    if (!(await confirmDialog('すべての学習記録（クリア状況・復習予定）を消去します。<br><small>消去前の状態は「自動バックアップ」スロットから戻せます。</small>', 'リセットする'))) return;
    await autoBackup('リセット前');
    S = store.reset();
    toast('学習データをリセットしました');
    go('home', {}, { reset: true });
  });

  // セーブコード（コピーは操作直後でないと失敗するので事前に作っておく）
  savedata.encodeCode(store.snapshot()).then((code) => {
    const out = $('#code-out');
    if (!out) return;
    out.value = code;
    const btn = $('#code-copy');
    btn.disabled = false;
    btn.addEventListener('click', async () => {
      let ok = false;
      try {
        await navigator.clipboard.writeText(code);
        ok = true;
      } catch (e) {
        out.focus();
        out.select();
        try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
      }
      if (ok) {
        store.markBackup();
        toast(`セーブコードをコピーしました（${code.length.toLocaleString()}文字）`);
      } else {
        toast('コピーできませんでした。枠内の文字を長押しして全選択→コピーしてください');
      }
    });
  }).catch(() => { const out = $('#code-out'); if (out) out.value = 'セーブコードを作成できませんでした'; });

  renderSlots();
}

async function renderSlots() {
  const box = $('#slots');
  if (!box) return;
  let recs = [];
  try {
    recs = await slots.list();
  } catch (e) {
    box.innerHTML = '<p class="muted">この環境ではセーブスロットを使えません（プライベートブラウズなど）。ファイルかセーブコードをお使いください。</p>';
    return;
  }
  const byId = Object.fromEntries(recs.map((r) => [r.id, r]));
  const row = (id, label, rec, canSave) => `
    <div class="slot ${rec ? '' : 'empty'}">
      <div class="slot-no">${label}</div>
      <div class="slot-info">${rec
        ? `<div class="slot-sum">${summaryLine(rec.summary)}</div><div class="muted small">${fmtDate(rec.savedAt)} に保存${rec.note ? `・${esc(rec.note)}` : ''}</div>`
        : '<div class="muted">空きスロット</div>'}</div>
      <div class="slot-btns">
        ${canSave ? `<button class="btn ghost small" data-slot-save="${id}">ここにセーブ</button>` : ''}
        ${rec ? `<button class="btn primary small" data-slot-load="${id}">ロード</button>` : ''}
        ${rec && canSave ? `<button class="btn ghost small" data-slot-del="${id}" aria-label="削除">削除</button>` : ''}
      </div>
    </div>`;
  box.innerHTML = SLOT_IDS.map((id, i) => row(id, `スロット${i + 1}`, byId[id], true)).join('')
    + (byId.auto ? row('auto', '自動バックアップ', byId.auto, false) : '');
  box.querySelectorAll('[data-slot-save]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.slotSave;
    if (byId[id] && !(await confirmDialog(`スロット${SLOT_IDS.indexOf(id) + 1}を今の学習状況で上書きしますか？`, '上書きする'))) return;
    try {
      store.save(true);
      await slots.put({ id, savedAt: Date.now(), summary: summaryOf(), data: store.snapshot() });
      toast(`スロット${SLOT_IDS.indexOf(id) + 1}にセーブしました`);
      renderSlots();
    } catch (e) {
      toast('セーブできませんでした');
    }
  }));
  box.querySelectorAll('[data-slot-load]').forEach((b) => b.addEventListener('click', async () => {
    const rec = byId[b.dataset.slotLoad];
    if (!rec) return;
    await loadState(rec.data, b.dataset.slotLoad === 'auto' ? '自動バックアップ' : `スロット${SLOT_IDS.indexOf(rec.id) + 1}`);
  }));
  box.querySelectorAll('[data-slot-del]').forEach((b) => b.addEventListener('click', async () => {
    const id = b.dataset.slotDel;
    if (!(await confirmDialog(`スロット${SLOT_IDS.indexOf(id) + 1}を削除しますか？`, '削除する'))) return;
    await slots.remove(id);
    renderSlots();
  }));
}

async function autoBackup(note) {
  try {
    await slots.put({ id: 'auto', savedAt: Date.now(), note, summary: summaryOf(), data: store.snapshot() });
  } catch (e) { /* スロットが使えない環境では何もしない */ }
}

async function loadState(data, label) {
  let sm;
  try {
    sm = summaryOf(store.validate(data));
  } catch (err) {
    toast(err.message);
    return;
  }
  const ok = await confirmDialog(`${esc(label)}を読み込みますか？<br><b>${summaryLine(sm)}</b><br><small>今の学習状況は「自動バックアップ」スロットに残ります。</small>`, '読み込む');
  if (!ok) return;
  await autoBackup(`${label}を読み込む前`);
  S = store.replaceState(data);
  toast(`${label}を読み込みました`);
  go('home', {}, { reset: true });
}

async function exportFile() {
  const json = store.exportJSON();
  const name = `anikan-save-${store.dayKey()}.json`;
  const file = new File([json], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: 'アニ漢 セーブデータ' });
      store.markBackup();
      toast('共有メニューの「"ファイル"に保存」で iCloud Drive などに保存できます');
      return;
    }
  } catch (e) {
    if (e && e.name === 'AbortError') return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  store.markBackup();
  toast('セーブデータをダウンロードしました（「ファイル」アプリのダウンロードに保存されます）');
}

function pasteCodeDialog() {
  openModal(`<div class="paste-code">
      <h3>セーブコードを貼り付け</h3>
      <p class="muted small">「ANIKAN」で始まるセーブコードを貼り付けてください。</p>
      <textarea class="code-box" rows="6" placeholder="ANIKAN1-…"></textarea>
      <div class="btn-row"><button class="btn primary" data-load>読み込む</button></div>
    </div>`, {
    onMount(body, close) {
      const ta = body.querySelector('textarea');
      body.querySelector('[data-load]').addEventListener('click', async () => {
        try {
          const data = await savedata.decodeCode(ta.value);
          close();
          await loadState(data, 'セーブコード');
        } catch (err) {
          toast(err.message);
        }
      });
    },
  });
}

const SAVE_SVG = '<svg viewBox="0 0 24 24"><path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3"/><rect x="7" y="13" width="10" height="6" rx="1"/></svg>';

/* ------------------------------------------------------------------ */
/* テスト（出題・採点）                                                 */
/* ------------------------------------------------------------------ */
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 例は「アニメのタイトル・キャラクター名（知名度の高い順）→ 頻出語・一般語」の順に並んでいる。
// アニメの名前を優先し、その中でも有名なもの（先頭）ほど出やすくする
const EX_WEIGHT = [0.6, 0.28, 0.12];
function pickExample(e) {
  if (!e.ex.length) return null;
  const anime = e.ex.filter((x) => x[2] === 't' || x[2] === 'c');
  const other = e.ex.filter((x) => x[2] !== 't' && x[2] !== 'c');
  if (anime.length && (!other.length || Math.random() < 0.75)) {
    const w = EX_WEIGHT.slice(0, anime.length);
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < anime.length; i++) {
      r -= w[i] ?? 0;
      if (r < 0) return anime[i];
    }
    return anime[0];
  }
  return other[Math.floor(Math.random() * other.length)];
}

function startQuiz(mode, items, extra = {}) {
  if (!items.length) {
    toast('出題できる漢字がありません');
    return;
  }
  quiz = {
    mode, items, i: 0, answers: [], ...extra,
    per: mode === 'stage' ? 10 : mode === 'exam' ? 5 : 100 / items.length,
  };
  nextQuestion();
  go('quiz', {}, { replace: current().name === 'quiz' || current().name === 'result' });
}

function startStage(g) {
  if (!stageOpen(g) && !isCleared(g)) { toast('前のステージをクリアすると挑戦できます'); return; }
  startQuiz('stage', shuffle(K.stageChars(g)), { g });
}

function startExam(key) {
  const spec = examSpec(key);
  if (!spec.open) { toast('前のランクの昇格試験に合格すると挑戦できます'); return; }
  startQuiz('exam', shuffle(spec.chars).slice(0, 20), { examKey: spec.key, examTitle: spec.title });
}

function startReview() {
  const due = srs.dueList();
  startQuiz('review', due.slice(0, Number(S.settings.reviewSize) || 20));
}

function startAhead() {
  const all = Object.keys(S.srs).sort((a, b) => S.srs[a].due - S.srs[b].due);
  startQuiz('ahead', all.slice(0, Number(S.settings.reviewSize) || 20));
}

function startWeak() {
  startQuiz('weak', shuffle(srs.weakList(Number(S.settings.reviewSize) || 20)));
}

function nextQuestion() {
  const ch = quiz.items[quiz.i];
  const e = K.byChar(ch);
  quiz.cur = { ch, e, ex: pickExample(e), phase: 'write', cands: null, ok: null, img: null, hint: !!S.settings.showHint };
}

const MODE_LABEL = { stage: 'ステージテスト', exam: '昇格試験', review: '復習', ahead: '前倒し復習', weak: '苦手克服' };

function quizScore() {
  const ok = quiz.answers.filter((a) => a.ok).length;
  if (quiz.mode === 'stage' || quiz.mode === 'exam') return ok * quiz.per;
  return Math.round((ok / quiz.items.length) * 100);
}

function viewQuiz() {
  if (pad) { pad.destroy(); pad = null; }
  if (!quiz) { back(); return; }
  const q = quiz.cur;
  const e = q.e;
  const n = quiz.items.length;
  const title = quiz.mode === 'stage'
    ? `ランク${K.levelOfStage(quiz.g).key} ステージ${K.stageNoInLevel(quiz.g)}`
    : quiz.mode === 'exam' ? quiz.examTitle : MODE_LABEL[quiz.mode];
  setTitle(title);
  $('#topbar-right').innerHTML = `<span class="score-pill">${quizScore()}<small>点</small></span>`;
  const dots = quiz.items.map((_, i) => {
    const a = quiz.answers[i];
    return `<i class="${a ? (a.ok ? 'ok' : 'ng') : i === quiz.i ? 'cur' : ''}"></i>`;
  }).join('');

  let prompt;
  if (q.ex) {
    prompt = `<div class="q-label">${esc(K.exampleLabel(q.ex))}</div>
      <div class="q-reading">${esc(q.ex[1])}</div>
      <div class="q-text">${exampleHTML(q.ex, q.ch, q.phase === 'write' || q.phase === 'checking' ? 'blank' : 'show')}</div>
      <div class="q-ask">□に入る漢字を書きましょう</div>`;
  } else {
    prompt = `<div class="q-label">読みから書こう</div>
      <div class="q-text q-noex"><span class="blank"></span></div>
      ${readingsHTML(e, { compact: true })}
      <div class="q-ask">この読みの漢字を書きましょう</div>`;
  }
  const hintOpen = q.hint || !q.ex || q.phase === 'feedback' || q.phase === 'self';
  const hint = `<div class="hint ${hintOpen ? 'open' : ''}">
      <div class="hint-body">
        ${q.ex ? readingsHTML(e, { compact: true }) : ''}
        <div class="kdetail-tags">${e.b ? `<span class="tag">部首 ${esc(e.b)}</span>` : ''}<span class="tag">${e.s}画</span>${e.v ? `<span class="tag">異体字 ${esc(e.v)}</span>` : ''}</div>
        ${e.m ? `<div class="hint-m">意味: ${esc(e.m)}</div>` : ''}
      </div>
      ${q.ex && !hintOpen ? '<button class="btn ghost small" data-act="hint">ヒントを見る</button>' : ''}
    </div>`;

  let side;
  if (q.phase === 'feedback' || q.phase === 'self') {
    const okCls = q.ok ? 'ok' : 'ng';
    const cand = q.cands && q.cands.length ? `<div class="cands">認識結果: ${q.cands.slice(0, 5).map((c, i) => `<span class="${c === q.ch ? 'hit' : ''}">${i + 1}. ${esc(c)}</span>`).join('')}</div>` : '';
    const verdict = q.phase === 'self'
      ? '<div class="verdict self">お手本と見比べて採点してください</div>'
      : `<div class="verdict ${okCls}"><span class="mark">${q.ok ? '○' : '×'}</span>${q.ok ? '正解！' : '不正解'}${q.overridden ? '<small>（自己判定）</small>' : ''}</div>`;
    const compare = `<div class="compare">
        <figure><figcaption>あなたの字</figcaption>${q.img ? `<img src="${q.img}" alt="あなたが書いた字">` : '<div class="empty-ink">（未記入）</div>'}</figure>
        <figure><figcaption>正解</figcaption><div class="answer-k">${esc(q.ch)}</div></figure>
      </div>`;
    let btns;
    if (q.phase === 'self') {
      btns = `<div class="btn-row"><button class="btn ng-btn big" data-act="self-ng">× 書けなかった</button><button class="btn ok-btn big" data-act="self-ok">○ 書けた</button></div>`;
    } else {
      btns = `<div class="btn-row">
        ${!q.ok && q.cands && !q.overridden ? '<button class="btn ghost" data-act="override">認識ミス（正解にする）</button>' : ''}
        <button class="btn primary big" data-act="next">${quiz.i + 1 >= n ? '結果を見る' : '次の問題へ'}</button></div>`;
    }
    side = `<div class="feedback">${verdict}${compare}${cand}${btns}</div>`;
  } else {
    side = `<div class="pad-holder"></div>
      <div class="pad-tools">
        <button class="btn ghost" data-act="undo">1画戻す</button>
        <button class="btn ghost" data-act="clear">消す</button>
        <button class="btn ghost" data-act="skip">わからない</button>
        <button class="btn primary big" data-act="submit">${S.settings.judge === 'self' ? '答え合わせ' : '判定する'}</button>
      </div>
      ${q.phase === 'checking' ? '<div class="checking"><span class="spinner"></span>認識中…</div>' : ''}`;
  }

  view.innerHTML = `
    <div class="quiz">
      <div class="quiz-progress"><span>${MODE_LABEL[quiz.mode]}　第${quiz.i + 1}問 / ${n}</span><span class="dots">${dots}</span></div>
      <div class="quiz-main">
        <section class="card prompt">${prompt}${hint}</section>
        <section class="card answer ${q.phase}">${side}</section>
      </div>
    </div>`;

  if (q.phase === 'write' || q.phase === 'checking') {
    pad = new InkPad(view.querySelector('.pad-holder'), padOpts());
    if (q.strokes) { pad.strokes = q.strokes; pad.redraw(); }
  }
}

async function submitAnswer() {
  const q = quiz.cur;
  if (q.phase !== 'write') return;
  if (pad.isEmpty()) {
    toast('Apple Pencil か指で□に入る漢字を書いてください');
    return;
  }
  q.img = pad.toDataURL();
  q.strokes = pad.strokes;
  if (S.settings.judge === 'self' || isDown() || navigator.onLine === false) {
    if (S.settings.judge !== 'self' && !toast._offlineShown) {
      toast._offlineShown = true;
      toast('オフラインのため自己採点で答え合わせします');
    }
    q.phase = 'self';
    viewQuiz();
    return;
  }
  const ink = pad.toInk();
  const w = pad.w, h = pad.h;
  Object.assign(q, { ink, w, h, pen: pad.strokes.every((s) => s.pen) });
  q.phase = 'checking';
  viewQuiz();
  try {
    const rank = K.rankOfIndex(K.indexOf(q.ch));
    const cands = await recognize(ink, w, h, { target: q.ch, rare: rank >= 4, strokes: (K.byChar(q.ch) || {}).s || 0 });
    if (quiz && quiz.cur === q) {
      q.cands = cands;
      q.ok = judge(cands, q.ch, Number(S.settings.strict) || 1);
      q.phase = 'feedback';
      viewQuiz();
    }
  } catch (err) {
    if (quiz && quiz.cur === q) {
      toast('手書き認識に接続できないため、自己採点に切り替えました');
      toast._offlineShown = true;
      q.phase = 'self';
      viewQuiz();
    }
  }
}

function finalizeAnswer() {
  const q = quiz.cur;
  const ch = q.ch;
  const isNew = !S.srs[ch];
  if (quiz.mode === 'review' || quiz.mode === 'ahead') srs.review(ch, q.ok);
  else srs.softUpdate(ch, q.ok);
  store.logAnswer(q.ok, isNew);
  quiz.answers.push({ ch, ok: q.ok, img: q.img, ex: q.ex, overridden: !!q.overridden });
  store.save();
  quiz.i++;
  if (quiz.i >= quiz.items.length) {
    finishQuiz();
  } else {
    nextQuestion();
    render();
  }
}

function finishQuiz() {
  const score = quizScore();
  const res = { mode: quiz.mode, g: quiz.g, examKey: quiz.examKey, examTitle: quiz.examTitle, score, answers: quiz.answers, total: quiz.items.length, passed: score >= PASS };
  let firstClear = false;
  if (quiz.mode === 'stage') {
    const prev = S.cleared[quiz.g];
    firstClear = res.passed && !(prev >= PASS);
    S.cleared[quiz.g] = Math.max(prev ?? 0, score);
    S.attempts[quiz.g] = (S.attempts[quiz.g] || 0) + 1;
  } else if (quiz.mode === 'exam') {
    const prev = S.exams[quiz.examKey];
    firstClear = res.passed && !(prev >= PASS);
    S.exams[quiz.examKey] = Math.max(prev ?? 0, score);
  }
  res.firstClear = firstClear;
  store.save(true);
  lastResult = res;
  quiz = null;
  go('result', {}, { replace: true });
}

async function confirmQuit() {
  if (!quiz) { stack.pop(); render(); return; }
  const ok = await confirmDialog('テストを中断しますか？<br><small>ここまでの解答は復習の記録に反映されます。</small>', '中断する', '続ける');
  if (!ok) return;
  quiz = null;
  stack.pop();
  render();
}

function viewResult() {
  const res = lastResult;
  if (!res) { go('home', {}, { reset: true }); return; }
  const isTest = res.mode === 'stage' || res.mode === 'exam';
  const stageTitle = (g) => `ランク${K.levelOfStage(g).key} ステージ${K.stageNoInLevel(g)}`;
  setTitle(isTest ? (res.mode === 'stage' ? `${stageTitle(res.g)} 結果` : `${res.examTitle} 結果`) : '復習の結果');
  const okN = res.answers.filter((a) => a.ok).length;
  let msg = '';
  let actions = '';
  if (res.mode === 'stage') {
    const g = res.g;
    const L = K.levelOfStage(g);
    const lastInLevel = g === L.firstStage + L.stages - 1;
    if (res.passed) {
      msg = res.firstClear ? (lastInLevel ? `ランク${L.key}の全ステージをクリア！昇格試験に挑戦できます。` : '次のステージが解放されました！') : '合格！';
      actions = lastInLevel
        ? (levelPassed(L)
          ? (K.LEVELS[L.idx + 1] ? `<button class="btn primary big" data-act="stage" data-g="${g + 1}">次のステージへ</button>` : '')
          : `<button class="btn primary big" data-act="exam" data-key="${L.key}">昇格試験へ</button>`)
        : `<button class="btn primary big" data-act="stage" data-g="${g + 1}">次のステージへ</button>`;
      actions = `<button class="btn ghost" data-act="start-stage" data-g="${g}">もう一度</button>${actions}`;
    } else {
      msg = `合格まであと${PASS - res.score}点。間違えた字を確認して再挑戦しよう！`;
      actions = `<button class="btn ghost" data-act="stage" data-g="${g}">漢字を確認する</button><button class="btn primary big" data-act="start-stage" data-g="${g}">再挑戦</button>`;
    }
  } else if (res.mode === 'exam') {
    const spec = examSpec(res.examKey);
    if (res.passed) {
      const nx = spec.next;
      msg = nx ? `昇格！${K.levelLabel(nx)}が解放されました。` : '最終ランクの昇格試験に合格！おめでとうございます！';
      actions = nx ? `<button class="btn primary big" data-act="stage" data-g="${nx.firstStage}">ランク${nx.key}へ進む</button>` : '';
    } else {
      msg = `合格まであと${PASS - res.score}点。ステージで復習してから再挑戦しよう。`;
      actions = `<button class="btn ghost" data-act="rank" data-r="${spec.rank}" data-focus="${spec.L ? spec.L.key : ''}">ランク${spec.L ? spec.L.key : spec.rank}へ</button><button class="btn primary big" data-act="exam" data-key="${spec.key}">再挑戦</button>`;
    }
  } else {
    msg = okN === res.total ? 'パーフェクト！記憶の安定度がアップしました。' : '間違えた字は10分後から覚え直します。';
    const due = srs.dueList().length;
    actions = due ? `<button class="btn accent big" data-act="review">続けて復習（残り${due}字）</button>` : '<button class="btn primary big" data-act="home">ホームへ</button>';
  }
  const list = res.answers.map((a) => {
    const it = S.srs[a.ch];
    return `<button class="res-item ${a.ok ? 'ok' : 'ng'}" data-act="kanji" data-ch="${esc(a.ch)}">
      <span class="res-mark">${a.ok ? '○' : '×'}</span>
      <span class="res-k">${esc(a.ch)}</span>
      ${a.img ? `<img src="${a.img}" alt="">` : '<span class="res-noimg">—</span>'}
      <span class="res-next">${it ? '次回 ' + (it.due <= Date.now() ? '今すぐ' : fmtDate(it.due)) : ''}</span></button>`;
  }).join('');
  view.innerHTML = `
    <section class="card result ${isTest ? (res.passed ? 'passed' : 'failed') : ''}">
      <div class="result-score"><span class="num">${res.score}</span><span class="unit">点</span><span class="of">/ 100</span></div>
      ${isTest ? `<div class="stamp ${res.passed ? 'pass' : 'fail'}">${res.passed ? '合格' : '不合格'}</div>` : ''}
      <div class="result-sub">${okN} / ${res.total}問 正解${isTest ? `（合格ライン ${PASS}点）` : ''}</div>
      <p class="result-msg">${esc(msg)}</p>
      <div class="btn-row">${actions}</div>
    </section>
    <h3 class="sec-title">解答一覧 <small>タップで詳しく・次回復習日</small></h3>
    <div class="res-list">${list}</div>`;
}

/* ------------------------------------------------------------------ */
/* チャレンジモード: アニメタイトル・キャラクター名を全部書く             */
/* ------------------------------------------------------------------ */
const LIVES = 5;
const CH_MODES = { mix: 'ミックス', title: 'タイトルだけ', char: 'キャラクターだけ' };
const isKanjiChar = (c) => /[㐀-鿿豈-﫿]/.test(c);
let CH = null;
let game = null;
let lastGame = null;

function loadChallengeData() {
  if (CH) return Promise.resolve(CH);
  const prep = () => {
    const D = window.CHALLENGE_DATA;
    const titles = D.titles.map(([text, read], i) => ({ id: `t:${text}`, kind: 't', text, read, rank: i }));
    const chars = D.chars.map(([text, read, w], i) => ({ id: `c:${text}|${D.works[w]}`, kind: 'c', text, read, work: D.works[w], rank: i }));
    CH = { titles, chars, byId: new Map([...titles, ...chars].map((x) => [x.id, x])) };
    migrateNames(CH);
    return CH;
  };
  if (window.CHALLENGE_DATA) return Promise.resolve(prep());
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'data/challenge-data.js';
    s.onload = () => resolve(prep());
    s.onerror = () => { s.remove(); reject(new Error('チャレンジ用データを読み込めませんでした')); };
    document.head.appendChild(s);
  });
}

function nameLabel(it) {
  return it.kind === 't' ? 'アニメタイトル' : `『${it.work}』の登場人物`;
}

// データの更新で作品名が変わった（例: 「*昭和の名作アニメ」→「ゲゲゲの鬼太郎」）名前の復習記録を新しい名前につなぎ直す。
// 収録されなくなった名前の記録は、復習できないまま残らないよう消す
function migrateNames(ch) {
  const map = S.csrs || {};
  const charByText = new Map();
  for (const it of ch.chars) if (!charByText.has(it.text)) charByText.set(it.text, it);
  const titleByText = new Map(ch.titles.map((it) => [it.text, it]));
  let changed = false;
  for (const id of Object.keys(map)) {
    if (ch.byId.has(id)) continue;
    const isChar = id.startsWith('c:');
    const text = isChar ? id.slice(2).split('|')[0] : id.slice(2);
    const it = (isChar ? charByText : titleByText).get(text);
    if (it && !map[it.id]) map[it.id] = map[id];
    delete map[id];
    changed = true;
  }
  if (changed) {
    store.save();
    updateBadge();
  }
}

function nameDueList() {
  return srs.names.dueList();
}

function showNameItem(id) {
  const it = CH && CH.byId.get(id);
  const rec = srs.names.get(id);
  const [kind, rest] = [id.slice(0, 1), id.slice(2)];
  const text = it ? it.text : rest.split('|')[0];
  openModal(`<div class="intro">
      <div class="name-big">${esc(text)}</div>
      ${it ? `<div class="q-reading">${esc(it.read)}</div><div class="q-label">${esc(nameLabel(it))}</div>` : `<div class="q-label">${kind === 't' ? 'アニメタイトル' : '登場人物'}</div>`}
      ${rec ? `<p class="muted">間違えた回数 ${rec.lapses}回・次回の復習 <b>${rec.due <= Date.now() ? '今すぐ' : fmtDate(rec.due)}</b></p>` : ''}
    </div>`);
}

function viewChallenge() {
  setTitle('チャレンジ');
  const best = (S.challenge && S.challenge.best) || {};
  const mode = S.settings.challengeMode || 'mix';
  const due = nameDueList().length;
  view.innerHTML = `
    <section class="card challenge-hero">
      <div class="ch-badge" aria-hidden="true">挑</div>
      <div>
        <h2>チャレンジモード</h2>
        <p class="muted">メジャーなアニメの<b>タイトル</b>と<b>キャラクター名</b>を、漢字ひと文字も間違えずに全部書けるか挑戦！<br>
        <b class="lives-inline">♥×${LIVES}</b> 5回間違えたらゲームオーバー。間違えた名前は「復習」に追加されます。</p>
      </div>
    </section>
    <section class="card">
      <h3>出題</h3>
      <div class="seg ch-mode">${Object.entries(CH_MODES).map(([k, v]) => `<label class="seg-opt"><input type="radio" name="chmode" value="${k}" ${k === mode ? 'checked' : ''}><span>${v}</span></label>`).join('')}</div>
      <p class="muted small" id="ch-count">データを読み込み中…</p>
      <div class="ch-best">${Object.entries(CH_MODES).map(([k, v]) => `<div class="tile"><span class="tile-lbl">ベスト（${v}）</span><span class="tile-val">${best[k] ?? 0}<small>問</small></span></div>`).join('')}</div>
      <div class="btn-row"><button class="btn primary big" id="ch-start" disabled>チャレンジ開始</button></div>
      <p class="muted small center">はじめは有名な作品から、正解するほど幅広い作品から出題されます。</p>
    </section>
    <section class="card">
      <h3>間違えた名前の復習 <small>${due}件が復習待ち</small></h3>
      <p class="muted small">チャレンジで書けなかったタイトル・キャラクター名は、忘却曲線に沿って復習に出題されます（ライフなし）。</p>
      <div class="btn-row left"><button class="btn accent" data-act="name-review" ${due ? '' : 'disabled'}>名前の復習をはじめる</button></div>
    </section>`;
  view.querySelectorAll('input[name="chmode"]').forEach((inp) => inp.addEventListener('change', () => {
    S.settings.challengeMode = inp.value;
    store.save();
  }));
  loadChallengeData().then((d) => {
    const c = $('#ch-count');
    if (!c) return;
    c.textContent = `収録: アニメタイトル ${d.titles.length.toLocaleString()}件・キャラクター名 ${d.chars.length.toLocaleString()}件`;
    const b = $('#ch-start');
    b.disabled = false;
    b.addEventListener('click', () => startChallenge(S.settings.challengeMode || 'mix'));
  }).catch((e) => {
    const c = $('#ch-count');
    if (c) c.textContent = `${e.message}。通信状態を確認して開き直してください。`;
  });
}

function pickChallengeItem() {
  const wantTitle = game.mode === 'title' || (game.mode === 'mix' && Math.random() < 0.4);
  const pool = wantTitle ? CH.titles : CH.chars;
  // 最初は有名どころ（上位）から、問題が進むほど出題範囲を広げる
  const n = Math.min(pool.length, 150 + game.qn * 60);
  for (let t = 0; t < 60; t++) {
    const it = pool[Math.floor(Math.random() * n)];
    if (!game.used.has(it.id)) { game.used.add(it.id); return it; }
  }
  const it = pool.find((x) => !game.used.has(x.id)) || pool[0];
  game.used.add(it.id);
  return it;
}

function newChallengeQuestion(item) {
  const chars = Array.from(item.text);
  const boxes = [];
  chars.forEach((c, pos) => { if (isKanjiChar(c)) boxes.push({ pos, ch: c, strokes: null, img: null, ink: null, ok: null, cands: null }); });
  game.cur = { item, chars, boxes, bi: 0, phase: 'write', ok: null };
}

async function startChallenge(mode) {
  try { await loadChallengeData(); } catch (e) { toast(e.message); return; }
  game = { mode, lives: LIVES, score: 0, qn: 0, used: new Set(), history: [], missed: [] };
  newChallengeQuestion(pickChallengeItem());
  go('cgame', {}, { replace: current().name === 'cresult' });
}

async function startNameReview() {
  try { await loadChallengeData(); } catch (e) { toast(e.message); return; }
  const ids = nameDueList().filter((id) => CH.byId.has(id)).slice(0, Number(S.settings.reviewSize) || 20);
  if (!ids.length) { toast('復習待ちの名前はありません'); return; }
  game = { mode: 'review', items: ids.map((id) => CH.byId.get(id)), lives: Infinity, score: 0, qn: 0, used: new Set(), history: [], missed: [] };
  newChallengeQuestion(game.items[0]);
  go('cgame', {}, { replace: current().name === 'cresult' });
}

function saveBox() {
  const q = game.cur;
  const b = q.boxes[q.bi];
  if (!pad || !b) return;
  if (pad.isEmpty()) {
    Object.assign(b, { strokes: null, img: null, ink: null });
  } else {
    Object.assign(b, { strokes: pad.strokes, img: pad.toDataURL(), ink: pad.toInk(), w: pad.w, h: pad.h });
  }
}

function heartsHTML() {
  if (game.mode === 'review') return '';
  return `<span class="hearts" aria-label="ライフ残り${game.lives}">${Array.from({ length: LIVES }, (_, i) => `<i class="${i < game.lives ? 'on' : 'off'}">♥</i>`).join('')}</span>`;
}

function viewCGame() {
  if (pad) { pad.destroy(); pad = null; }
  if (!game) { back(); return; }
  const q = game.cur;
  const it = q.item;
  const isReview = game.mode === 'review';
  setTitle(isReview ? '名前の復習' : 'チャレンジ');
  $('#topbar-right').innerHTML = `<span class="score-pill">${game.score}<small>問正解</small></span>`;
  const write = q.phase === 'write' || q.phase === 'checking';
  const nameHTML = q.chars.map((c, pos) => {
    const bi = q.boxes.findIndex((b) => b.pos === pos);
    if (bi < 0) return `<span class="ctext">${esc(c)}</span>`;
    const b = q.boxes[bi];
    if (write) {
      return `<button class="cbox ${bi === q.bi ? 'cur' : ''} ${b.img ? 'filled' : ''}" data-act="cbox" data-bi="${bi}" aria-label="${bi + 1}字目">${b.img ? `<img src="${b.img}" alt="">` : ''}</button>`;
    }
    const cls = q.phase === 'self' ? '' : b.ok ? 'ok' : 'ng';
    return `<span class="cans ${cls}">${esc(c)}</span>`;
  }).join('');
  const prompt = `
    <div class="q-label">${esc(nameLabel(it))}</div>
    <div class="q-reading">${esc(it.read)}</div>
    <div class="cname">${nameHTML}</div>
    <div class="q-ask">${write ? `□の漢字をすべて書きましょう（${q.boxes.length}字中 <b>${q.bi + 1}字目</b>）` : q.phase === 'self' ? 'お手本と見比べて採点してください' : ''}</div>`;
  let side;
  if (write) {
    const last = q.bi === q.boxes.length - 1;
    side = `<div class="pad-holder"></div>
      <div class="pad-tools">
        <button class="btn ghost" data-act="undo">1画戻す</button>
        <button class="btn ghost" data-act="clear">消す</button>
        <button class="btn ghost" data-act="cprev" ${q.bi === 0 ? 'disabled' : ''}>◀ 前の字</button>
        ${last ? `<button class="btn primary big" data-act="csubmit">${S.settings.judge === 'self' ? '答え合わせ' : '判定する'}</button>`
          : '<button class="btn primary big" data-act="cnext">次の字 ▶</button>'}
      </div>
      <div class="btn-row"><button class="btn ghost small" data-act="cgiveup">わからない</button></div>
      ${q.phase === 'checking' ? '<div class="checking"><span class="spinner"></span>認識中…</div>' : ''}`;
  } else {
    const verdict = q.phase === 'self'
      ? '<div class="verdict self">全部正しく書けましたか？</div>'
      : `<div class="verdict ${q.ok ? 'ok' : 'ng'}"><span class="mark">${q.ok ? '○' : '×'}</span>${q.ok ? '全部正解！' : '不正解'}${q.overridden ? '<small>（自己判定）</small>' : ''}</div>`;
    const grid = `<div class="ccompare">${q.boxes.map((b) => `
        <figure class="${q.phase === 'self' ? '' : b.ok ? 'ok' : 'ng'}">
          ${b.img ? `<img src="${b.img}" alt="">` : '<div class="empty-ink">—</div>'}
          <figcaption><span class="answer-k small">${esc(b.ch)}</span>${b.cands && !b.ok ? `<span class="cand-mini">認識: ${esc(b.cands.slice(0, 3).join(' '))}</span>` : ''}</figcaption>
        </figure>`).join('')}</div>`;
    let btns;
    if (q.phase === 'self') {
      btns = '<div class="btn-row"><button class="btn ng-btn big" data-act="cself-ng">× 書けなかった</button><button class="btn ok-btn big" data-act="cself-ok">○ 全部書けた</button></div>';
    } else {
      const willEnd = !q.ok && game.lives - 1 <= 0 && !isReview;
      const lastReview = isReview && game.qn + 1 >= game.items.length;
      btns = `<div class="btn-row">
        ${!q.ok && !q.overridden && q.boxes.some((b) => b.cands) ? '<button class="btn ghost" data-act="coverride">認識ミス（正解にする）</button>' : ''}
        <button class="btn primary big" data-act="cfinal">${willEnd || lastReview ? '結果を見る' : '次の問題へ'}</button></div>
        ${!q.ok && !isReview ? `<p class="muted small center">この名前は「復習」に追加されます${willEnd ? '' : `（残りライフ ${game.lives - 1}）`}</p>` : ''}`;
    }
    side = `<div class="feedback">${verdict}${grid}${btns}</div>`;
  }
  const progress = isReview ? `名前の復習　第${game.qn + 1}問 / ${game.items.length}` : `チャレンジ（${CH_MODES[game.mode]}）　第${game.qn + 1}問`;
  view.innerHTML = `
    <div class="quiz cgame">
      <div class="quiz-progress"><span>${progress}</span>${heartsHTML()}</div>
      <div class="quiz-main">
        <section class="card prompt">${prompt}</section>
        <section class="card answer ${q.phase}">${side}</section>
      </div>
    </div>`;
  if (write) {
    pad = new InkPad(view.querySelector('.pad-holder'), padOpts());
    const b = q.boxes[q.bi];
    if (b && b.strokes) { pad.strokes = b.strokes; pad.redraw(); }
  }
}

function cMove(to) {
  const q = game.cur;
  saveBox();
  q.bi = Math.max(0, Math.min(q.boxes.length - 1, to));
  viewCGame();
}

async function cSubmit() {
  const q = game.cur;
  if (q.phase !== 'write') return;
  saveBox();
  const empty = q.boxes.findIndex((b) => !b.ink);
  if (empty >= 0) {
    toast(`${empty + 1}字目がまだ書かれていません`);
    q.bi = empty;
    viewCGame();
    return;
  }
  if (S.settings.judge === 'self' || isDown() || navigator.onLine === false) {
    q.phase = 'self';
    viewCGame();
    return;
  }
  q.phase = 'checking';
  viewCGame();
  try {
    const strict = Number(S.settings.strict) || 1;
    const res = await Promise.all(q.boxes.map((b) => {
      const i = K.indexOf(b.ch);
      return recognize(b.ink, b.w, b.h, { target: b.ch, rare: i < 0 || K.rankOfIndex(i) >= 4, strokes: i >= 0 ? K.KANJI[i].s : 0 });
    }));
    if (!game || game.cur !== q) return;
    q.boxes.forEach((b, i) => { b.cands = res[i]; b.ok = judge(res[i], b.ch, strict); });
    q.ok = q.boxes.every((b) => b.ok);
    q.phase = 'feedback';
  } catch (e) {
    if (!game || game.cur !== q) return;
    toast('手書き認識に接続できないため、自己採点に切り替えました');
    q.phase = 'self';
  }
  viewCGame();
}

function cGiveUp() {
  const q = game.cur;
  saveBox();
  q.boxes.forEach((b) => { b.ok = false; });
  q.ok = false;
  q.phase = 'feedback';
  viewCGame();
}

function cFinalize() {
  const q = game.cur;
  const it = q.item;
  const now = Date.now();
  if (game.mode === 'review') {
    srs.names.review(it.id, q.ok, now);
  } else if (!q.ok) {
    // 間違えた名前はすぐに復習待ちへ
    const rec = srs.names.softUpdate(it.id, false, now);
    rec.due = now;
  } else if (srs.names.get(it.id)) {
    srs.names.softUpdate(it.id, true, now);
  }
  store.logAnswer(q.ok, false);
  game.history.push({ item: it, ok: q.ok, imgs: q.boxes.map((b) => b.img) });
  if (q.ok) game.score++;
  else { game.lives--; game.missed.push(it); }
  game.qn++;
  store.save();
  const over = game.mode === 'review' ? game.qn >= game.items.length : game.lives <= 0;
  if (over) {
    finishChallenge();
    return;
  }
  newChallengeQuestion(game.mode === 'review' ? game.items[game.qn] : pickChallengeItem());
  viewCGame();
}

function finishChallenge(quit = false) {
  const g = game;
  const res = { mode: g.mode, score: g.score, total: g.qn, history: g.history, missed: g.missed, quit, newBest: false };
  if (g.mode !== 'review') {
    S.challenge = S.challenge || { best: {}, plays: 0 };
    S.challenge.best = S.challenge.best || {};
    const prev = S.challenge.best[g.mode] ?? 0;
    if (g.score > prev) { S.challenge.best[g.mode] = g.score; res.newBest = g.qn > 0; }
    res.best = Math.max(prev, g.score);
    S.challenge.plays = (S.challenge.plays || 0) + 1;
  }
  store.save(true);
  lastGame = res;
  game = null;
  go('cresult', {}, { replace: true });
}

async function confirmChallengeQuit() {
  const isReview = game && game.mode === 'review';
  const ok = await confirmDialog(isReview ? '名前の復習を中断しますか？' : 'チャレンジを終了しますか？<br><small>ここまでの正解数が記録されます。</small>', isReview ? '中断する' : '終了する', '続ける');
  if (!ok || !game) return;
  if (isReview) { game = null; stack.pop(); render(); return; }
  finishChallenge(true);
}

function viewCResult() {
  const r = lastGame;
  if (!r) { go('challenge', {}, { reset: true }); return; }
  const isReview = r.mode === 'review';
  setTitle(isReview ? '名前の復習 結果' : 'チャレンジ 結果');
  const due = nameDueList().length;
  const list = r.history.map((h) => `<button class="name-item ${h.ok ? 'ok' : 'ng'}" data-act="name-item" data-id="${esc(h.item.id)}">
      <span class="res-mark">${h.ok ? '○' : '×'}</span>
      <span class="name-text">${esc(h.item.text)}<small>${esc(h.item.read)}</small></span>
      <span class="name-src">${esc(nameLabel(h.item))}</span></button>`).join('');
  view.innerHTML = `
    <section class="card result ${isReview ? '' : 'challenge-over'}">
      ${isReview ? '' : `<div class="gameover">${r.quit ? 'FINISH' : 'GAME OVER'}</div>`}
      <div class="result-score"><span class="num">${r.score}</span><span class="unit">問正解</span>${isReview ? `<span class="of">/ ${r.total}</span>` : ''}</div>
      ${r.newBest ? '<div class="stamp pass">新記録</div>' : ''}
      ${isReview ? '' : `<div class="result-sub">${esc(CH_MODES[r.mode])}・ベスト ${r.best}問</div>`}
      <p class="result-msg">${r.missed.length ? `書けなかった ${r.missed.length}件を「復習」に追加しました。` : isReview ? '全部書けました！' : ''}</p>
      <div class="btn-row">
        ${due ? `<button class="btn accent" data-act="name-review">間違えた名前を復習（${due}件）</button>` : ''}
        ${isReview ? '<button class="btn primary big" data-act="challenge-home">チャレンジへ</button>' : `<button class="btn primary big" data-act="challenge-again" data-mode="${r.mode}">もう一度挑戦</button>`}
      </div>
    </section>
    <h3 class="sec-title">出題された名前 <small>タップで読みと復習予定</small></h3>
    <div class="name-list">${list || '<p class="muted">まだ解答していません</p>'}</div>`;
}

/* ------------------------------------------------------------------ */
/* イベント                                                             */
/* ------------------------------------------------------------------ */
const VIEWS = {
  home: viewHome, ranks: viewRanks, rank: viewRank, stage: viewStage,
  review: viewReview, dict: viewDict, settings: viewSettings, quiz: viewQuiz, result: viewResult,
  save: viewSave, challenge: viewChallenge, cgame: viewCGame, cresult: viewCResult,
};

view.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const a = el.dataset.act;
  const q = quiz && quiz.cur;
  switch (a) {
    case 'home': go('home', {}, { reset: true }); break;
    case 'save': go('save'); break;
    // チャレンジ
    case 'challenge-home': go('challenge', {}, { reset: true }); break;
    case 'challenge-again': startChallenge(el.dataset.mode || 'mix'); break;
    case 'name-review': startNameReview(); break;
    case 'name-item': showNameItem(el.dataset.id); break;
    case 'cbox': if (game && game.cur.phase === 'write') cMove(Number(el.dataset.bi)); break;
    case 'cprev': if (game) cMove(game.cur.bi - 1); break;
    case 'cnext': if (game) cMove(game.cur.bi + 1); break;
    case 'csubmit': if (game) cSubmit(); break;
    case 'cgiveup': if (game) cGiveUp(); break;
    case 'cself-ok': if (game) { game.cur.ok = true; game.cur.boxes.forEach((b) => { b.ok = true; }); cFinalize(); } break;
    case 'cself-ng': if (game) { game.cur.ok = false; cFinalize(); } break;
    case 'coverride': if (game) {
      const cq = game.cur;
      cq.boxes.forEach((b) => {
        if (!b.ok && b.cands && b.ink) misreads.add({ mode: 'challenge', target: b.ch, name: cq.item.text, cands: b.cands, info: b.cands.info, w: b.w, h: b.h, ink: b.ink, pen: (b.strokes || []).every((s) => s.pen) });
        b.ok = true;
      });
      cq.ok = true; cq.overridden = true; viewCGame();
    } break;
    case 'cfinal': if (game) cFinalize(); break;
    case 'rank': {
      const r = Number(el.dataset.r);
      go('rank', { r, focus: el.dataset.focus || null }, { replace: current().name === 'result' });
      break;
    }
    case 'stage': {
      const g = Number(el.dataset.g);
      if (!stageOpen(g) && !isCleared(g)) { toast('前のステージを90点以上でクリアすると解放されます'); break; }
      const L = K.levelOfStage(g);
      const fromResult = current().name === 'result';
      if (fromResult) stack.pop();
      if (current().name === 'stage') stack.pop();
      // 戻るボタンでそのランクのステージ一覧に戻れるようにする
      const rankIdx = stack.findIndex((s) => s.name === 'rank' && s.params.r === L.rank);
      if (rankIdx >= 0) {
        stack[rankIdx].params.focus = L.key;
      } else if (current().name !== 'rank') {
        stack.push({ name: 'rank', params: { r: L.rank, focus: L.key } });
      }
      go('stage', { g });
      break;
    }
    case 'start-stage': startStage(Number(el.dataset.g)); break;
    case 'exam': {
      const spec = examSpec(el.dataset.key);
      if (!spec.open) { toast('前のランクの昇格試験に合格すると挑戦できます'); break; }
      const run = () => startExam(spec.key);
      if (current().name === 'result' && quiz === null) { run(); break; }
      const nextMsg = spec.next ? `${esc(K.levelLabel(spec.next))}が解放されます` : '全ランク制覇です';
      confirmDialog(`<b>${esc(spec.title)}</b><br>${esc(spec.label)}の${spec.size}字からランダムに20問（各5点）。<br>90点以上で合格すると${nextMsg}。`, '開始する').then((ok) => ok && run());
      break;
    }
    case 'review': startReview(); break;
    case 'ahead': startAhead(); break;
    case 'weak': startWeak(); break;
    case 'ics': downloadICS(); break;
    case 'kanji': showKanji(el.dataset.ch); break;
    case 'dict-rank': dictLevel = Number(el.dataset.l); dictQuery = ''; viewDict(); break;
    // テスト中
    case 'undo': pad && pad.undo(); break;
    case 'clear': pad && pad.clear(); break;
    case 'hint': if (q) { q.hint = true; q.strokes = pad ? pad.strokes : q.strokes; viewQuiz(); } break;
    case 'submit': submitAnswer(); break;
    case 'skip':
      if (q) {
        q.img = pad && !pad.isEmpty() ? pad.toDataURL() : null;
        q.ok = false;
        q.cands = null;
        q.phase = 'feedback';
        viewQuiz();
      }
      break;
    case 'self-ok': if (q) { q.ok = true; finalizeAnswer(); } break;
    case 'self-ng': if (q) { q.ok = false; finalizeAnswer(); } break;
    case 'override': if (q) {
      if (q.cands && q.ink) misreads.add({ mode: 'quiz', target: q.ch, cands: q.cands, info: q.cands.info, w: q.w, h: q.h, ink: q.ink, pen: q.pen });
      q.ok = true; q.overridden = true; viewQuiz();
    } break;
    case 'next': if (q) finalizeAnswer(); break;
    default: break;
  }
});

$('#tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (!b) return;
  if (current() && current().name === 'quiz') {
    confirmDialog('テストを中断しますか？', '中断する', '続ける').then((ok) => {
      if (ok) { quiz = null; go(b.dataset.tab, {}, { reset: true }); }
    });
    return;
  }
  if (current() && current().name === 'cgame') {
    confirmChallengeQuit();
    return;
  }
  go(b.dataset.tab, {}, { reset: true });
});

$('#btn-back').addEventListener('click', back);

$('#topbar-right').addEventListener('click', (e) => {
  if (e.target.closest('[data-top="save"]')) go('save');
});

// 自動セーブのたびに右上の「セーブ」ボタンで知らせる
window.addEventListener('anikan:saved', () => {
  const b = $('.save-btn');
  if (!b) return;
  b.classList.add('saved');
  b.querySelector('span').textContent = 'セーブ済み';
  clearTimeout(b._t);
  b._t = setTimeout(() => { b.classList.remove('saved'); b.querySelector('span').textContent = 'セーブ'; }, 1600);
});
window.addEventListener('anikan:savefail', () => {
  toast('この端末に保存できませんでした。容量不足の可能性があります。セーブ画面からファイルに書き出してください', 5000);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    updateBadge();
    const c = current();
    if (c && ['home', 'review'].includes(c.name)) render();
  } else {
    store.save(true);
  }
});

// iPad の Scribble や拡大ジェスチャーでテスト画面が動かないように
document.addEventListener('gesturestart', (e) => e.preventDefault());

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// 自動テスト用フック（?debug を付けたときのみ）
if (new URLSearchParams(location.search).has('debug')) {
  window.__anikan = {
    quizTarget: () => (quiz && quiz.cur ? quiz.cur.ch : null),
    state: () => S,
    gameCur: () => (game && game.cur ? { text: game.cur.item.text, boxes: game.cur.boxes.map((b) => b.ch), bi: game.cur.bi, phase: game.cur.phase } : null),
  };
}

go('home');

// 名前の復習記録があるときは、チャレンジ用データを裏で読み込んで記録を最新のデータにつなぎ直す（バッジの件数も正しくする）
if (Object.keys(S.csrs || {}).length) {
  setTimeout(() => { loadChallengeData().catch(() => {}); }, 1500);
}
