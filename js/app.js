import * as store from './store.js';
import * as srs from './srs.js';
import * as K from './data.js';
import { InkPad } from './ink.js';
import { recognize, judge, isDown } from './recognize.js';

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
const bestOf = (g) => S.cleared[g] ?? null;
const isCleared = (g) => (S.cleared[g] ?? -1) >= PASS;
const rankPassed = (r) => (S.exams[r] ?? -1) >= PASS;
const rankOpen = (r) => r === 1 || rankPassed(r - 1);
const stageGlobal = (r, n) => (r - 1) * K.STAGES_PER_RANK + (n - 1);

function stageOpen(g) {
  const r = K.stageRank(g);
  if (!rankOpen(r)) return false;
  return K.stageNo(g) === 1 || isCleared(g - 1);
}

function clearedCount(r) {
  let n = 0;
  for (let i = 1; i <= K.STAGES_PER_RANK; i++) if (isCleared(stageGlobal(r, i))) n++;
  return n;
}

function topRank() {
  let r = 1;
  while (r < K.RANKS && rankOpen(r + 1)) r++;
  return r;
}

function frontier() {
  const r = topRank();
  for (let i = 1; i <= K.STAGES_PER_RANK; i++) {
    const g = stageGlobal(r, i);
    if (stageOpen(g) && !isCleared(g)) return { type: 'stage', g, r };
  }
  if (!rankPassed(r)) return { type: 'exam', r };
  return { type: 'done', r };
}

/* ------------------------------------------------------------------ */
/* ルーティング                                                         */
/* ------------------------------------------------------------------ */
const TABS = ['home', 'ranks', 'review', 'dict', 'settings'];

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
  if (stack.length > 1) stack.pop();
  render();
}

const current = () => stack[stack.length - 1];

function render() {
  if (pad) { pad.destroy(); pad = null; }
  const { name, params } = current();
  const app = $('#app');
  app.dataset.view = name;
  const tab = TABS.includes(name) ? name : ({ rank: 'ranks', stage: 'ranks', quiz: null, result: null }[name] ?? null);
  document.querySelectorAll('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('#btn-back').hidden = stack.length <= 1 && name !== 'quiz';
  $('#topbar-right').innerHTML = '';
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
  const due = srs.dueList().length;
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
          <div class="kdetail-rank">${esc(K.rankLabel(K.rankOfIndex(i)))}・ステージ${K.stageNo(g)}・No.${i + 1}</div>
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
  const r = topRank();
  const cc = clearedCount(r);
  const next = srs.nextDue();
  const today = S.days[store.dayKey()] || { n: 0, ok: 0 };
  let cta = '';
  if (f.type === 'stage') {
    cta = `<button class="btn primary big" data-act="stage" data-g="${f.g}">ステージ${K.stageNo(f.g)}に挑戦<small>${esc(K.stageChars(f.g).join(''))}</small></button>`;
  } else if (f.type === 'exam') {
    cta = `<button class="btn primary big" data-act="exam" data-r="${f.r}">昇格試験に挑戦<small>20問・90点以上でランク${f.r + 1}へ</small></button>`;
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
        <div class="rank-emblem r${r}">${r}</div>
        <div>
          <div class="hero-label">現在のランク</div>
          <div class="hero-name">${esc(K.RANK_NAMES[r - 1])}</div>
          <div class="hero-sub">${(r - 1) * K.PER_RANK + 1}〜${r * K.PER_RANK}字目・ステージ ${cc}/${K.STAGES_PER_RANK} クリア</div>
        </div>
      </div>
      ${bar((cc / K.STAGES_PER_RANK) * 100)}
      <div class="hero-cta">${cta}</div>
    </section>
    ${dueBox}
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
        <li><b>昇格試験</b> — 100ステージ（1000字）クリア後、20問で90点以上なら次のランクへ</li>
        <li><b>復習</b> — 忘却曲線に沿って、忘れかけた字が自動で出題されます</li>
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

function showIntro() {
  openModal(`<div class="intro">
    <div class="intro-k">漢</div>
    <h2>アニ漢へようこそ</h2>
    <p>アニメのタイトルやキャラクター名によく使われる漢字を、<b>1万字</b>収録した書き取りテストです。</p>
    <ul>
      <li>1000字ごとに<b>10ランク</b>、各ランク100ステージ</li>
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
    const cc = clearedCount(r);
    const ex = S.exams[r];
    html += `<button class="rank-item card ${open ? '' : 'locked'}" data-act="rank" data-r="${r}">
      <div class="rank-emblem r${r}">${open ? r : '🔒'}</div>
      <div class="rank-info">
        <div class="rank-title">ランク${r}「${esc(K.RANK_NAMES[r - 1])}」</div>
        <div class="rank-sub">${(r - 1) * K.PER_RANK + 1}〜${r * K.PER_RANK}字目 <span class="rank-sample">${esc(K.rankChars(r).slice(0, 12).join(''))}…</span></div>
        ${bar((cc / K.STAGES_PER_RANK) * 100)}
        <div class="rank-sub">ステージ ${cc}/${K.STAGES_PER_RANK}${rankPassed(r) ? '・<b class="good">昇格試験 合格 ' + ex + '点</b>' : ex != null ? `・昇格試験 最高${ex}点` : ''}</div>
      </div></button>`;
  }
  html += '</div>';
  view.innerHTML = html;
}

function viewRank({ r }) {
  setTitle(`ランク${r}「${K.RANK_NAMES[r - 1]}」`);
  const open = rankOpen(r);
  const cc = clearedCount(r);
  const all = cc === K.STAGES_PER_RANK;
  let cells = '';
  for (let n = 1; n <= K.STAGES_PER_RANK; n++) {
    const g = stageGlobal(r, n);
    const so = stageOpen(g);
    const b = bestOf(g);
    const cl = isCleared(g);
    cells += `<button class="stage-cell ${cl ? 'cleared' : so ? 'open' : 'locked'}" data-act="stage" data-g="${g}" ${so || cl ? '' : 'aria-disabled="true"'}>
      <span class="stage-no">${n}</span>
      <span class="stage-k">${esc(K.stageChars(g).slice(0, 3).join(''))}</span>
      <span class="stage-score">${cl ? '★' + b : b != null ? b + '点' : so ? '挑戦' : ''}</span></button>`;
  }
  const examBtn = open
    ? `<button class="btn ${all ? 'primary' : 'ghost'}" data-act="exam" data-r="${r}">${all ? '昇格試験' : '飛び級試験'}（20問）</button>`
    : '';
  view.innerHTML = `
    <section class="card rank-head">
      <div class="rank-emblem r${r}">${r}</div>
      <div class="rank-info">
        <div class="rank-sub">${(r - 1) * K.PER_RANK + 1}〜${r * K.PER_RANK}字目</div>
        ${bar((cc / K.STAGES_PER_RANK) * 100)}
        <div class="rank-sub">ステージ ${cc}/${K.STAGES_PER_RANK} クリア${rankPassed(r) ? '・<b class="good">昇格済み</b>' : ''}</div>
      </div>
      <div class="rank-actions">${examBtn}</div>
    </section>
    ${!open ? `<p class="notice">ランク${r - 1}の昇格試験に合格すると挑戦できます。</p>` : ''}
    ${open && !all ? '<p class="muted small center">「飛び級試験」はこのランク1000字からの20問。90点以上で次のランクが開放されます。</p>' : ''}
    <div class="stage-grid">${cells}</div>`;
}

function viewStage({ g }) {
  const r = K.stageRank(g);
  const n = K.stageNo(g);
  setTitle(`ランク${r} ステージ${n}`);
  const chars = K.stageChars(g);
  const b = bestOf(g);
  view.innerHTML = `
    <section class="card stage-head">
      <div>
        <div class="stage-title">ステージ${n}<small>${esc(K.rankLabel(r))}</small></div>
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
let dictRank = 1;
let dictQuery = '';

function viewDict() {
  setTitle('漢字図鑑');
  const chips = Array.from({ length: K.RANKS }, (_, i) => i + 1)
    .map((r) => `<button class="chip ${r === dictRank && !dictQuery ? 'active' : ''}" data-act="dict-rank" data-r="${r}">ランク${r}</button>`).join('');
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
    t = setTimeout(() => { dictQuery = input.value; renderDictBody(); view.querySelectorAll('.chip').forEach((c) => c.classList.toggle('active', !dictQuery && Number(c.dataset.r) === dictRank)); }, 200);
  });
  renderDictBody();
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
    const start = (dictRank - 1) * K.PER_RANK;
    idxs = Array.from({ length: K.PER_RANK }, (_, i) => start + i).filter((i) => i < K.TOTAL);
    const learned = idxs.filter((i) => S.srs[K.KANJI[i].k]).length;
    head = `<p class="muted">${esc(K.rankLabel(dictRank))}：${learned}/${idxs.length}字 学習済み</p>`;
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
    <section class="card settings">
      <h3>データ</h3>
      <p class="muted small">学習データはこの端末のブラウザ内に保存されます。機種変更や念のためにバックアップを取っておきましょう。</p>
      <div class="btn-row left">
        <button class="btn ghost" id="exp">バックアップを書き出す</button>
        <label class="btn ghost file-btn">バックアップから復元<input type="file" id="imp" accept="application/json,.json" hidden></label>
        <button class="btn danger" id="rst">学習データをリセット</button>
      </div>
    </section>
    <section class="card about">
      <h3>このアプリについて</h3>
      <p class="small muted">収録 ${K.TOTAL.toLocaleString()}字（${K.RANKS}ランク × ${K.PER_RANK}字、各ランク${K.STAGES_PER_RANK}ステージ）。並び順はアニメのタイトル・キャラクター名・頻出語での出現と、一般語・人名での使用頻度から算出しています。</p>
      <p class="small muted">漢字・単語・人名データ: <a href="https://www.edrdg.org/wiki/index.php/KANJIDIC_Project" target="_blank" rel="noopener">KANJIDIC2</a> / <a href="https://www.edrdg.org/jmdict/j_jmdict.html" target="_blank" rel="noopener">JMdict</a> / JMnedict © Electronic Dictionary Research and Development Group（<a href="https://www.edrdg.org/edrdg/licence.html" target="_blank" rel="noopener">CC BY-SA 4.0</a>）。作品名・人名は各権利者に帰属します。</p>
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
  $('#exp').addEventListener('click', () => {
    const blob = new Blob([store.exportJSON()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `anikan-backup-${store.dayKey()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  });
  $('#imp').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      if (!(await confirmDialog('現在の学習データを、バックアップの内容で置き換えますか？', '復元する'))) return;
      S = store.importJSON(text);
      toast('バックアップから復元しました');
      render();
    } catch (err) {
      toast(`復元できませんでした: ${err.message}`);
    }
  });
  $('#rst').addEventListener('click', async () => {
    if (!(await confirmDialog('すべての学習記録（クリア状況・復習予定）を消去します。元に戻せません。よろしいですか？', 'リセットする'))) return;
    S = store.reset();
    toast('学習データをリセットしました');
    render();
  });
}

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

function pickExample(e) {
  if (!e.ex.length) return null;
  const anime = e.ex.filter((x) => 'tcv'.includes(x[2]));
  const pool = anime.length && Math.random() < 0.65 ? anime : e.ex;
  return pool[Math.floor(Math.random() * pool.length)];
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

function startExam(r) {
  if (!rankOpen(r)) { toast('前のランクの昇格試験に合格すると挑戦できます'); return; }
  startQuiz('exam', shuffle(K.rankChars(r)).slice(0, 20), { r });
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
    ? `ステージ${K.stageNo(quiz.g)}`
    : quiz.mode === 'exam' ? `ランク${quiz.r} 昇格試験` : MODE_LABEL[quiz.mode];
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
  q.phase = 'checking';
  viewQuiz();
  try {
    const rank = K.rankOfIndex(K.indexOf(q.ch));
    const cands = await recognize(ink, w, h, { target: q.ch, rare: rank >= 4 });
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
  const res = { mode: quiz.mode, g: quiz.g, r: quiz.r, score, answers: quiz.answers, total: quiz.items.length, passed: score >= PASS };
  let firstClear = false;
  if (quiz.mode === 'stage') {
    const prev = S.cleared[quiz.g];
    firstClear = res.passed && !(prev >= PASS);
    S.cleared[quiz.g] = Math.max(prev ?? 0, score);
    S.attempts[quiz.g] = (S.attempts[quiz.g] || 0) + 1;
  } else if (quiz.mode === 'exam') {
    const prev = S.exams[quiz.r];
    firstClear = res.passed && !(prev >= PASS);
    S.exams[quiz.r] = Math.max(prev ?? 0, score);
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
  setTitle(isTest ? (res.mode === 'stage' ? `ステージ${K.stageNo(res.g)} 結果` : `ランク${res.r} 昇格試験 結果`) : '復習の結果');
  const okN = res.answers.filter((a) => a.ok).length;
  let msg = '';
  let actions = '';
  if (res.mode === 'stage') {
    const g = res.g;
    const lastInRank = K.stageNo(g) === K.STAGES_PER_RANK;
    if (res.passed) {
      msg = res.firstClear ? (lastInRank ? `ランク${K.stageRank(g)}の全ステージをクリア！昇格試験に挑戦できます。` : '次のステージが解放されました！') : '合格！';
      actions = lastInRank
        ? `<button class="btn primary big" data-act="exam" data-r="${K.stageRank(g)}">昇格試験へ</button>`
        : `<button class="btn primary big" data-act="stage" data-g="${g + 1}">次のステージへ</button>`;
      actions = `<button class="btn ghost" data-act="start-stage" data-g="${g}">もう一度</button>${actions}`;
    } else {
      msg = `合格まであと${PASS - res.score}点。間違えた字を確認して再挑戦しよう！`;
      actions = `<button class="btn ghost" data-act="stage" data-g="${g}">漢字を確認する</button><button class="btn primary big" data-act="start-stage" data-g="${g}">再挑戦</button>`;
    }
  } else if (res.mode === 'exam') {
    const r = res.r;
    if (res.passed) {
      msg = r < K.RANKS ? `昇格！ランク${r + 1}「${K.RANK_NAMES[r]}」が解放されました。` : '最終ランクの昇格試験に合格！おめでとうございます！';
      actions = r < K.RANKS ? `<button class="btn primary big" data-act="rank" data-r="${r + 1}">ランク${r + 1}へ進む</button>` : '';
    } else {
      msg = `合格まであと${PASS - res.score}点。ステージで復習してから再挑戦しよう。`;
      actions = `<button class="btn ghost" data-act="rank" data-r="${r}">ランク${r}へ</button><button class="btn primary big" data-act="exam" data-r="${r}">再挑戦</button>`;
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
/* イベント                                                             */
/* ------------------------------------------------------------------ */
const VIEWS = {
  home: viewHome, ranks: viewRanks, rank: viewRank, stage: viewStage,
  review: viewReview, dict: viewDict, settings: viewSettings, quiz: viewQuiz, result: viewResult,
};

view.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const a = el.dataset.act;
  const q = quiz && quiz.cur;
  switch (a) {
    case 'home': go('home', {}, { reset: true }); break;
    case 'rank': {
      const r = Number(el.dataset.r);
      go('rank', { r }, { replace: current().name === 'result' });
      break;
    }
    case 'stage': {
      const g = Number(el.dataset.g);
      if (!stageOpen(g) && !isCleared(g)) { toast('前のステージを90点以上でクリアすると解放されます'); break; }
      const fromResult = current().name === 'result';
      if (fromResult) stack.pop();
      if (!stack.some((s) => s.name === 'rank' && s.params.r === K.stageRank(g)) && current().name !== 'rank') {
        stack.push({ name: 'rank', params: { r: K.stageRank(g) } });
      }
      if (current().name === 'stage') stack.pop();
      go('stage', { g });
      break;
    }
    case 'start-stage': startStage(Number(el.dataset.g)); break;
    case 'exam': {
      const r = Number(el.dataset.r);
      if (!rankOpen(r)) { toast('前のランクの昇格試験に合格すると挑戦できます'); break; }
      const all = clearedCount(r) === K.STAGES_PER_RANK;
      const run = () => startExam(r);
      if (current().name === 'result' && quiz === null) { run(); break; }
      confirmDialog(`<b>ランク${r} ${all ? '昇格試験' : '飛び級試験'}</b><br>このランクの1000字からランダムに20問（各5点）。<br>90点以上で合格するとランク${Math.min(r + 1, K.RANKS)}が解放されます。`, '開始する').then((ok) => ok && run());
      break;
    }
    case 'review': startReview(); break;
    case 'ahead': startAhead(); break;
    case 'weak': startWeak(); break;
    case 'ics': downloadICS(); break;
    case 'kanji': showKanji(el.dataset.ch); break;
    case 'dict-rank': dictRank = Number(el.dataset.r); dictQuery = ''; viewDict(); break;
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
    case 'override': if (q) { q.ok = true; q.overridden = true; viewQuiz(); } break;
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
  go(b.dataset.tab, {}, { reset: true });
});

$('#btn-back').addEventListener('click', back);

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
  window.__anikan = { quizTarget: () => (quiz && quiz.cur ? quiz.cur.ch : null), state: () => S };
}

go('home');
