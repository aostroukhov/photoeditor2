/**
 * MaskTool v1.1
 *
 * Исправления v1.1:
 *  • apply(): пикселизация рендерится корректно — renderPixelate получает
 *    правильный масштаб и ctx целевого canvas (не исходного изображения)
 *  • _draw(): live-preview работает без CORS-проблем
 */

import { EditorConfig } from './EditorConfig.js';
import { isEditableTarget } from './utils.js';

const CFG = EditorConfig.mask;
const HR  = 8;
const MIN = 10;


// ─── Модель области ───────────────────────────────────────────────────────────

class MaskRegion {
  constructor({ x = 0, y = 0, w = 100, h = 80, blockSize = CFG.defaultBlockSize } = {}) {
    this.id        = MaskRegion._nextId++;
    this.x         = x;
    this.y         = y;
    this.w         = w;
    this.h         = h;
    this.blockSize = blockSize;
  }
  get right()  { return this.x + this.w; }
  get bottom() { return this.y + this.h; }
  get cx()     { return this.x + this.w / 2; }
  get cy()     { return this.y + this.h / 2; }
  contains(px, py) {
    return px >= this.x && px <= this.right && py >= this.y && py <= this.bottom;
  }
}
MaskRegion._nextId = 1;


// ─── Пикселизация ─────────────────────────────────────────────────────────────

/**
 * Пикселизирует прямоугольную область на ctx.
 *
 * @param {CanvasRenderingContext2D} outCtx  — контекст назначения
 * @param {HTMLCanvasElement}        srcCanvas — исходный canvas с уже нарисованным img
 * @param {number} rx, ry, rw, rh  — область в пикселях srcCanvas
 * @param {number} blockPx         — размер квадратика в пикселях srcCanvas
 * @param {number} scaleX, scaleY  — коэффициент srcCanvas → outCtx (1.0 если одинаковые)
 */
function pixelateRect(outCtx, srcCanvas, rx, ry, rw, rh, blockPx, outX, outY, outW, outH) {
  if (rw < 1 || rh < 1) return;

  // Читаем пиксели из srcCanvas
  const tmpCtx = srcCanvas.getContext('2d');
  let imgData;
  try {
    imgData = tmpCtx.getImageData(rx, ry, rw, rh);
  } catch (e) {
    // CORS или tainted canvas
    console.warn('[MaskTool] getImageData failed:', e.message);
    return;
  }
  const data = imgData.data;

  const kx = outW / rw;  // масштаб src → out по X
  const ky = outH / rh;  // масштаб src → out по Y

  for (let by = 0; by < rh; by += blockPx) {
    for (let bx = 0; bx < rw; bx += blockPx) {
      const bw = Math.min(blockPx, rw - bx);
      const bh = Math.min(blockPx, rh - by);
      let r = 0, g = 0, b = 0, count = 0;

      for (let py = by; py < by + bh; py++) {
        for (let px = bx; px < bx + bw; px++) {
          const i = (py * rw + px) * 4;
          r += data[i]; g += data[i+1]; b += data[i+2];
          count++;
        }
      }
      if (!count) continue;

      outCtx.fillStyle = `rgb(${Math.round(r/count)},${Math.round(g/count)},${Math.round(b/count)})`;
      // Позиция и размер квадратика в outCtx
      outCtx.fillRect(
        outX + bx * kx,
        outY + by * ky,
        bw * kx + 0.5,
        bh * ky + 0.5,
      );
    }
  }
}

/**
 * Создаёт вспомогательный canvas с нарисованным img.
 * Используется как источник пикселей для getImageData.
 */
function imgToCanvas(img) {
  const cv = document.createElement('canvas');
  cv.width  = img.naturalWidth;
  cv.height = img.naturalHeight;
  cv.getContext('2d').drawImage(img, 0, 0);
  return cv;
}

/**
 * Миниатюра области для карточки.
 */
function regionThumb(srcCanvas, region, scale, size = 56) {
  const rx = Math.round(region.x * scale), ry = Math.round(region.y * scale);
  const rw = Math.max(1, Math.round(region.w * scale));
  const rh = Math.max(1, Math.round(region.h * scale));

  const cv  = document.createElement('canvas');
  cv.width  = size; cv.height = size;
  const ctx = cv.getContext('2d');

  const fit = Math.min(size / rw, size / rh) * 0.9;
  const dw  = rw * fit, dh = rh * fit;
  const ox  = (size - dw) / 2, oy = (size - dh) / 2;

  // Фрагмент оригинала
  ctx.drawImage(srcCanvas, rx, ry, rw, rh, ox, oy, dw, dh);

  // Поверх — пикселизация для превью
  pixelateRect(ctx, srcCanvas, rx, ry, rw, rh, Math.max(1, Math.round(region.blockSize * scale)), ox, oy, dw, dh);

  return cv.toDataURL('image/png');
}


// ─── MaskTool ─────────────────────────────────────────────────────────────────

export class MaskTool {

  constructor(photoEditor) {
    this.photoEditor = photoEditor;

    this.isActive    = false;
    this.isSuspended = false;
    this._stopping   = false;
    this._suspending = false;

    this.overlayCanvas = null;
    this.overlayCtx    = null;

    /** @type {MaskRegion[]} */
    this.regions  = [];
    this.selected = null;

    this.blockSize = CFG.defaultBlockSize;

    this._drawing   = false;
    this._drawStart = null;
    this._drawRect  = null;
    this._drag      = null;
    this._resize    = null;
    this._panel     = null;

    // Кэшированный canvas исходного изображения (обновляется при смене img)
    this._srcCanvas = null;
    this._srcImg    = null;

    this._onMouseDown  = this._onMouseDown.bind(this);
    this._onMouseMove  = this._onMouseMove.bind(this);
    this._onMouseUp    = this._onMouseUp.bind(this);
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove  = this._onTouchMove.bind(this);
    this._onTouchEnd   = this._onTouchEnd.bind(this);
    this._onKeyDown    = this._onKeyDown.bind(this);
    this._onWinResize  = this._onWinResize.bind(this);
  }


  // ─── Жизненный цикл ───────────────────────────────────────────────────────

  start() {
    if (this.isSuspended) { this._resume(); return; }
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
    this._updateSrcCanvas();
    this._createCanvas();
    this._showCanvas();
    this._createPanel();
    this._bindEvents();
    this._draw();
    this.photoEditor.syncToolButtons?.();
  }

  suspend() {
    if (!this.isActive || this.isSuspended) return;
    this._unbindEvents();
    this.selected  = null;
    this._drawing  = false;
    this._drawRect = null;
    if (this.overlayCanvas) {
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
      this.overlayCanvas.style.pointerEvents = 'none';
    }
    this._suspending = true;
    this.photoEditor.dialogs?.close('mask');
    this._suspending = false;
    this.isActive    = false;
    this.isSuspended = true;
    this.photoEditor.activeTool = null;
    this.photoEditor.syncToolButtons?.();
  }

  cancel() {
    this.regions  = [];
    this.selected = null;
    this._destroyInternal();
  }

  apply() {
    const pe  = this.photoEditor;
    const img = pe.img;
    if (!img || !this.regions.length) { this._destroyInternal(); return; }

    // Исходный canvas для чтения пикселей
    const srcCanvas = imgToCanvas(img);

    const out = document.createElement('canvas');
    out.width  = img.naturalWidth;
    out.height = img.naturalHeight;
    const ctx  = out.getContext('2d');
    ctx.drawImage(img, 0, 0);

    // Масштаб: координаты region в пикселях overlay-canvas → натуральные пиксели img
    const dispW = pe.imgElement?.width || img.naturalWidth;
    const scale = img.naturalWidth / dispW;

    for (const region of this.regions) {
      const rx     = Math.round(region.x * scale);
      const ry     = Math.round(region.y * scale);
      const rw     = Math.max(1, Math.round(region.w * scale));
      const rh     = Math.max(1, Math.round(region.h * scale));
      const blockPx = Math.max(1, Math.round(region.blockSize * scale));
      pixelateRect(ctx, srcCanvas, rx, ry, rw, rh, blockPx, rx, ry, rw, rh);
    }

    // Результат фиксируется только через commitImage (он же обновляет imgElement).
    const url    = out.toDataURL('image/png');
    const newImg = new Image();
    newImg.onload  = () => { pe.commitImage(newImg); };
    newImg.onerror = () => console.error('[MaskTool] apply(): не удалось декодировать результат');
    newImg.src = url;

    this.regions  = [];
    this.selected = null;
    this._destroyInternal();
  }

  openSettings() { this.photoEditor.dialogs?.toggle('mask'); }

  destroy() {
    this.regions     = [];
    this.selected    = null;
    this._srcCanvas  = null;
    this._srcImg     = null;
    this._destroyInternal();
    this.overlayCanvas?.remove();
    this.overlayCanvas = null;
    this.overlayCtx    = null;
  }

  _resume() {
    if (!this.isSuspended) return;
    const imgEl = this.photoEditor.imgElement;
    if (!imgEl?.naturalWidth) return;
    this.isActive    = true;
    this.isSuspended = false;
    this.photoEditor.activeTool = this;
    this._updateSrcCanvas();
    if (this.overlayCanvas) { this.overlayCanvas.style.pointerEvents = ''; }
    else { this._createCanvas(); }
    this._showCanvas();
    if (this._panel) { this.photoEditor.dialogs?.open('mask'); }
    else { this._createPanel(); }
    this._bindEvents();
    this._draw();
    this.photoEditor.syncToolButtons?.();
  }

  _destroyInternal() {
    if (this._stopping) return;
    this._stopping = true;
    this._unbindEvents();
    if (!this.isSuspended && this.overlayCanvas) {
      this.overlayCanvas.remove();
      this.overlayCanvas = null;
      this.overlayCtx    = null;
    }
    const panel = this._panel; this._panel = null;
    if (panel) { this.photoEditor.dialogs?.unregister('mask'); panel.remove(); }
    this.isActive    = false;
    this.isSuspended = false;
    this._stopping   = false;
    this.photoEditor.activeTool = null;
    this.photoEditor.syncToolButtons?.();
  }

  _showCanvas() { if (this.overlayCanvas) this.overlayCanvas.style.pointerEvents = ''; }

  /** Обновляем кэш исходного canvas при смене img */
  _updateSrcCanvas() {
    const img = this.photoEditor.img;
    if (!img || img === this._srcImg) return;
    this._srcImg    = img;
    this._srcCanvas = imgToCanvas(img);
  }


  // ─── Canvas ───────────────────────────────────────────────────────────────

  _createCanvas() {
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

  _syncCanvasSize() {
    const imgEl = this.photoEditor.imgElement;
    if (!imgEl || !this.overlayCanvas) return;
    const newW = imgEl.offsetWidth  || imgEl.width;
    const newH = imgEl.offsetHeight || imgEl.height;
    if (!newW || !newH) return;
    if (this.overlayCanvas.width === newW && this.overlayCanvas.height === newH) return;
    const kx = newW / this.overlayCanvas.width;
    const ky = newH / this.overlayCanvas.height;
    for (const r of this.regions) { r.x *= kx; r.y *= ky; r.w *= kx; r.h *= ky; }
    if (this._drawRect) {
      this._drawRect.x *= kx; this._drawRect.y *= ky;
      this._drawRect.w *= kx; this._drawRect.h *= ky;
    }
    this.overlayCanvas.width  = newW;
    this.overlayCanvas.height = newH;
  }

  /** Масштаб: overlay-canvas px → натуральные пиксели img */
  _scale() {
    const pe = this.photoEditor;
    return (pe.img?.naturalWidth || 1) / (pe.imgElement?.width || pe.img?.naturalWidth || 1);
  }


  // ─── Отрисовка ────────────────────────────────────────────────────────────

  _draw() {
    if (!this.overlayCtx) return;
    this._syncCanvasSize();
    this._updateSrcCanvas();
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

    if (!this._srcCanvas) return;

    const scale = this._scale();

    // Отрисовываем области: выбранная — поверх
    const order = this.selected
      ? [...this.regions.filter(r => r !== this.selected), this.selected]
      : [...this.regions];

    for (const region of order) {
      // Пикселизация: читаем из _srcCanvas (натуральные пиксели), рисуем в overlay coords
      const rx     = Math.round(region.x * scale);
      const ry     = Math.round(region.y * scale);
      const rw     = Math.max(1, Math.round(region.w * scale));
      const rh     = Math.max(1, Math.round(region.h * scale));
      const blockPx = Math.max(1, Math.round(region.blockSize * scale));
      pixelateRect(ctx, this._srcCanvas, rx, ry, rw, rh, blockPx,
                   region.x, region.y, region.w, region.h);
      this._drawRegionBorder(ctx, region, region === this.selected);
    }

    // Рисуемый прямоугольник
    if (this._drawing && this._drawRect) {
      const { x, y, w, h } = this._drawRect;
      ctx.save();
      ctx.strokeStyle = CFG.selectionColor;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(x, y, w, h);
      ctx.setLineDash([]);
      ctx.restore();
    }
  }

  _drawRegionBorder(ctx, region, isSelected) {
    const { x, y, w, h } = region;
    ctx.save();
    if (isSelected) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
      // Угловые ручки
      const corners = [
        { x, y }, { x: x+w, y }, { x: x+w, y: y+h }, { x, y: y+h },
      ];
      ctx.fillStyle = 'rgba(60,143,224,0.95)'; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
      for (const p of corners) {
        ctx.beginPath(); ctx.arc(p.x, p.y, HR, 0, Math.PI*2); ctx.fill(); ctx.stroke();
      }
      // Центральная ручка перемещения — не отображается,
      // рамка и так перетаскивается за любое место внутри
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }
    ctx.restore();
  }


  // ─── Геометрия / hit-test ─────────────────────────────────────────────────

  _hitTest(x, y) {
    const order = this.selected
      ? [...this.regions.filter(r => r !== this.selected), this.selected]
      : [...this.regions];
    for (let i = order.length - 1; i >= 0; i--) {
      const region = order[i];
      if (region === this.selected) {
        const handles = [
          { name: 'topLeft',     x: region.x,           y: region.y           },
          { name: 'topRight',    x: region.x + region.w, y: region.y           },
          { name: 'bottomRight', x: region.x + region.w, y: region.y + region.h },
          { name: 'bottomLeft',  x: region.x,           y: region.y + region.h },
        ];
        for (const h of handles) {
          if (Math.hypot(x - h.x, y - h.y) <= HR + 5)
            return { type: 'resize', handle: h.name, region };
        }
        const cx = region.x + region.w/2, cy2 = region.y + region.h/2;
        if (Math.hypot(x - cx, y - cy2) <= HR + 5) return { type: 'move', region };
      }
      if (region.contains(x, y)) return { type: 'move', region };
    }
    return null;
  }

  _cursorFor(hit) {
    if (!hit) return 'crosshair';
    if (hit.type === 'move') return 'move';
    const map = { topLeft:'nwse-resize', topRight:'nesw-resize', bottomRight:'nwse-resize', bottomLeft:'nesw-resize' };
    return map[hit.handle] || 'nwse-resize';
  }

  _setCursor(cur) { if (this.overlayCanvas) this.overlayCanvas.style.cursor = cur; }


  // ─── Взаимодействие ───────────────────────────────────────────────────────

  _clientToCanvas(cx, cy) {
    const r = this.overlayCanvas.getBoundingClientRect();
    return {
      x: (cx - r.left) * (this.overlayCanvas.width  / r.width),
      y: (cy - r.top)  * (this.overlayCanvas.height / r.height),
    };
  }

  _onMouseDown(e) {
    if (e.button !== 0) return;
    const { x, y } = this._clientToCanvas(e.clientX, e.clientY);
    this._startPointer(x, y);
  }
  _onMouseMove(e) {
    const { x, y } = this._clientToCanvas(e.clientX, e.clientY);
    this._movePointer(x, y);
    if (!this._drag && !this._resize && !this._drawing)
      this._setCursor(this._cursorFor(this._hitTest(x, y)));
  }
  _onMouseUp()   { this._endPointer(); }
  _onTouchStart(e) {
    if (e.touches.length !== 1) return; e.preventDefault();
    const { x, y } = this._clientToCanvas(e.touches[0].clientX, e.touches[0].clientY);
    this._startPointer(x, y);
  }
  _onTouchMove(e) {
    if (!this._drawing && !this._drag && !this._resize) return; e.preventDefault();
    const { x, y } = this._clientToCanvas(e.touches[0].clientX, e.touches[0].clientY);
    this._movePointer(x, y);
  }
  _onTouchEnd()  { this._endPointer(); }
  _onWinResize() { requestAnimationFrame(() => requestAnimationFrame(() => this._draw())); }
  _onKeyDown(e) {
    if (!this.isActive || isEditableTarget(e)) return false;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      this.cancel(); return true;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      e.preventDefault(); e.stopImmediatePropagation();
      this._removeRegion(this.selected); return true;
    }
    return false;
  }


  // ─── Логика ───────────────────────────────────────────────────────────────

  _startPointer(x, y) {
    const hit = this._hitTest(x, y);
    if (hit) {
      const { type, region } = hit;
      if (this.selected !== region) {
        this.selected = region;
        this._draw(); this._syncPanel();
        this._scrollRegionListToSelected(); this._updateRegionListActive();
      }
      this._setCursor(this._cursorFor(hit));
      if (type === 'move') {
        this._drag = { startX: x, startY: y, origX: region.x, origY: region.y };
      } else if (type === 'resize') {
        const { handle } = hit;
        this._resize = {
          handle,
          anchorX: (handle === 'topLeft' || handle === 'bottomLeft')  ? region.x + region.w : region.x,
          anchorY: (handle === 'topLeft' || handle === 'topRight')     ? region.y + region.h : region.y,
        };
      }
      return;
    }
    this.selected  = null;
    this._drawing  = true;
    this._drawStart = { x, y };
    this._drawRect  = { x, y, w: 0, h: 0 };
    this._syncPanel(); this._updateRegionListActive();
    this._setCursor('crosshair');
    this._draw();
  }

  _movePointer(x, y) {
    if (this._drag) {
      const r = this.selected;
      r.x = Math.max(0, Math.min(this._drag.origX + (x - this._drag.startX), this.overlayCanvas.width  - r.w));
      r.y = Math.max(0, Math.min(this._drag.origY + (y - this._drag.startY), this.overlayCanvas.height - r.h));
      this._setCursor('move'); this._draw(); this._syncPanel();
      return;
    }
    if (this._resize) {
      const region = this.selected, rv = this._resize;
      const { handle } = rv;
      const newW = Math.max(MIN, Math.abs(x - rv.anchorX));
      const newH = Math.max(MIN, Math.abs(y - rv.anchorY));
      region.w = newW; region.h = newH;
      region.x = (handle === 'topLeft' || handle === 'bottomLeft') ? rv.anchorX - newW : rv.anchorX;
      region.y = (handle === 'topLeft' || handle === 'topRight')   ? rv.anchorY - newH : rv.anchorY;
      const cmap = { topLeft:'nwse-resize', topRight:'nesw-resize', bottomRight:'nwse-resize', bottomLeft:'nesw-resize' };
      this._setCursor(cmap[handle] || 'nwse-resize');
      this._draw(); this._syncPanel();
      return;
    }
    if (this._drawing && this._drawStart) {
      const sx = this._drawStart.x, sy = this._drawStart.y;
      this._drawRect = { x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x-sx), h: Math.abs(y-sy) };
      this._draw();
    }
  }

  _endPointer() {
    if (this._drag)   { this._drag   = null; this._setCursor('default'); this._renderRegionList(); return; }
    if (this._resize) { this._resize = null; this._setCursor('default'); this._renderRegionList(); return; }
    if (!this._drawing) return;
    this._drawing = false;
    const rect = this._drawRect; this._drawRect = null; this._drawStart = null;
    if (!rect || rect.w < MIN || rect.h < MIN) { this._draw(); return; }
    const region = new MaskRegion({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, blockSize: this.blockSize });
    this.regions.push(region);
    this.selected = region;
    this._draw(); this._syncPanel(); this._renderRegionList();
    this._setCursor('default');
  }

  _removeRegion(region) {
    this.regions = this.regions.filter(r => r !== region);
    if (this.selected === region) this.selected = this.regions.at(-1) ?? null;
    this._draw(); this._syncPanel(); this._renderRegionList();
  }

  _selectRegion(region) {
    if (this.selected === region) return;
    this.selected = region;
    this._draw(); this._syncPanel();
    this._scrollRegionListToSelected(); this._updateRegionListActive();
  }


  // ─── События ──────────────────────────────────────────────────────────────

  _bindEvents() {
    const c = this.overlayCanvas;
    c.addEventListener('mousedown',  this._onMouseDown);
    c.addEventListener('touchstart', this._onTouchStart, { passive: false });
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup',   this._onMouseUp);
    document.addEventListener('touchmove', this._onTouchMove, { passive: false });
    document.addEventListener('touchend',  this._onTouchEnd);
    window.addEventListener('resize',      this._onWinResize);
    document.addEventListener('keydown',   this._onKeyDown, { capture: true });
  }

  _unbindEvents() {
    if (!this.overlayCanvas) return;
    const c = this.overlayCanvas;
    c.removeEventListener('mousedown',  this._onMouseDown);
    c.removeEventListener('touchstart', this._onTouchStart);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup',   this._onMouseUp);
    document.removeEventListener('touchmove', this._onTouchMove);
    document.removeEventListener('touchend',  this._onTouchEnd);
    window.removeEventListener('resize',      this._onWinResize);
    document.removeEventListener('keydown',   this._onKeyDown, { capture: true });
  }


  // ─── Панель ───────────────────────────────────────────────────────────────

  _createPanel() {
    if (this._panel) return;
    const panel = document.createElement('div');
    panel.className = 'pe-panel pe-panel--mask';
    panel.innerHTML = `
      <div class="pe-panel__header">
        <span class="pe-panel__title">Маскирование</span>
        <div class="pe-panel__header-actions">
          <button type="button" class="photoeditor__button photoeditor__button--compact mask-panel__btn-cancel"
                  title="Отмена"><i class="icon-close" aria-hidden="true"></i> Отмена</button>
          <button type="button" class="photoeditor__button photoeditor__button--compact photoeditor__button--success mask-panel__btn-apply"
                  title="Применить"><i class="icon-checkmark" aria-hidden="true"></i> Применить</button>
        </div>
      </div>
      <div class="mask-panel__row mask-panel__row--settings">
        <label class="mask-panel__lbl" title="Размер квадратика пикселизации">
          <span class="mask-panel__lbl-text">Блок</span>
          <input type="range" class="mask-panel__block-size"
                 min="${CFG.minBlockSize}" max="${CFG.maxBlockSize}" value="${this.blockSize}">
          <span class="mask-panel__val-block">${this.blockSize}</span>px
        </label>
        <button type="button"
                class="photoeditor__button photoeditor__button--compact photoeditor__button--danger mask-panel__btn-del"
                style="display:none" title="Удалить выделенную область">
          <i class="icon-bin" aria-hidden="true"></i>
        </button>
      </div>
      <div class="mask-panel__regions-wrap" style="display:none">
        <div class="mask-panel__regions-label">Области</div>
        <div class="mask-panel__regions-list"></div>
      </div>
      <div class="mask-panel__hint">
        Нарисуйте прямоугольник на изображении · угловые ручки — resize
      </div>`;

    const bsEl  = panel.querySelector('.mask-panel__block-size');
    const bsVal = panel.querySelector('.mask-panel__val-block');
    bsEl.addEventListener('input', () => {
      this.blockSize = Number(bsEl.value); bsVal.textContent = bsEl.value;
      if (this.selected) { this.selected.blockSize = this.blockSize; this._draw(); }
    });
    panel.querySelector('.mask-panel__btn-del').addEventListener('click', () => {
      if (this.selected) this._removeRegion(this.selected);
    });
    panel.querySelector('.mask-panel__btn-cancel').addEventListener('click', () => this.cancel());
    panel.querySelector('.mask-panel__btn-apply').addEventListener('click',  () => this.apply());

    this.photoEditor.container.appendChild(panel);
    this._panel = panel;
    this.photoEditor.dialogs?.register('mask', panel, {
      group:   'tool',
      onClose: () => { if (this.isActive && !this._stopping && !this._suspending) this.suspend(); },
    });
    this.photoEditor.dialogs?.open('mask');
  }

  _syncPanel() {
    if (!this._panel) return;
    const delBtn = this._panel.querySelector('.mask-panel__btn-del');
    if (!this.selected) { if (delBtn) delBtn.style.display = 'none'; return; }
    if (delBtn) delBtn.style.display = '';
    const bsEl  = this._panel.querySelector('.mask-panel__block-size');
    const bsVal = this._panel.querySelector('.mask-panel__val-block');
    bsEl.value = this.selected.blockSize; bsVal.textContent = this.selected.blockSize;
    this.blockSize = this.selected.blockSize;
  }

  _renderRegionList() {
    if (!this._panel) return;
    const wrap = this._panel.querySelector('.mask-panel__regions-wrap');
    const list = this._panel.querySelector('.mask-panel__regions-list');
    if (!list) return;
    if (this.regions.length === 0) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    list.innerHTML = '';
    const scale = this._scale();
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const region   = this.regions[i];
      const isActive = region === this.selected;
      const card = document.createElement('div');
      card.className    = 'draw-sketch-card' + (isActive ? ' is-active' : '');
      card.title        = `Область #${region.id} · ${region.blockSize}px`;
      card.dataset.rgId = region.id;
      let thumbSrc = '';
      try {
        if (this._srcCanvas) thumbSrc = regionThumb(this._srcCanvas, region, scale, 48);
      } catch {}
      card.innerHTML = `
        <button type="button" class="draw-sketch-card__del" title="Удалить">
          <i class="icon-close" aria-hidden="true"></i>
        </button>
        ${thumbSrc
          ? `<img class="draw-sketch-card__thumb" src="${thumbSrc}" alt="" draggable="false">`
          : `<div class="draw-sketch-card__thumb draw-sketch-card__thumb--empty"></div>`}
        <div class="draw-sketch-card__color" style="background:rgba(60,143,224,0.7)"></div>`;
      card.querySelector('.draw-sketch-card__del').addEventListener('click', (e) => {
        e.stopPropagation(); this._removeRegion(region);
      });
      card.addEventListener('click', () => this._selectRegion(region));
      list.appendChild(card);
    }
    this._scrollRegionListToSelected();
  }

  _updateRegionListActive() {
    if (!this._panel) return;
    this._panel.querySelectorAll('.draw-sketch-card').forEach(card => {
      const region = this.regions.find(r => r.id === Number(card.dataset.rgId));
      card.classList.toggle('is-active', region === this.selected);
    });
  }

  _scrollRegionListToSelected() {
    if (!this._panel || !this.selected) return;
    const list = this._panel.querySelector('.mask-panel__regions-list');
    if (!list) return;
    const card = list.querySelector(`.draw-sketch-card[data-rg-id="${this.selected.id}"]`);
    if (!card) return;
    list.scrollTo({ left: Math.max(0, card.offsetLeft - (list.clientWidth - card.offsetWidth)/2), behavior: 'smooth' });
  }
}
