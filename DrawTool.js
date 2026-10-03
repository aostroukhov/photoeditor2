/**
 * DrawTool v3.6
 *
 * Изменения v3.6:
 *  • Все внутренние поля и методы переведены на ES2022 Private Fields (#).
 *  • Bound-обработчики объявлены как приватные поля — гарантирует корректный
 *    removeEventListener и исключает их подмену снаружи.
 *  • Убран вызов _handleToolStop (метод удалён из PhotoEditor v3.6).
 *  • apply() больше не экспортирует в this.photoEditor.export автоматически.
 *
 * Исправления v1.3 (сохранены):
 *  • _endPointer: убран двойной clearTimeout — таймер удержания реально срабатывает.
 *  • Resize: исправлена геометрия — фиксируем противоположный угол в экранных координатах.
 *  • Распознавание форм: разделение круг/квадрат через подсчёт углов с правильным шагом.
 *  • Стрелка: прямая линия + удержание ≥2 с → острие в точке отпускания.
 *
 * ── Жизненный цикл ───────────────────────────────────────────────────────────
 *   start(), suspend(), cancel(), apply(), openSettings(), destroy()
 *
 * ── Публичные поля (читаются PhotoEditor / другими инструментами) ─────────────
 *   isActive, isSuspended
 *   sketches, selected
 *   color, lineWidth, opacity, lockAspect
 *   overlayCanvas, overlayCtx
 *
 * ── Приватные поля (#) ───────────────────────────────────────────────────────
 *   #stopping, #suspending
 *   #drawing, #currentPts, #shiftLine, #holdTimer
 *   #drag, #resize, #opDrag
 *   #panel, #altCursor
 *   Bound-обработчики: #onMouseDownBound и т.д.
 */

import { EditorConfig } from './EditorConfig.js';
import { isEditableTarget } from './utils.js';

const CFG = EditorConfig.draw;


// ─── Утилита: миниатюра наброска ─────────────────────────────────────────────

function sketchThumb(sk, size = 56) {
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

class Sketch {
  constructor({
    points = [], color = CFG.defaultColor, lineWidth = CFG.defaultWidth,
    opacity = CFG.defaultOpacity, x = 0, y = 0,
    scaleX = 1, scaleY = 1, lockAspect = true,
  } = {}) {
    this.id         = Sketch._nextId++;
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
    if (!this.points.length) return (this._bbox = { left:0, top:0, right:0, bottom:0 });
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
Sketch._nextId = 1;


// ─── Распознавание форм ───────────────────────────────────────────────────────

function recognizeShape(pts) {
  if (pts.length < CFG.minPointsForRecognition) return null;

  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const w = maxX - minX, h = maxY - minY;
  if (w < 4 || h < 4) return null;

  const cx    = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const first = pts[0], last = pts[pts.length - 1];
  const closeDist = Math.hypot(last.x - first.x, last.y - first.y);
  const isClosed  = closeDist < Math.max(w, h) * 2 * CFG.closedShapeThreshold;
  if (!isClosed) return null; // незамкнутые — только через удержание (стрелка)

  const aspectRatio = w / h;
  const dists    = pts.map(p => Math.hypot(p.x - cx, p.y - cy));
  const avgD     = dists.reduce((s, d) => s + d, 0) / dists.length;
  const variance = dists.reduce((s, d) => s + (d - avgD) ** 2, 0) / dists.length;
  const cv       = Math.sqrt(variance) / avgD;
  const cornerCount = _countCorners(pts);

  // Приоритет: явные углы (≥ 3) → прямоугольник/квадрат
  if (cornerCount >= 3) {
    if (Math.abs(aspectRatio - 1) < 0.25) {
      const side = (w + h) / 2;
      return _makeRect(cx - side/2, cy - side/2, side, side, 'square');
    }
    return _makeRect(minX, minY, w, h, 'rect');
  }

  // Нет углов и малый CV → круг/эллипс
  if (cv < 0.20) {
    if (Math.abs(aspectRatio - 1) < 0.25)
      return _makeEllipse(cx, cy, Math.max(w,h)/2, Math.max(w,h)/2, 'circle');
    return _makeEllipse(cx, cy, w/2, h/2, 'ellipse');
  }

  // Мало углов + высокий CV → тоже прямоугольник (нарисован неровно)
  if (Math.abs(aspectRatio - 1) < 0.25) {
    const side = (w + h) / 2;
    return _makeRect(cx - side/2, cy - side/2, side, side, 'square');
  }
  return _makeRect(minX, minY, w, h, 'rect');
}

/**
 * Подсчёт угловых точек с нормализованным шагом (~7% длины траектории).
 * Угол > ~72° (cos < 0.3) считается угловым.
 */
function _countCorners(pts) {
  const n    = pts.length;
  const step = Math.max(3, Math.round(n * 0.07));
  let corners = 0;
  for (let i = step; i < n - step; i += Math.max(1, Math.round(step / 2))) {
    const ax = pts[i].x     - pts[i - step].x, ay = pts[i].y     - pts[i - step].y;
    const bx = pts[i+step].x - pts[i].x,       by = pts[i+step].y - pts[i].y;
    const lenA = Math.hypot(ax, ay), lenB = Math.hypot(bx, by);
    if (lenA < 2 || lenB < 2) continue;
    const cos = (ax*bx + ay*by) / (lenA * lenB);
    if (cos < 0.3) corners++;
  }
  return corners;
}

/** Прямая линия: максимальное отклонение точек от хорды < 12% длины. */
function _isStraightLine(pts) {
  if (pts.length < 2) return false;
  const p0 = pts[0], pN = pts[pts.length - 1];
  const len = Math.hypot(pN.x - p0.x, pN.y - p0.y);
  if (len < 15) return false;
  const ux = (pN.x - p0.x) / len, uy = (pN.y - p0.y) / len;
  let maxDev = 0;
  for (const p of pts) {
    const dx = p.x - p0.x, dy = p.y - p0.y;
    const dev = Math.abs(dx * uy - dy * ux);
    if (dev > maxDev) maxDev = dev;
  }
  return maxDev < len * 0.12;
}

function _makeArrow(pts) {
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

function _makeEllipse(cx, cy, rx, ry, shape) {
  const pts = [];
  for (let i = 0; i <= 64; i++) {
    const a = (i / 64) * 2 * Math.PI;
    pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) });
  }
  return { shape, points: pts };
}

function _makeRect(x, y, w, h, shape) {
  return { shape, points: [{ x, y },{ x: x+w, y },{ x: x+w, y: y+h },{ x, y: y+h },{ x, y }] };
}


// ─── Хранение настроек кисти ──────────────────────────────────────────────────

function _loadDrawColor() {
  try { return localStorage.getItem(CFG.colorStorageKey) || CFG.defaultColor; }
  catch { return CFG.defaultColor; }
}
function _saveDrawColor(v) {
  try { localStorage.setItem(CFG.colorStorageKey, v); } catch {}
}
function _loadDrawWidth() {
  try {
    const v = localStorage.getItem(CFG.widthStorageKey);
    return v !== null ? Math.max(CFG.minWidth, Math.min(CFG.maxWidth, Number(v))) : CFG.defaultWidth;
  } catch { return CFG.defaultWidth; }
}
function _saveDrawWidth(v) {
  try { localStorage.setItem(CFG.widthStorageKey, String(v)); } catch {}
}


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


// ─── DrawTool ─────────────────────────────────────────────────────────────────

export class DrawTool {

  // ── Приватные поля ──────────────────────────────────────────────────────────

  /** true — идёт destroy; предотвращает повторный вход. */
  #stopping   = false;
  /** true — идёт programmatic suspend(); предотвращает вызов suspend() из onClose. */
  #suspending = false;

  /** true — пользователь рисует (зажата кнопка, идёт запись точек). */
  #drawing         = false;
  /** Точки текущего незавершённого мазка. */
  #currentPts      = [];
  /** true — зажат Shift (рисование по осям). */
  #shiftLine       = false;
  /** Handle от setTimeout для таймера распознавания фигуры при удержании. */
  #holdTimer       = null;

  /** Состояние перетаскивания наброска: { startX, startY, origX, origY }. */
  #drag   = null;
  /** Состояние resize: { handle, anchorX, anchorY, origW, origH, bboxW, bboxH, aspect }. */
  #resize = null;
  /** Состояние перетаскивания ручки прозрачности: { startY, origOpacity }. */
  #opDrag = null;

  /** DOM-элемент панели управления. null когда инструмент неактивен. */
  #panel = null;
  /** true — курсор переключён в режим пипетки (Alt зажат). */
  #altCursor = false;

  // ── Bound-обработчики событий ─────────────────────────────────────────────
  //
  // Приватные поля-стрелки гарантируют:
  //   • один объект функции на весь жизненный цикл → removeEventListener работает
  //   • не экспонируются снаружи → нельзя подменить или вызвать напрямую

  #onMouseDownBound  = (e) => this.#onMouseDown(e);
  #onMouseMoveBound  = (e) => this.#onMouseMove(e);
  #onMouseUpBound    = ()  => this.#onMouseUp();
  #onTouchStartBound = (e) => this.#onTouchStart(e);
  #onTouchMoveBound  = (e) => this.#onTouchMove(e);
  #onTouchEndBound   = ()  => this.#onTouchEnd();
  #onKeyDownBound    = (e) => this.#onKeyDown(e);
  #onWinResizeBound  = ()  => this.#onWinResize();


  // ── Публичные поля ──────────────────────────────────────────────────────────

  /** true — инструмент активен (canvas виден, события привязаны). */
  isActive    = false;
  /** true — приостановлен (состояние сохранено, canvas скрыт). */
  isSuspended = false;

  /** Canvas-оверлей поверх imgElement. Публичный: PhotoEditor может обращаться. */
  overlayCanvas = null;
  /** 2D-контекст overlayCanvas. */
  overlayCtx    = null;

  /** Все наброски текущей сессии. */
  sketches = [];
  /** Выбранный набросок или null. */
  selected = null;

  /** Текущий цвет кисти (CSS hex). Персистируется в localStorage. */
  color      = _loadDrawColor();
  /** Текущая толщина кисти (px). Персистируется в localStorage. */
  lineWidth  = _loadDrawWidth();
  /** Прозрачность (0.0–1.0). */
  opacity    = CFG.defaultOpacity;
  /** true — resize с сохранением пропорций. */
  lockAspect = true;


  // ── Конструктор ─────────────────────────────────────────────────────────────

  constructor(photoEditor) {
    this.photoEditor = photoEditor;
  }


  // ── Публичный API: жизненный цикл ───────────────────────────────────────────

  start() {
    if (this.isSuspended) { this.#resume(); return; }
    if (this.isActive)    return;
    const imgEl = this.photoEditor.imgElement;
    if (!imgEl?.naturalWidth) {
      imgEl?.addEventListener('load', () => {
        if (this.photoEditor.imgElement?.naturalWidth) this.start();
      }, { once: true });
      return;
    }
    this.isActive = true;
    this.photoEditor.activeTool = this;
    this.#createCanvas();
    this.#showCanvas();
    this.#createPanel();
    this.#bindEvents();
    this.#draw();
    this.photoEditor.syncToolButtons?.();
  }

  suspend() {
    if (!this.isActive || this.isSuspended) return;
    this.#cancelDraw();
    this.#unbindEvents();
    this.selected = null;
    if (this.overlayCanvas) {
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
      this.overlayCanvas.style.pointerEvents = 'none';
      this.#draw();
    }
    this.#suspending = true;
    this.photoEditor.dialogs?.close('draw');
    this.#suspending = false;
    this.isActive    = false;
    this.isSuspended = true;
    this.photoEditor.activeTool = null;
    this.photoEditor.syncToolButtons?.();
  }

  cancel() {
    this.sketches = [];
    this.selected = null;
    this.#destroyInternal();
  }

  /**
   * Применить рисунок — смержить наброски с pe.img через commitImage().
   * Сохранение в источник (this.photoEditor.export) происходит только
   * при явном закрытии через requestClose().
   */
  apply() {
    const result = this.#renderToCanvas();
    const url    = result.toDataURL('image/png');
    const newImg = new Image();
    newImg.onload = () => {
      this.photoEditor.commitImage(newImg);
    };
    newImg.src = url;
    this.sketches = [];
    this.selected = null;
    this.#destroyInternal();
  }

  openSettings() { this.photoEditor.dialogs?.toggle('draw'); }

  destroy() {
    this.sketches = [];
    this.selected = null;
    this.#destroyInternal();
    this.overlayCanvas?.remove();
    this.overlayCanvas = null;
    this.overlayCtx    = null;
  }


  // ── Приватные методы: жизненный цикл ────────────────────────────────────────

  #resume() {
    if (!this.isSuspended) return;
    const imgEl = this.photoEditor.imgElement;
    if (!imgEl?.naturalWidth) return;
    this.isActive    = true;
    this.isSuspended = false;
    this.photoEditor.activeTool = this;
    if (this.overlayCanvas) { this.overlayCanvas.style.pointerEvents = ''; }
    else { this.#createCanvas(); }
    this.#showCanvas();
    if (this.#panel) { this.photoEditor.dialogs?.open('draw'); }
    else { this.#createPanel(); }
    this.#bindEvents();
    this.#draw();
    this.photoEditor.syncToolButtons?.();
  }

  #destroyInternal() {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#cancelDraw();
    this.#unbindEvents();
    if (!this.isSuspended && this.overlayCanvas) {
      this.overlayCanvas.remove();
      this.overlayCanvas = null;
      this.overlayCtx    = null;
    }
    const panel = this.#panel; this.#panel = null;
    if (panel) { this.photoEditor.dialogs?.unregister('draw'); panel.remove(); }
    this.isActive    = false;
    this.isSuspended = false;
    this.#stopping   = false;
    this.photoEditor.activeTool = null;
    this.photoEditor.syncToolButtons?.();
  }

  #showCanvas() { if (this.overlayCanvas) this.overlayCanvas.style.pointerEvents = ''; }


  // ── Приватные методы: canvas ─────────────────────────────────────────────────

  #createCanvas() {
    if (this.overlayCanvas) return;
    const imgEl = this.photoEditor.imgElement;
    const w = imgEl?.offsetWidth  || this.photoEditor.img?.naturalWidth  || 400;
    const h = imgEl?.offsetHeight || this.photoEditor.img?.naturalHeight || 300;
    this.overlayCanvas        = document.createElement('canvas');
    this.overlayCanvas.width  = w;
    this.overlayCanvas.height = h;
    this.overlayCtx           = this.overlayCanvas.getContext('2d');
    const parent = imgEl?.parentElement
      || this.photoEditor.container?.querySelector('.photoeditor__img-container');
    parent?.appendChild(this.overlayCanvas);
  }

  /**
   * Синхронизирует размер canvas с текущим display-размером imgElement.
   * При изменении размера масштабирует все точки набросков пропорционально.
   */
  #syncCanvasSize() {
    const imgEl = this.photoEditor.imgElement;
    if (!imgEl || !this.overlayCanvas) return;
    const newW = imgEl.offsetWidth  || imgEl.width;
    const newH = imgEl.offsetHeight || imgEl.height;
    if (!newW || !newH) return;
    if (this.overlayCanvas.width === newW && this.overlayCanvas.height === newH) return;
    const kx = newW / this.overlayCanvas.width;
    const ky = newH / this.overlayCanvas.height;
    for (const sk of this.sketches) {
      sk.points = sk.points.map(p => ({ x: p.x * kx, y: p.y * ky }));
      sk.invalidateBbox();
      sk.x *= kx; sk.y *= ky;
    }
    if (this.#currentPts.length)
      this.#currentPts = this.#currentPts.map(p => ({ x: p.x * kx, y: p.y * ky }));
    this.overlayCanvas.width  = newW;
    this.overlayCanvas.height = newH;
  }


  // ── Приватные методы: экспорт в canvas ──────────────────────────────────────

  /**
   * Рендерит итоговое изображение (pe.img + все наброски) в новый canvas
   * с натуральным разрешением. Используется в apply().
   */
  #renderToCanvas() {
    const pe  = this.photoEditor;
    const img = pe.img;
    if (!img) throw new Error('[DrawTool] renderToCanvas: img не задан');
    const out = document.createElement('canvas');
    out.width  = img.naturalWidth;
    out.height = img.naturalHeight;
    const ctx  = out.getContext('2d');
    ctx.drawImage(img, 0, 0);
    if (!this.sketches.length) return out;
    const k = img.naturalWidth / (pe.imgElement?.width || img.naturalWidth);
    for (const sk of this.sketches) {
      new Sketch({
        points:    sk.points.map(p => ({ x: p.x * k, y: p.y * k })),
        color:     sk.color, lineWidth: sk.lineWidth * k, opacity: sk.opacity,
        x: sk.x * k, y: sk.y * k, scaleX: sk.scaleX, scaleY: sk.scaleY,
      }).render(ctx);
    }
    return out;
  }


  // ── Приватные методы: отрисовка ──────────────────────────────────────────────

  #draw() {
    if (!this.overlayCtx) return;
    this.#syncCanvasSize();
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

    // Выбранный рисуется поверх — без изменения порядка массива
    const order = this.selected
      ? [...this.sketches.filter(s => s !== this.selected), this.selected]
      : [...this.sketches];

    for (const sk of order) {
      sk.render(ctx);
      if (sk === this.selected && this.isActive && !this.#drawing)
        this.#drawHandles(ctx, sk);
    }

    if (this.#drawing && this.#currentPts.length >= 2) {
      ctx.save();
      ctx.globalAlpha = this.opacity;
      ctx.strokeStyle = this.color;
      ctx.lineWidth   = this.lineWidth;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(this.#currentPts[0].x, this.#currentPts[0].y);
      for (let i = 1; i < this.#currentPts.length; i++)
        ctx.lineTo(this.#currentPts[i].x, this.#currentPts[i].y);
      ctx.stroke();
      ctx.restore();
    }
  }

  #drawHandles(ctx, sk) {
    const x0 = sk.dispLeft, y0 = sk.dispTop, x1 = sk.dispRight, y1 = sk.dispBottom;
    const w   = x1 - x0, h = y1 - y0;
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 1.5;
    ctx.strokeRect(x0, y0, w, h);
    ctx.setLineDash([]);
    const corners = [{ x: x0, y: y0 },{ x: x1, y: y0 },{ x: x1, y: y1 },{ x: x0, y: y1 }];
    ctx.fillStyle = 'rgba(60,143,224,0.95)';
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
    for (const p of corners) {
      ctx.beginPath(); ctx.arc(p.x, p.y, HR, 0, Math.PI*2); ctx.fill(); ctx.stroke();
    }
    const opH = { x: x0 + w/2, y: y0 - OP_OFFSET };
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1; ctx.setLineDash([3,3]);
    ctx.beginPath(); ctx.moveTo(x0 + w/2, y0); ctx.lineTo(opH.x, opH.y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,200,0,0.95)'; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(opH.x, opH.y, HR, 0, Math.PI*2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = sk.lockAspect ? 'rgba(100,220,100,0.9)' : 'rgba(200,200,200,0.5)';
    ctx.beginPath(); ctx.arc(x1 + HR + 1, y1 - HR - 1, HR*0.55, 0, Math.PI*2); ctx.fill();
    ctx.restore();
  }


  // ── Приватные методы: hit-test ───────────────────────────────────────────────

  #corners(sk) {
    return [
      { x: sk.dispLeft,  y: sk.dispTop    },
      { x: sk.dispRight, y: sk.dispTop    },
      { x: sk.dispRight, y: sk.dispBottom },
      { x: sk.dispLeft,  y: sk.dispBottom },
    ];
  }

  #opHandle(sk) { return { x: sk.dispLeft + sk.displayW/2, y: sk.dispTop - OP_OFFSET }; }

  #hitTest(x, y) {
    const order = this.selected
      ? [...this.sketches.filter(s => s !== this.selected), this.selected]
      : [...this.sketches];
    for (let i = order.length - 1; i >= 0; i--) {
      const sk = order[i];
      // Ручки (прозрачность, углы) рисуются только у выбранного наброска —
      // проверять их у остальных нельзя: невидимая зона перехватывала новый мазок.
      if (sk === this.selected) {
        const oh = this.#opHandle(sk);
        if (Math.hypot(x - oh.x, y - oh.y) <= HR + 5) return { type: 'opacity', sk };
        const c = this.#corners(sk);
        for (let j = 0; j < 4; j++) {
          if (Math.hypot(x - c[j].x, y - c[j].y) <= HR + 5)
            return { type: 'resize', handle: RESIZE_HANDLES[j].name, sk };
        }
      }
      if (x >= sk.dispLeft && x <= sk.dispRight && y >= sk.dispTop && y <= sk.dispBottom)
        return { type: 'move', sk };
    }
    return null;
  }

  #cursorFor(hit) {
    if (!hit)               return 'crosshair';
    if (hit.type === 'move')    return 'move';
    if (hit.type === 'opacity') return 'ns-resize';
    if (hit.type === 'resize') {
      const r = RESIZE_HANDLES.find(h => h.name === hit.handle);
      return r ? r.cursor : 'nwse-resize';
    }
    return 'default';
  }

  #setCursor(cur) { if (this.overlayCanvas) this.overlayCanvas.style.cursor = cur; }

  #clientToCanvas(cx, cy) {
    const r = this.overlayCanvas.getBoundingClientRect();
    return {
      x: (cx - r.left) * (this.overlayCanvas.width  / r.width),
      y: (cy - r.top)  * (this.overlayCanvas.height / r.height),
    };
  }


  // ── Приватные методы: обработчики событий ────────────────────────────────────

  #onMouseDown(e) {
    if (e.button !== 0) return;
    if (e.altKey) {
      e.preventDefault();
      const { x, y } = this.#clientToCanvas(e.clientX, e.clientY);
      this.#pickColor(x, y);
      return;
    }
    this.#shiftLine       = e.shiftKey;
    const { x, y } = this.#clientToCanvas(e.clientX, e.clientY);
    this.#startPointer(x, y);
  }

  #onMouseMove(e) {
    const { x, y } = this.#clientToCanvas(e.clientX, e.clientY);
    this.#shiftLine = e.shiftKey;

    if (e.altKey && !this.#drawing && !this.#drag && !this.#resize && !this.#opDrag) {
      this.#setCursor('crosshair');
      this.#setAltHint(true);
      return;
    }
    this.#setAltHint(false);

    if (this.#resize && this.selected) {
      this.selected.lockAspect = !e.shiftKey;
      this.#syncPanel();
    }
    this.#movePointer(x, y);
    if (!this.#drag && !this.#resize && !this.#opDrag && !this.#drawing) {
      this.#setCursor(this.#cursorFor(this.#hitTest(x, y)));
    }
  }

  #onMouseUp() { this.#endPointer(); }

  #onTouchStart(e) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const { x, y } = this.#clientToCanvas(e.touches[0].clientX, e.touches[0].clientY);
    this.#startPointer(x, y);
  }

  #onTouchMove(e) {
    if (!this.#drawing && !this.#drag && !this.#resize && !this.#opDrag) return;
    e.preventDefault();
    const { x, y } = this.#clientToCanvas(e.touches[0].clientX, e.touches[0].clientY);
    this.#movePointer(x, y);
  }

  #onTouchEnd() { this.#endPointer(); }

  #onWinResize() {
    requestAnimationFrame(() => requestAnimationFrame(() => this.#draw()));
  }

  #onKeyDown(e) {
    if (isEditableTarget(e)) return false;
    const isBracketL = e.code === 'BracketLeft';
    const isBracketR = e.code === 'BracketRight';

    if ((isBracketL || isBracketR) && this.isActive) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.lineWidth = isBracketL
        ? Math.max(CFG.minWidth, this.lineWidth - 1)
        : Math.min(CFG.maxWidth, this.lineWidth + 1);
      _saveDrawWidth(this.lineWidth);
      this.#syncWidthPanel();
      return true;
    }

    if (!this.isActive) return false;
    if (e.code === 'Escape' || e.key === 'Escape') {
      // Гасим событие: иначе PhotoEditor увидит пустой набор диалогов
      // (панель уже снята cancel()) и закроет редактор целиком.
      e.preventDefault(); e.stopImmediatePropagation();
      this.cancel(); return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      e.preventDefault(); e.stopImmediatePropagation();
      this.#removeSketch(this.selected); return true;
    }
    return false;
  }


  // ── Приватные методы: логика рисования и трансформации ──────────────────────

  #startPointer(x, y) {
    if (!this.#drawing) {
      const hit = this.#hitTest(x, y);
      if (hit) {
        const { type, sk, handle } = hit;
        if (this.selected !== sk) {
          this.selected = sk;
          this.#draw(); this.#syncPanel();
          this.#scrollSketchListToSelected();
          this.#updateSketchListActive();
        }
        this.#setCursor(this.#cursorFor(hit));

        if (type === 'move') {
          this.#drag = { startX: x, startY: y, origX: sk.x, origY: sk.y };

        } else if (type === 'resize') {
          // Фиксируем экранные координаты ПРОТИВОПОЛОЖНОГО угла
          this.#resize = {
            handle,
            anchorX: (handle === 'topLeft' || handle === 'bottomLeft') ? sk.dispRight  : sk.dispLeft,
            anchorY: (handle === 'topLeft' || handle === 'topRight')   ? sk.dispBottom : sk.dispTop,
            origW:   sk.displayW,
            origH:   sk.displayH,
            bboxW:   sk.bbox.right  - sk.bbox.left || 1,
            bboxH:   sk.bbox.bottom - sk.bbox.top  || 1,
            aspect:  sk.displayW / (sk.displayH || 1),
          };

        } else if (type === 'opacity') {
          this.#opDrag = { startY: y, origOpacity: sk.opacity };
          this.#setCursor('ns-resize');
        }
        return;
      }
      this.selected = null;
      this.#syncPanel();
      this.#renderSketchList();
    }

    this.#drawing    = true;
    this.#currentPts = [{ x, y }];
    this.#setCursor('crosshair');
    clearTimeout(this.#holdTimer);
    this.#draw();
  }

  #movePointer(x, y) {
    if (this.#drag) {
      const sk = this.selected;
      sk.x = this.#drag.origX + (x - this.#drag.startX);
      sk.y = this.#drag.origY + (y - this.#drag.startY);
      this.#setCursor('move');
      this.#draw(); this.#syncPanel();
      return;
    }

    if (this.#opDrag) {
      const dy = this.#opDrag.startY - y;
      this.selected.opacity = Math.max(0.05, Math.min(1, this.#opDrag.origOpacity + dy / 200));
      this.#draw(); this.#syncPanel();
      return;
    }

    if (this.#resize) {
      const sk   = this.selected;
      const r    = this.#resize;
      const lock = sk.lockAspect;
      let newW   = Math.max(MIN_SIZE, Math.abs(x - r.anchorX));
      let newH   = Math.max(MIN_SIZE, Math.abs(y - r.anchorY));
      if (lock) {
        const rw = newW / r.origW, rh = newH / r.origH;
        if (rw > rh) newH = newW / r.aspect; else newW = newH * r.aspect;
        newW = Math.max(MIN_SIZE, newW); newH = Math.max(MIN_SIZE, newH);
      }
      sk.scaleX = newW / r.bboxW;
      sk.scaleY = newH / r.bboxH;
      const b = sk.bbox;
      if (r.handle === 'topLeft' || r.handle === 'bottomLeft') sk.x = r.anchorX - b.right  * sk.scaleX;
      else                                                      sk.x = r.anchorX - b.left   * sk.scaleX;
      if (r.handle === 'topLeft' || r.handle === 'topRight')   sk.y = r.anchorY - b.bottom * sk.scaleY;
      else                                                      sk.y = r.anchorY - b.top    * sk.scaleY;
      const rh2 = RESIZE_HANDLES.find(h => h.name === r.handle);
      if (rh2) this.#setCursor(rh2.cursor);
      this.#draw(); this.#syncPanel();
      return;
    }

    if (!this.#drawing) return;

    let px = x, py = y;
    if (this.#shiftLine && this.#currentPts.length >= 1) {
      const p0   = this.#currentPts[0];
      const dx   = x - p0.x, dy = y - p0.y;
      const snap = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const dist = Math.hypot(dx, dy);
      px = p0.x + dist * Math.cos(snap);
      py = p0.y + dist * Math.sin(snap);
      this.#currentPts = [p0, { x: px, y: py }];
    } else {
      this.#currentPts.push({ x: px, y: py });
    }
    this.#resetHoldTimer();
    this.#draw();
  }

  /**
   * Запускает/перезапускает таймер удержания.
   * Если пользователь остановил движение ≥ shapeRecognitionHoldMs не отпуская
   * кнопку — срабатывает распознавание фигуры.
   */
  #resetHoldTimer() {
    clearTimeout(this.#holdTimer);
    this.#holdTimer = setTimeout(() => {
      if (this.#drawing) this.#tryRecognizeAndFinalize();
    }, CFG.shapeRecognitionHoldMs);
  }

  #endPointer() {
    if (this.#drag)   { this.#drag   = null; this.#setCursor('default'); return; }
    if (this.#opDrag) { this.#opDrag = null; this.#setCursor('default'); return; }
    if (this.#resize) {
      this.#resize = null; this.#setCursor('default');
      this.#renderSketchList();
      return;
    }
    if (!this.#drawing) return;

    // Распознавание фигуры запускает только таймер удержания (#resetHoldTimer):
    // он срабатывает, если курсор неподвижен ≥ shapeRecognitionHoldMs при зажатой
    // кнопке, и сам завершает набросок. Раньше здесь сравнивалась длительность
    // всего мазка, и любой свободный рисунок дольше 2 с принудительно
    // превращался в прямоугольник/эллипс/стрелку.
    clearTimeout(this.#holdTimer);
    this.#finalizeSketch();
  }

  #cancelDraw() {
    clearTimeout(this.#holdTimer);
    this.#drawing    = false;
    this.#currentPts = [];
  }

  #tryRecognizeAndFinalize() {
    const pts = this.#currentPts;
    if (!pts.length) return;
    if (_isStraightLine(pts)) {
      const arrow = _makeArrow(pts);
      if (arrow) { this.#currentPts = arrow.points; this.#finalizeSketch(); return; }
    }
    const recognized = recognizeShape(pts);
    if (recognized) this.#currentPts = recognized.points;
    this.#finalizeSketch();
  }

  #finalizeSketch() {
    if (this.#currentPts.length < 2) {
      this.#drawing = false; this.#currentPts = []; return;
    }
    const sk = new Sketch({
      points:    [...this.#currentPts],
      color:     this.color, lineWidth: this.lineWidth,
      opacity:   this.opacity, lockAspect: this.lockAspect,
    });
    this.sketches.push(sk);
    this.selected    = sk;
    this.#drawing    = false;
    this.#currentPts = [];
    this.#draw(); this.#syncPanel(); this.#renderSketchList();
  }

  #removeSketch(sk) {
    this.sketches = this.sketches.filter(s => s !== sk);
    if (this.selected === sk) this.selected = this.sketches.at(-1) ?? null;
    this.#draw(); this.#syncPanel(); this.#renderSketchList();
  }

  #selectSketch(sk) {
    if (this.selected === sk) return;
    this.selected = sk;
    this.#draw(); this.#syncPanel();
    this.#scrollSketchListToSelected();
    this.#updateSketchListActive();
  }


  // ── Приватные методы: подписка на события ───────────────────────────────────

  #bindEvents() {
    const c = this.overlayCanvas;
    c.addEventListener('mousedown',  this.#onMouseDownBound);
    c.addEventListener('touchstart', this.#onTouchStartBound, { passive: false });
    document.addEventListener('mousemove', this.#onMouseMoveBound);
    document.addEventListener('mouseup',   this.#onMouseUpBound);
    document.addEventListener('touchmove', this.#onTouchMoveBound, { passive: false });
    document.addEventListener('touchend',  this.#onTouchEndBound);
    window.addEventListener('resize',      this.#onWinResizeBound);
    document.addEventListener('keydown',   this.#onKeyDownBound, { capture: true });
  }

  #unbindEvents() {
    if (!this.overlayCanvas) return;
    const c = this.overlayCanvas;
    c.removeEventListener('mousedown',  this.#onMouseDownBound);
    c.removeEventListener('touchstart', this.#onTouchStartBound);
    document.removeEventListener('mousemove', this.#onMouseMoveBound);
    document.removeEventListener('mouseup',   this.#onMouseUpBound);
    document.removeEventListener('touchmove', this.#onTouchMoveBound);
    document.removeEventListener('touchend',  this.#onTouchEndBound);
    window.removeEventListener('resize',      this.#onWinResizeBound);
    document.removeEventListener('keydown',   this.#onKeyDownBound, { capture: true });
  }


  // ── Приватные методы: панель управления ──────────────────────────────────────

  #createPanel() {
    if (this.#panel) return;
    const panel = document.createElement('div');
    panel.className = 'pe-panel pe-panel--draw';
    panel.innerHTML = `
      <div class="pe-panel__header">
        <span class="pe-panel__title">Рисунок</span>
        <div class="pe-panel__header-actions">
          <button type="button" class="photoeditor__button photoeditor__button--compact draw-panel__btn-cancel"
                  title="Отмена"><i class="icon-close" aria-hidden="true"></i> Отмена</button>
          <button type="button" class="photoeditor__button photoeditor__button--compact photoeditor__button--success draw-panel__btn-apply"
                  title="Применить"><i class="icon-checkmark" aria-hidden="true"></i> Применить</button>
        </div>
      </div>
      <div class="draw-panel__row draw-panel__row--brush">
        <label class="draw-panel__lbl" title="Цвет линии">
          <span class="draw-panel__lbl-text">Цвет</span>
          <input type="color" class="draw-panel__color" value="${this.color}">
        </label>
        <label class="draw-panel__lbl" title="Толщина линии">
          <span class="draw-panel__lbl-text">Толщина</span>
          <input type="range" class="draw-panel__width"
                 min="${CFG.minWidth}" max="${CFG.maxWidth}" value="${this.lineWidth}">
          <span class="draw-panel__val-width">${this.lineWidth}</span>px
        </label>
      </div>
      <div class="draw-panel__row draw-panel__row--selected" style="display:none">
        <button type="button" class="photoeditor__button photoeditor__button--compact photoeditor__button--danger draw-panel__btn-del-sketch"
                title="Удалить набросок">
          <i class="icon-bin" aria-hidden="true"></i>
        </button>
        <label class="draw-panel__lbl" title="Прозрачность">
          <span class="draw-panel__lbl-text">Прозрачность</span>
          <input type="range" class="draw-panel__opacity" min="5" max="100" value="100">
          <span class="draw-panel__val-opacity">100</span>%
        </label>
        <label class="draw-panel__lock-label" title="Пропорции (Shift — отключить)">
          <input type="checkbox" class="draw-panel__lock-aspect" checked>
          <span class="draw-panel__lbl-text">Пропорции</span>
        </label>
      </div>
      <div class="draw-panel__sketches-wrap" style="display:none">
        <div class="draw-panel__sketches-label">Наброски</div>
        <div class="draw-panel__sketches-list"></div>
      </div>
      <div class="draw-panel__hint" data-default="Shift — прямые · удержание ≥2 с — фигура/стрелка · Alt — пипетка">
        Shift — прямые · удержание ≥2 с — фигура/стрелка · Alt — пипетка
      </div>`;

    this.#bindPanelEvents(panel);
    this.photoEditor.container.appendChild(panel);
    this.#panel = panel;
    this.photoEditor.dialogs?.register('draw', panel, {
      group:   'tool',
      onClose: () => {
        if (this.isActive && !this.#stopping && !this.#suspending) this.suspend();
      },
    });
    this.photoEditor.dialogs?.open('draw');
  }

  #bindPanelEvents(panel) {
    const colorEl  = panel.querySelector('.draw-panel__color');
    const widthEl  = panel.querySelector('.draw-panel__width');
    const widthVal = panel.querySelector('.draw-panel__val-width');
    const opEl     = panel.querySelector('.draw-panel__opacity');
    const opVal    = panel.querySelector('.draw-panel__val-opacity');
    const lockEl   = panel.querySelector('.draw-panel__lock-aspect');

    colorEl.addEventListener('input', () => {
      this.color = colorEl.value;
      _saveDrawColor(this.color);
      if (this.selected) { this.selected.color = this.color; this.#draw(); this.#renderSketchListThumbs(); }
    });
    widthEl.addEventListener('input', () => {
      this.lineWidth = Number(widthEl.value); widthVal.textContent = widthEl.value;
      _saveDrawWidth(this.lineWidth);
      if (this.selected) { this.selected.lineWidth = this.lineWidth; this.#draw(); }
    });
    opEl.addEventListener('input', () => {
      if (!this.selected) return;
      this.selected.opacity = opEl.value / 100; opVal.textContent = opEl.value; this.#draw();
    });
    lockEl.addEventListener('change', () => {
      this.lockAspect = lockEl.checked;
      if (this.selected) { this.selected.lockAspect = lockEl.checked; }
    });
    panel.querySelector('.draw-panel__btn-cancel').addEventListener('click', () => this.cancel());
    panel.querySelector('.draw-panel__btn-apply').addEventListener('click',  () => this.apply());
    panel.querySelector('.draw-panel__btn-del-sketch')?.addEventListener('click', () => {
      if (this.selected) this.#removeSketch(this.selected);
    });
  }

  /**
   * Читает цвет пикселя из оригинального изображения под курсором.
   * x, y — координаты в display-canvas (overlayCanvas).
   */
  #pickColor(x, y) {
    const pe  = this.photoEditor;
    const img = pe.img;
    if (!img) return;
    const dispW = pe.imgElement?.width  || img.naturalWidth;
    const dispH = pe.imgElement?.height || img.naturalHeight;
    const nx    = Math.round(x * (img.naturalWidth  / dispW));
    const ny    = Math.round(y * (img.naturalHeight / dispH));

    // Читаем пиксель через временный offscreen canvas (не держим контекст от оригинала)
    const cv  = document.createElement('canvas');
    cv.width  = 1; cv.height = 1;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, nx, ny, 1, 1, 0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');

    this.color = hex;
    _saveDrawColor(hex);
    if (this.selected) this.selected.color = hex;

    if (this.#panel) {
      const colorEl = this.#panel.querySelector('.draw-panel__color');
      if (colorEl) colorEl.value = hex;
    }
    this.#draw();
    this.#renderSketchListThumbs();
    this.#flashPickedColor(hex, x, y);
  }

  /** Мигающая индикация захваченного цвета — кружок на 600 мс. */
  #flashPickedColor(hex, x, y) {
    if (!this.overlayCtx) return;
    const ctx = this.overlayCtx;
    const flash = () => {
      this.#draw();
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 16, 0, Math.PI * 2);
      ctx.fillStyle   = hex;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth   = 2;
      ctx.stroke();
      ctx.restore();
    };
    flash();
    setTimeout(() => { if (this.overlayCtx) this.#draw(); }, 600);
  }

  /** Переключает подсказку «Alt+клик — пипетка» в панели. */
  #setAltHint(on) {
    if (this.#altCursor === on) return;
    this.#altCursor = on;
    const hint = this.#panel?.querySelector('.draw-panel__hint');
    if (!hint) return;
    hint.textContent = on
      ? 'Alt+клик — захватить цвет с изображения'
      : hint.dataset.default;
  }

  #syncWidthPanel() {
    if (!this.#panel) return;
    const widthEl  = this.#panel.querySelector('.draw-panel__width');
    const widthVal = this.#panel.querySelector('.draw-panel__val-width');
    if (widthEl)  widthEl.value        = this.lineWidth;
    if (widthVal) widthVal.textContent = this.lineWidth;
    if (this.selected) { this.selected.lineWidth = this.lineWidth; this.#draw(); }
  }

  #syncPanel() {
    if (!this.#panel) return;
    const sk     = this.selected;
    const rowSel = this.#panel.querySelector('.draw-panel__row--selected');
    if (!sk) { rowSel.style.display = 'none'; return; }
    rowSel.style.display = '';
    this.#panel.querySelector('.draw-panel__opacity').value           = Math.round(sk.opacity * 100);
    this.#panel.querySelector('.draw-panel__val-opacity').textContent = Math.round(sk.opacity * 100);
    this.#panel.querySelector('.draw-panel__lock-aspect').checked     = sk.lockAspect;
    this.#panel.querySelector('.draw-panel__color').value             = sk.color;
    this.#panel.querySelector('.draw-panel__width').value             = sk.lineWidth;
    this.#panel.querySelector('.draw-panel__val-width').textContent   = Math.round(sk.lineWidth);
  }

  #renderSketchList() {
    if (!this.#panel) return;
    const wrap = this.#panel.querySelector('.draw-panel__sketches-wrap');
    const list = this.#panel.querySelector('.draw-panel__sketches-list');
    if (!list) return;
    if (!this.sketches.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    list.innerHTML = '';
    for (let i = this.sketches.length - 1; i >= 0; i--) {
      const sk       = this.sketches[i];
      const isActive = sk === this.selected;
      const card     = document.createElement('div');
      card.className    = 'draw-sketch-card' + (isActive ? ' is-active' : '');
      card.title        = `Набросок #${sk.id}`;
      card.dataset.skId = sk.id;
      let thumbSrc = '';
      try { thumbSrc = sketchThumb(sk, 48); } catch {}
      card.innerHTML = `
        <button type="button" class="draw-sketch-card__del" title="Удалить">
          <i class="icon-close" aria-hidden="true"></i>
        </button>
        ${thumbSrc
          ? `<img class="draw-sketch-card__thumb" src="${thumbSrc}" alt="" draggable="false">`
          : `<div class="draw-sketch-card__thumb draw-sketch-card__thumb--empty"></div>`}
        <div class="draw-sketch-card__color" style="background:${sk.color}"></div>`;
      card.querySelector('.draw-sketch-card__del').addEventListener('click', (e) => {
        e.stopPropagation(); this.#removeSketch(sk);
      });
      card.addEventListener('click', () => this.#selectSketch(sk));
      list.appendChild(card);
    }
    this.#scrollSketchListToSelected();
  }

  #updateSketchListActive() {
    if (!this.#panel) return;
    this.#panel.querySelectorAll('.draw-sketch-card').forEach(card => {
      const sk = this.sketches.find(s => s.id === Number(card.dataset.skId));
      card.classList.toggle('is-active', sk === this.selected);
    });
  }

  #renderSketchListThumbs() {
    if (!this.#panel) return;
    this.#panel.querySelectorAll('.draw-sketch-card').forEach(card => {
      const sk = this.sketches.find(s => s.id === Number(card.dataset.skId));
      if (!sk) return;
      const img = card.querySelector('.draw-sketch-card__thumb');
      if (img?.tagName === 'IMG') try { img.src = sketchThumb(sk, 48); } catch {}
      const bar = card.querySelector('.draw-sketch-card__color');
      if (bar) bar.style.background = sk.color;
    });
  }

  #scrollSketchListToSelected() {
    if (!this.#panel || !this.selected) return;
    const list = this.#panel.querySelector('.draw-panel__sketches-list');
    if (!list) return;
    const card = list.querySelector(`.draw-sketch-card[data-sk-id="${this.selected.id}"]`);
    if (!card) return;
    const target = card.offsetLeft - (list.clientWidth - card.offsetWidth) / 2;
    list.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  }
}
