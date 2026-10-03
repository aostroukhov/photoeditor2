/**
 * DrawTool — рисунок: свободные мазки, прямые (Shift), распознавание фигур
 * при удержании (прямоугольник / эллипс / стрелка), пипетка (Alt+клик).
 *
 * Каждый мазок — Sketch с точками в логических координатах overlay; выбранный
 * набросок можно двигать, масштабировать за углы (с пропорциями или без),
 * менять прозрачность ручкой над рамкой. «Применить» рендерит все наброски
 * в натуральном разрешении поверх pe.img.
 *
 * Жизненный цикл, canvas, указатель, панель и клавиатура — в ToolBase.
 */

import { EditorConfig } from './EditorConfig.js';
import { ToolBase }     from './ToolBase.js';
import { CardList }     from './CardList.js';
import { safeCssColor } from './utils.js';

const CFG = EditorConfig.draw;


// ─── Утилита: миниатюра наброска ─────────────────────────────────────────────

function sketchThumb(sk, size = 48) {
  const b   = sk.bbox;
  const bw  = (b.right - b.left) * sk.scaleX || 1;
  const bh  = (b.bottom - b.top) * sk.scaleY || 1;
  const k   = Math.min(size / bw, size / bh, 1) * 0.85;
  const cv  = document.createElement('canvas');
  cv.width  = size; cv.height = size;
  const ctx = cv.getContext('2d');
  const offX = (size - bw * k) / 2 - (b.left * sk.scaleX + sk.x) * k;
  const offY = (size - bh * k) / 2 - (b.top  * sk.scaleY + sk.y) * k;
  ctx.save(); ctx.translate(offX, offY); ctx.scale(k, k); sk.render(ctx); ctx.restore();
  return cv.toDataURL('image/png');
}


// ─── Модель наброска ──────────────────────────────────────────────────────────

let nextSketchId = 1;

export class Sketch {
  constructor({
    points = [], color = CFG.defaultColor, lineWidth = CFG.defaultWidth,
    opacity = CFG.defaultOpacity, x = 0, y = 0,
    scaleX = 1, scaleY = 1, lockAspect = true,
  } = {}) {
    this.id         = nextSketchId++;
    this.points     = points;
    this.color      = color;
    this.lineWidth  = lineWidth;
    this.opacity    = opacity;
    this.x          = x;
    this.y          = y;
    this.scaleX     = scaleX;
    this.scaleY     = scaleY;
    this.lockAspect = lockAspect;
    this._bbox      = null;
  }

  get bbox() {
    if (this._bbox) return this._bbox;
    if (!this.points.length) return (this._bbox = { left: 0, top: 0, right: 0, bottom: 0 });
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of this.points) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
    }
    return (this._bbox = { left: minX, top: minY, right: maxX, bottom: maxY });
  }

  invalidateBbox() { this._bbox = null; }

  get dispLeft()   { return this.bbox.left   * this.scaleX + this.x; }
  get dispTop()    { return this.bbox.top    * this.scaleY + this.y; }
  get dispRight()  { return this.bbox.right  * this.scaleX + this.x; }
  get dispBottom() { return this.bbox.bottom * this.scaleY + this.y; }
  get displayW()   { return this.dispRight  - this.dispLeft; }
  get displayH()   { return this.dispBottom - this.dispTop;  }

  render(ctx) {
    if (this.points.length < 2) return;
    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.strokeStyle = this.color;
    ctx.lineWidth   = this.lineWidth;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.translate(this.x, this.y);
    ctx.scale(this.scaleX, this.scaleY);
    ctx.beginPath();
    ctx.moveTo(this.points[0].x, this.points[0].y);
    for (let i = 1; i < this.points.length; i++) ctx.lineTo(this.points[i].x, this.points[i].y);
    ctx.stroke();
    ctx.restore();
  }
}


// ─── Распознавание форм ───────────────────────────────────────────────────────

export function recognizeShape(pts) {
  if (pts.length < CFG.minPointsForRecognition) return null;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  const w = maxX - minX, h = maxY - minY;
  if (w < 4 || h < 4) return null;

  const cx    = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const first = pts[0], last = pts[pts.length - 1];
  const closeDist = Math.hypot(last.x - first.x, last.y - first.y);
  const isClosed  = closeDist < Math.max(w, h) * 2 * CFG.closedShapeThreshold;
  if (!isClosed) return null; // незамкнутые — только стрелка (прямая линия)

  const aspectRatio = w / h;
  let sum = 0;
  const dists = pts.map(p => { const d = Math.hypot(p.x - cx, p.y - cy); sum += d; return d; });
  const avgD  = sum / dists.length;
  let variance = 0;
  for (const d of dists) variance += (d - avgD) ** 2;
  const cv = Math.sqrt(variance / dists.length) / avgD;
  const cornerCount = countCorners(pts);

  const square = () => { const side = (w + h) / 2; return makeRect(cx - side / 2, cy - side / 2, side, side, 'square'); };

  // Явные углы (≥ 3) → прямоугольник/квадрат
  if (cornerCount >= 3) return Math.abs(aspectRatio - 1) < 0.25 ? square() : makeRect(minX, minY, w, h, 'rect');

  // Нет углов и малый разброс радиуса → круг/эллипс
  if (cv < 0.20) {
    if (Math.abs(aspectRatio - 1) < 0.25) return makeEllipse(cx, cy, Math.max(w, h) / 2, Math.max(w, h) / 2, 'circle');
    return makeEllipse(cx, cy, w / 2, h / 2, 'ellipse');
  }

  // Мало углов + высокий разброс → прямоугольник, нарисованный неровно
  return Math.abs(aspectRatio - 1) < 0.25 ? square() : makeRect(minX, minY, w, h, 'rect');
}

/** Угловые точки с нормализованным шагом (~7% траектории); угол > ~72° — угловой. */
function countCorners(pts) {
  const n    = pts.length;
  const step = Math.max(3, Math.round(n * 0.07));
  let corners = 0;
  for (let i = step; i < n - step; i += Math.max(1, Math.round(step / 2))) {
    const ax = pts[i].x - pts[i - step].x,     ay = pts[i].y - pts[i - step].y;
    const bx = pts[i + step].x - pts[i].x,     by = pts[i + step].y - pts[i].y;
    const lenA = Math.hypot(ax, ay), lenB = Math.hypot(bx, by);
    if (lenA < 2 || lenB < 2) continue;
    if ((ax * bx + ay * by) / (lenA * lenB) < 0.3) corners++;
  }
  return corners;
}

/** Прямая линия: максимальное отклонение точек от хорды < 12% длины. */
export function isStraightLine(pts) {
  if (pts.length < 2) return false;
  const p0 = pts[0], pN = pts[pts.length - 1];
  const len = Math.hypot(pN.x - p0.x, pN.y - p0.y);
  if (len < 15) return false;
  const ux = (pN.x - p0.x) / len, uy = (pN.y - p0.y) / len;
  let maxDev = 0;
  for (const p of pts) {
    const dev = Math.abs((p.x - p0.x) * uy - (p.y - p0.y) * ux);
    if (dev > maxDev) maxDev = dev;
  }
  return maxDev < len * 0.12;
}

export function makeArrow(pts) {
  const p0 = pts[0], pN = pts[pts.length - 1];
  const len = Math.hypot(pN.x - p0.x, pN.y - p0.y);
  if (len < 2) return null;
  const ux   = (pN.x - p0.x) / len, uy = (pN.y - p0.y) / len;
  const hLen = Math.max(14, len * 0.25), hAng = Math.PI / 6;
  const lx   = pN.x - hLen * (ux * Math.cos(hAng)  - uy * Math.sin(hAng));
  const ly   = pN.y - hLen * (ux * Math.sin(hAng)  + uy * Math.cos(hAng));
  const rx   = pN.x - hLen * (ux * Math.cos(-hAng) - uy * Math.sin(-hAng));
  const ry   = pN.y - hLen * (ux * Math.sin(-hAng) + uy * Math.cos(-hAng));
  return { shape: 'arrow', points: [p0, pN, { x: lx, y: ly }, pN, { x: rx, y: ry }] };
}

function makeEllipse(cx, cy, rx, ry, shape) {
  const pts = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return { shape, points: pts };
}

function makeRect(x, y, w, h, shape) {
  return { shape, points: [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }, { x, y }] };
}


// ─── Хранение настроек кисти ──────────────────────────────────────────────────

function loadDrawColor() {
  try { return safeCssColor(localStorage.getItem(CFG.colorStorageKey), CFG.defaultColor); }
  catch { return CFG.defaultColor; }
}
function saveDrawColor(v) { try { localStorage.setItem(CFG.colorStorageKey, v); } catch { /* ignore */ } }
function loadDrawWidth() {
  try {
    const n = Number(localStorage.getItem(CFG.widthStorageKey));
    return Number.isFinite(n) && n >= CFG.minWidth && n <= CFG.maxWidth ? n : CFG.defaultWidth;
  } catch { return CFG.defaultWidth; }
}
function saveDrawWidth(v) { try { localStorage.setItem(CFG.widthStorageKey, String(v)); } catch { /* ignore */ } }


// ─── Константы ────────────────────────────────────────────────────────────────

const HR        = CFG.handleRadius;
const MIN_SIZE  = CFG.minSize;
const OP_OFFSET = CFG.rotateOffset;

const RESIZE_HANDLES = [
  { name: 'topLeft',     cursor: 'nwse-resize' },
  { name: 'topRight',    cursor: 'nesw-resize' },
  { name: 'bottomRight', cursor: 'nwse-resize' },
  { name: 'bottomLeft',  cursor: 'nesw-resize' },
];
const HINT_DEFAULT = 'Shift — прямые · удержание ≥2 с — фигура/стрелка · Alt — пипетка';
const HINT_ALT     = 'Alt+клик — захватить цвет с изображения';


// ─── DrawTool ─────────────────────────────────────────────────────────────────

export class DrawTool extends ToolBase {

  /** Все наброски текущей сессии. */
  sketches = [];
  /** Выбранный набросок или null. */
  selected = null;

  color      = loadDrawColor();
  lineWidth  = loadDrawWidth();
  opacity    = CFG.defaultOpacity;
  lockAspect = true;

  _drawing    = false;
  _currentPts = [];
  _shiftLine  = false;
  _holdTimer  = null;

  _drag   = null;   // { startX, startY, origX, origY }
  _resize = null;   // { handle, anchorX, anchorY, origW, origH, bboxW, bboxH, aspect }
  _opDrag = null;   // { startY, origOpacity }

  _flash    = null; // { hex, x, y } — индикация пипетки
  _altHint  = false;
  _cards    = null; // CardList

  constructor(photoEditor) {
    super(photoEditor, { id: 'draw', cursor: 'crosshair' });
  }


  // ─── Хуки жизненного цикла ────────────────────────────────────────────────

  onStart() {}

  onSuspend() {
    this._cancelDraw();
    this._drag = null; this._resize = null; this._opDrag = null;
    this.selected = null;
  }

  onCancel()  { this._reset(); }
  onDestroy() { this._reset(); }

  onApply() {
    const img = this.pe.img;
    if (!img || !this.sketches.length) { this._reset(); return null; }

    const out = document.createElement('canvas');
    out.width  = img.naturalWidth;
    out.height = img.naturalHeight;
    const ctx  = out.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const k = this.naturalScale;
    for (const sk of this.sketches) {
      new Sketch({
        points:    sk.points.map(p => ({ x: p.x * k, y: p.y * k })),
        color:     sk.color, lineWidth: sk.lineWidth * k, opacity: sk.opacity,
        x: sk.x * k, y: sk.y * k, scaleX: sk.scaleX, scaleY: sk.scaleY,
      }).render(ctx);
    }
    this._reset();
    return out;
  }

  onViewResize(kx, ky) {
    const kl = (kx + ky) / 2;
    for (const sk of this.sketches) {
      sk.points = sk.points.map(p => ({ x: p.x * kx, y: p.y * ky }));
      sk.invalidateBbox();
      sk.x *= kx; sk.y *= ky;
      sk.lineWidth *= kl;          // иначе толщина после ресайза окна расходилась с результатом
    }
    if (this._currentPts.length) this._currentPts = this._currentPts.map(p => ({ x: p.x * kx, y: p.y * ky }));
  }

  onDraw(ctx) {
    const order = this.selected
      ? [...this.sketches.filter(s => s !== this.selected), this.selected]
      : this.sketches;

    for (const sk of order) {
      sk.render(ctx);
      if (sk === this.selected && !this._drawing) this._drawHandles(ctx, sk);
    }

    if (this._drawing && this._currentPts.length >= 2) {
      ctx.save();
      ctx.globalAlpha = this.opacity;
      ctx.strokeStyle = this.color;
      ctx.lineWidth   = this.lineWidth;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(this._currentPts[0].x, this._currentPts[0].y);
      for (let i = 1; i < this._currentPts.length; i++) ctx.lineTo(this._currentPts[i].x, this._currentPts[i].y);
      ctx.stroke();
      ctx.restore();
    }

    if (this._flash) {
      const { hex, x, y } = this._flash;
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2);
      ctx.fillStyle = hex; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.restore();
    }
  }

  _drawHandles(ctx, sk) {
    const x0 = sk.dispLeft, y0 = sk.dispTop, x1 = sk.dispRight, y1 = sk.dispBottom;
    const w = x1 - x0, h = y1 - y0;
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, w, h);
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(60,143,224,0.95)'; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
    for (const p of this._corners(sk)) {
      ctx.beginPath(); ctx.arc(p.x, p.y, HR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    const opH = this._opHandle(sk);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(x0 + w / 2, y0); ctx.lineTo(opH.x, opH.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,200,0,0.95)'; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(opH.x, opH.y, HR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = sk.lockAspect ? 'rgba(100,220,100,0.9)' : 'rgba(200,200,200,0.5)';
    ctx.beginPath(); ctx.arc(x1 + HR + 1, y1 - HR - 1, HR * 0.55, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }


  // ─── Hit-test ─────────────────────────────────────────────────────────────

  _corners(sk) {
    return [
      { x: sk.dispLeft,  y: sk.dispTop    },
      { x: sk.dispRight, y: sk.dispTop    },
      { x: sk.dispRight, y: sk.dispBottom },
      { x: sk.dispLeft,  y: sk.dispBottom },
    ];
  }

  _opHandle(sk) { return { x: sk.dispLeft + sk.displayW / 2, y: sk.dispTop - OP_OFFSET }; }

  _hitTest(x, y) {
    const order = this.selected
      ? [...this.sketches.filter(s => s !== this.selected), this.selected]
      : this.sketches;
    for (let i = order.length - 1; i >= 0; i--) {
      const sk = order[i];
      // Ручки рисуются только у выбранного — у остальных их не проверяем
      if (sk === this.selected) {
        const oh = this._opHandle(sk);
        if (Math.hypot(x - oh.x, y - oh.y) <= HR + 5) return { type: 'opacity', sk };
        const c = this._corners(sk);
        for (let j = 0; j < 4; j++) {
          if (Math.hypot(x - c[j].x, y - c[j].y) <= HR + 5) return { type: 'resize', handle: RESIZE_HANDLES[j].name, sk };
        }
      }
      // Допуск по толщине линии: прямую (bbox нулевой высоты) иначе нельзя выбрать
      const tol = Math.max(4, sk.lineWidth / 2);
      if (x >= sk.dispLeft - tol && x <= sk.dispRight + tol && y >= sk.dispTop - tol && y <= sk.dispBottom + tol)
        return { type: 'move', sk };
    }
    return null;
  }

  _cursorFor(hit) {
    if (!hit)                   return 'crosshair';
    if (hit.type === 'move')    return 'move';
    if (hit.type === 'opacity') return 'ns-resize';
    return RESIZE_HANDLES.find(h => h.name === hit.handle)?.cursor ?? 'nwse-resize';
  }

  _setCursor(cur) { if (this.overlayCanvas) this.overlayCanvas.style.cursor = cur; }


  // ─── Указатель ────────────────────────────────────────────────────────────

  onHover(pt, e) {
    this._shiftLine = e.shiftKey;
    if (e.altKey) { this._setCursor('crosshair'); this._setAltHint(true); return; }
    this._setAltHint(false);
    this._setCursor(this._cursorFor(this._hitTest(pt.x, pt.y)));
  }

  onHoverEnd() { this._setAltHint(false); }

  onPointerDown(pt, e) {
    if (e.altKey && e.pointerType === 'mouse') { this._pickColor(pt.x, pt.y); return; }
    this._shiftLine = e.shiftKey;
    const { x, y } = pt;

    const hit = this._hitTest(x, y);
    if (hit) {
      const { type, sk, handle } = hit;
      if (this.selected !== sk) this._selectSketch(sk, false);
      this._setCursor(this._cursorFor(hit));
      if (type === 'move') {
        this._drag = { startX: x, startY: y, origX: sk.x, origY: sk.y };
      } else if (type === 'resize') {
        // Фиксируем экранные координаты ПРОТИВОПОЛОЖНОГО угла
        this._resize = {
          handle,
          anchorX: (handle === 'topLeft' || handle === 'bottomLeft') ? sk.dispRight  : sk.dispLeft,
          anchorY: (handle === 'topLeft' || handle === 'topRight')   ? sk.dispBottom : sk.dispTop,
          origW: sk.displayW, origH: sk.displayH,
          bboxW: sk.bbox.right  - sk.bbox.left || 1,
          bboxH: sk.bbox.bottom - sk.bbox.top  || 1,
          aspect: sk.displayW / (sk.displayH || 1),
        };
      } else {
        this._opDrag = { startY: y, origOpacity: sk.opacity };
        this._setCursor('ns-resize');
      }
      return;
    }

    if (this.selected) { this.selected = null; this._syncPanel(); this._cards?.setActive(null); }
    this._drawing    = true;
    this._currentPts = [{ x, y }];
    this._setCursor('crosshair');
    clearTimeout(this._holdTimer);
    this.requestDraw();
  }

  onPointerMove(pt, e) {
    const { x, y } = pt;
    this._shiftLine = e.shiftKey;

    if (this._drag && this.selected) {
      const sk = this.selected;
      sk.x = this._drag.origX + (x - this._drag.startX);
      sk.y = this._drag.origY + (y - this._drag.startY);
      this.requestDraw();
      return;
    }
    if (this._opDrag && this.selected) {
      const dy = this._opDrag.startY - y;
      this.selected.opacity = Math.max(0.05, Math.min(1, this._opDrag.origOpacity + dy / 200));
      this._syncPanel();
      this.requestDraw();
      return;
    }
    if (this._resize && this.selected) {
      const sk = this.selected, r = this._resize;
      sk.lockAspect = !e.shiftKey;
      let newW = Math.max(MIN_SIZE, Math.abs(x - r.anchorX));
      let newH = Math.max(MIN_SIZE, Math.abs(y - r.anchorY));
      if (sk.lockAspect) {
        const rw = newW / r.origW, rh = newH / r.origH;
        if (rw > rh) newH = newW / r.aspect; else newW = newH * r.aspect;
        newW = Math.max(MIN_SIZE, newW); newH = Math.max(MIN_SIZE, newH);
      }
      sk.scaleX = newW / r.bboxW;
      sk.scaleY = newH / r.bboxH;
      const b = sk.bbox;
      sk.x = (r.handle === 'topLeft' || r.handle === 'bottomLeft') ? r.anchorX - b.right  * sk.scaleX : r.anchorX - b.left * sk.scaleX;
      sk.y = (r.handle === 'topLeft' || r.handle === 'topRight')   ? r.anchorY - b.bottom * sk.scaleY : r.anchorY - b.top  * sk.scaleY;
      this._syncPanel();
      this.requestDraw();
      return;
    }
    if (!this._drawing) return;

    if (this._shiftLine && this._currentPts.length >= 1) {
      const p0   = this._currentPts[0];
      const dx   = x - p0.x, dy = y - p0.y;
      const snap = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const dist = Math.hypot(dx, dy);
      this._currentPts = [p0, { x: p0.x + dist * Math.cos(snap), y: p0.y + dist * Math.sin(snap) }];
    } else {
      this._currentPts.push({ x, y });
    }
    this._resetHoldTimer();
    this.requestDraw();
  }

  onPointerUp() {
    if (this._drag)   { this._drag   = null; this._setCursor('move'); this._renderSketchList(); return; }
    if (this._opDrag) { this._opDrag = null; this._setCursor('default'); return; }
    if (this._resize) { this._resize = null; this._setCursor('default'); this._renderSketchList(); return; }
    if (!this._drawing) return;
    // Распознавание фигуры запускает только таймер удержания (#resetHoldTimer):
    // курсор неподвижен ≥ shapeRecognitionHoldMs при зажатой кнопке.
    clearTimeout(this._holdTimer);
    this._finalizeSketch();
  }

  onPointerCancel() {
    this._drag = null; this._opDrag = null; this._resize = null;
    this._cancelDraw();
    this.requestDraw();
  }


  // ─── Клавиатура ───────────────────────────────────────────────────────────

  onKey(e) {
    const isL = e.code === 'BracketLeft', isR = e.code === 'BracketRight';
    if (isL || isR) {
      this.lineWidth = isL ? Math.max(CFG.minWidth, this.lineWidth - 1) : Math.min(CFG.maxWidth, this.lineWidth + 1);
      saveDrawWidth(this.lineWidth);
      if (this.selected) this.selected.lineWidth = this.lineWidth;
      this._syncPanel(); this.requestDraw();
      return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      this._removeSketch(this.selected); return true;
    }
    return false;
  }


  // ─── Логика рисования ─────────────────────────────────────────────────────

  _resetHoldTimer() {
    clearTimeout(this._holdTimer);
    this._holdTimer = setTimeout(() => {
      if (this._drawing) this._tryRecognizeAndFinalize();
    }, CFG.shapeRecognitionHoldMs);
  }

  _cancelDraw() {
    clearTimeout(this._holdTimer);
    this._drawing = false; this._currentPts = [];
  }

  _tryRecognizeAndFinalize() {
    const pts = this._currentPts;
    if (!pts.length) return;
    if (isStraightLine(pts)) {
      const arrow = makeArrow(pts);
      if (arrow) { this._currentPts = arrow.points; this._finalizeSketch(); return; }
    }
    const recognized = recognizeShape(pts);
    if (recognized) this._currentPts = recognized.points;
    this._finalizeSketch();
  }

  _finalizeSketch() {
    if (this._currentPts.length < 2) { this._drawing = false; this._currentPts = []; this.requestDraw(); return; }
    const sk = new Sketch({
      points: [...this._currentPts], color: this.color, lineWidth: this.lineWidth,
      opacity: this.opacity, lockAspect: this.lockAspect,
    });
    this.sketches.push(sk);
    this.selected    = sk;
    this._drawing    = false;
    this._currentPts = [];
    this._syncPanel(); this._renderSketchList();
    this.requestDraw();
  }

  _removeSketch(sk) {
    this.sketches = this.sketches.filter(s => s !== sk);
    if (this.selected === sk) this.selected = this.sketches.at(-1) ?? null;
    this._syncPanel(); this._renderSketchList();
    this.requestDraw();
  }

  _selectSketch(sk, scroll = true) {
    if (this.selected === sk) return;
    this.selected = sk;
    this._syncPanel();
    if (scroll) this._cards?.setActive(sk); else this._cards?.setActive(sk);
    this.requestDraw();
  }

  _reset() {
    this._cancelDraw();
    this.sketches = []; this.selected = null;
    this._drag = null; this._resize = null; this._opDrag = null; this._flash = null;
    this._cards = null;
  }

  /** Пипетка: цвет пикселя исходного изображения под курсором. */
  _pickColor(x, y) {
    const img = this.pe.img;
    if (!img) return;
    const k  = this.naturalScale;
    const nx = Math.max(0, Math.min(img.naturalWidth  - 1, Math.round(x * k)));
    const ny = Math.max(0, Math.min(img.naturalHeight - 1, Math.round(y * k)));
    const cv = document.createElement('canvas');
    cv.width = 1; cv.height = 1;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, nx, ny, 1, 1, 0, 0, 1, 1);
    let rgb;
    try { rgb = ctx.getImageData(0, 0, 1, 1).data; } catch { return; }   // tainted canvas
    const hex = '#' + [rgb[0], rgb[1], rgb[2]].map(v => v.toString(16).padStart(2, '0')).join('');

    this.color = hex;
    saveDrawColor(hex);
    if (this.selected) this.selected.color = hex;
    const colorEl = this._panel?.querySelector('.draw-panel__color');
    if (colorEl) colorEl.value = hex;

    this._flash = { hex, x, y };
    this.requestDraw();
    this._cards?.updateThumbs(this.sketches);
    setTimeout(() => { this._flash = null; this.requestDraw(); }, 600);
  }

  _setAltHint(on) {
    if (this._altHint === on) return;
    this._altHint = on;
    const hint = this._panel?.querySelector('.draw-panel__hint');
    if (hint) hint.textContent = on ? HINT_ALT : HINT_DEFAULT;
  }


  // ─── Панель ───────────────────────────────────────────────────────────────

  buildPanel() {
    const panel = document.createElement('div');
    panel.innerHTML = `
      ${ToolBase.panelHeader({ title: 'Рисунок', prefix: 'draw-panel' })}
      <div class="draw-panel__row draw-panel__row--brush">
        <label class="draw-panel__lbl" title="Цвет линии (Alt+клик по изображению — пипетка)">
          <span class="draw-panel__lbl-text">Цвет</span>
          <input type="color" class="draw-panel__color" value="${this.color}">
        </label>
        <label class="draw-panel__lbl" title="Толщина линии ([ и ] для изменения)">
          <span class="draw-panel__lbl-text">Толщина</span>
          <input type="range" class="draw-panel__width"
                 min="${CFG.minWidth}" max="${CFG.maxWidth}" value="${this.lineWidth}">
          <span class="draw-panel__val-width">${this.lineWidth}</span>px
        </label>
      </div>
      <div class="draw-panel__row draw-panel__row--selected" style="display:none">
        <button type="button" class="photoeditor__button photoeditor__button--compact photoeditor__button--danger draw-panel__btn-del-sketch"
                title="Удалить набросок (Delete)" aria-label="Удалить набросок">
          <i class="icon-bin" aria-hidden="true"></i>
        </button>
        <label class="draw-panel__lbl" title="Прозрачность">
          <span class="draw-panel__lbl-text">Прозрачность</span>
          <input type="range" class="draw-panel__opacity" min="5" max="100" value="100">
          <span class="draw-panel__val-opacity">100</span>%
        </label>
        <label class="draw-panel__lock-label" title="Пропорции (Shift при растягивании — отключить)">
          <input type="checkbox" class="draw-panel__lock-aspect" checked>
          <span class="draw-panel__lbl-text">Пропорции</span>
        </label>
      </div>
      <div class="draw-panel__sketches-wrap" style="display:none">
        <div class="draw-panel__sketches-label">Наброски</div>
        <div class="draw-panel__sketches-list"></div>
      </div>
      <div class="draw-panel__hint">${HINT_DEFAULT}</div>`;

    const colorEl  = panel.querySelector('.draw-panel__color');
    const widthEl  = panel.querySelector('.draw-panel__width');
    const widthVal = panel.querySelector('.draw-panel__val-width');
    const opEl     = panel.querySelector('.draw-panel__opacity');
    const opVal    = panel.querySelector('.draw-panel__val-opacity');
    const lockEl   = panel.querySelector('.draw-panel__lock-aspect');

    colorEl.addEventListener('input', () => {
      this.color = colorEl.value;
      saveDrawColor(this.color);
      if (this.selected) { this.selected.color = this.color; this.requestDraw(); }
    });
    // Миниатюры — по завершении выбора цвета, а не на каждое движение в пикере
    colorEl.addEventListener('change', () => { if (this.selected) this._cards?.updateThumbs([this.selected]); });
    widthEl.addEventListener('input', () => {
      this.lineWidth = Number(widthEl.value); widthVal.textContent = widthEl.value;
      saveDrawWidth(this.lineWidth);
      if (this.selected) { this.selected.lineWidth = this.lineWidth; this.requestDraw(); }
    });
    opEl.addEventListener('input', () => {
      if (!this.selected) return;
      this.selected.opacity = opEl.value / 100; opVal.textContent = opEl.value; this.requestDraw();
    });
    lockEl.addEventListener('change', () => {
      this.lockAspect = lockEl.checked;
      if (this.selected) { this.selected.lockAspect = lockEl.checked; this.requestDraw(); }
    });
    panel.querySelector('.draw-panel__btn-del-sketch').addEventListener('click', () => {
      if (this.selected) this._removeSketch(this.selected);
    });

    this._cards = new CardList(panel.querySelector('.draw-panel__sketches-list'), {
      getId:     (sk) => sk.id,
      render:    (sk) => {
        let thumbSrc = '';
        try { thumbSrc = sketchThumb(sk); } catch { /* tainted */ }
        return { thumbSrc, color: sk.color, title: `Набросок #${sk.id}` };
      },
      onSelect:  (sk) => this._selectSketch(sk),
      onDelete:  (sk) => this._removeSketch(sk),
      ariaLabel: 'Наброски',
    });
    return panel;
  }

  _syncPanel() {
    const p = this._panel;
    if (!p) return;
    const sk     = this.selected;
    const rowSel = p.querySelector('.draw-panel__row--selected');
    p.querySelector('.draw-panel__width').value           = this.lineWidth;
    p.querySelector('.draw-panel__val-width').textContent = Math.round(this.lineWidth);
    if (!sk) { rowSel.style.display = 'none'; return; }
    rowSel.style.display = '';
    p.querySelector('.draw-panel__opacity').value           = Math.round(sk.opacity * 100);
    p.querySelector('.draw-panel__val-opacity').textContent = Math.round(sk.opacity * 100);
    p.querySelector('.draw-panel__lock-aspect').checked     = sk.lockAspect;
    p.querySelector('.draw-panel__color').value             = sk.color;
    p.querySelector('.draw-panel__width').value             = sk.lineWidth;
    p.querySelector('.draw-panel__val-width').textContent   = Math.round(sk.lineWidth);
  }

  _renderSketchList() {
    if (!this._panel || !this._cards) return;
    const wrap = this._panel.querySelector('.draw-panel__sketches-wrap');
    if (!this.sketches.length) { wrap.style.display = 'none'; this._cards.clear(); return; }
    wrap.style.display = '';
    this._cards.render(this.sketches, this.selected);
  }
}
