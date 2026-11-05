// Apple Pencil / 指で書ける手書きキャンバス
// - Pointer Events で筆圧・高頻度サンプル（getCoalescedEvents）に対応
// - ペン入力を検出したら指タッチを無視（パームリジェクション）
export class InkPad {
  constructor(container, opts = {}) {
    this.opts = { penOnly: 'auto', lineWidth: 1, guide: true, ...opts };
    this.strokes = [];      // [{pts:[{x,y,t,p}], pen:boolean}]
    this.current = null;
    this.penSeen = false;
    this.onChange = opts.onChange || (() => {});
    this.el = document.createElement('div');
    this.el.className = 'inkpad';
    this.el.innerHTML = `
      <div class="inkpad-guide" aria-hidden="true"></div>
      <div class="inkpad-ghost" aria-hidden="true"></div>
      <canvas class="inkpad-canvas" aria-label="ここに漢字を書いてください"></canvas>
      <div class="inkpad-placeholder" aria-hidden="true">ここに書く</div>`;
    container.appendChild(this.el);
    this.canvas = this.el.querySelector('canvas');
    this.ctx = this.canvas.getContext('2d');
    this.ghost = this.el.querySelector('.inkpad-ghost');
    this.el.querySelector('.inkpad-guide').hidden = !this.opts.guide;
    this._bind();
    this.resize();
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.el);
  }

  setGhost(ch) {
    this.ghost.textContent = ch || '';
  }

  resize() {
    const r = this.el.getBoundingClientRect();
    if (!r.width) return;
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(r.width * dpr);
    this.canvas.height = Math.round(r.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ghost.style.fontSize = `${Math.round(Math.min(r.width, r.height) * 0.82)}px`;
    this.redraw();
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener('pointerdown', (e) => this._down(e));
    c.addEventListener('pointermove', (e) => this._move(e));
    c.addEventListener('pointerup', (e) => this._up(e));
    c.addEventListener('pointercancel', (e) => this._up(e, true));
    // iOS Safari でのスクロール・拡大・長押しメニューを抑止
    const stop = (e) => { if (e.cancelable) e.preventDefault(); };
    c.addEventListener('touchstart', stop, { passive: false });
    c.addEventListener('touchmove', stop, { passive: false });
    c.addEventListener('contextmenu', stop);
  }

  _accept(e) {
    if (e.pointerType === 'pen') {
      this.penSeen = true;
      return true;
    }
    if (e.pointerType === 'touch') {
      if (this.opts.penOnly === 'on') return false;
      if (this.opts.penOnly === 'auto' && this.penSeen) return false;
    }
    return true;
  }

  _pt(e) {
    const r = this.canvas.getBoundingClientRect();
    let p = e.pressure;
    if (e.pointerType !== 'pen' || !p) p = 0.5;
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: Math.round(e.timeStamp), p };
  }

  _down(e) {
    if (!this._accept(e)) return;
    if (this.current) return; // 2本目の指などは無視
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch (_) { /* noop */ }
    this.pointerId = e.pointerId;
    this.current = { pts: [this._pt(e)], pen: e.pointerType === 'pen' };
    this.strokes.push(this.current);
    this.el.classList.add('has-ink');
    this._drawDot(this.current.pts[0]);
  }

  _move(e) {
    if (!this.current || e.pointerId !== this.pointerId) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of (evs.length ? evs : [e])) {
      const pt = this._pt(ev);
      const pts = this.current.pts;
      const last = pts[pts.length - 1];
      if (Math.abs(pt.x - last.x) + Math.abs(pt.y - last.y) < 0.6) continue;
      pts.push(pt);
      this._drawSegment(pts, pts.length - 1);
    }
  }

  _up(e, cancel = false) {
    if (!this.current || e.pointerId !== this.pointerId) return;
    if (this.current.pts.length === 1 && cancel) {
      this.strokes.pop();
    }
    this.current = null;
    this.pointerId = null;
    this.redraw();
    this.onChange(this.strokes.length);
  }

  _width(p) {
    const base = Math.max(4, Math.min(this.w, this.h) * 0.032) * this.opts.lineWidth;
    return base * (0.55 + 0.9 * p);
  }

  _style() {
    const ink = getComputedStyle(this.el).getPropertyValue('--ink').trim() || '#111';
    this.ctx.strokeStyle = ink;
    this.ctx.fillStyle = ink;
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
  }

  _drawDot(pt) {
    this._style();
    this.ctx.beginPath();
    this.ctx.arc(pt.x, pt.y, this._width(pt.p) / 2, 0, Math.PI * 2);
    this.ctx.fill();
  }

  _drawSegment(pts, i) {
    const ctx = this.ctx;
    this._style();
    const a = pts[i - 1];
    const b = pts[i];
    const prev = pts[i - 2] || a;
    ctx.lineWidth = this._width((a.p + b.p) / 2);
    ctx.beginPath();
    // 中点を使った二次ベジェで滑らかに
    const m1x = (prev.x + a.x) / 2, m1y = (prev.y + a.y) / 2;
    const m2x = (a.x + b.x) / 2, m2y = (a.y + b.y) / 2;
    ctx.moveTo(m1x, m1y);
    ctx.quadraticCurveTo(a.x, a.y, m2x, m2y);
    ctx.stroke();
  }

  redraw() {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.w || 0, this.h || 0);
    for (const s of this.strokes) {
      if (s.pts.length === 1) {
        this._drawDot(s.pts[0]);
        continue;
      }
      this._style();
      const pts = s.pts;
      for (let i = 1; i < pts.length; i++) this._drawSegment(pts, i);
      // 末端まで描き切る
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      this.ctx.lineWidth = this._width(b.p);
      this.ctx.beginPath();
      this.ctx.moveTo((a.x + b.x) / 2, (a.y + b.y) / 2);
      this.ctx.lineTo(b.x, b.y);
      this.ctx.stroke();
    }
    this.el.classList.toggle('has-ink', this.strokes.length > 0);
  }

  undo() {
    this.strokes.pop();
    this.redraw();
    this.onChange(this.strokes.length);
  }

  clear() {
    this.strokes = [];
    this.current = null;
    this.redraw();
    this.onChange(0);
  }

  isEmpty() {
    return this.strokes.length === 0;
  }

  // Google 手書き入力 API 形式 [[xs],[ys],[ts]]
  toInk() {
    return this.strokes.map((s) => {
      const t0 = s.pts[0].t;
      return [
        s.pts.map((p) => Math.round(p.x)),
        s.pts.map((p) => Math.round(p.y)),
        s.pts.map((p) => Math.max(0, p.t - t0)),
      ];
    });
  }

  // 結果表示用の縮小画像
  toDataURL() {
    return this.canvas.toDataURL('image/png');
  }

  destroy() {
    this._ro.disconnect();
    this.el.remove();
  }
}
