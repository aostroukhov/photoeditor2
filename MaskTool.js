/**
 * MaskTool — пикселизация прямоугольных областей.
 *
 * Пользователь рисует прямоугольники на overlay-canvas; каждый — MaskRegion
 * с собственным размером блока. Превью рисуется на overlay из натуральных
 * пикселей исходника (кэшируется по области — пересчёт только когда область
 * или блок изменились). «Применить» пикселизирует области в натуральном
 * разрешении.
 *
 * Жизненный цикл, canvas, указатель, панель и клавиатура — в ToolBase.
 */

import { EditorConfig }  from './EditorConfig.js';
import { ToolBase }      from './ToolBase.js';
import { imageToCanvas } from './canvasUtils.js';
import { CardList }      from './CardList.js';

const CFG = EditorConfig.mask;
const HR  = 8;      // радиус ручки
const MIN = 10;     // минимальный размер области (логические px)


// ─── Модель области ───────────────────────────────────────────────────────────

let nextRegionId = 1;

export class MaskRegion {
  constructor({ x = 0, y = 0, w = 100, h = 80, blockSize = CFG.defaultBlockSize } = {}) {
    this.id        = nextRegionId++;
    this.x = x; this.y = y; this.w = w; this.h = h;
    this.blockSize = blockSize;
    /** Кэш пикселизации для превью: { key, canvas } */
    this._cache = null;
  }
  get right()  { return this.x + this.w; }
  get bottom() { return this.y + this.h; }
  contains(px, py) {
    return px >= this.x && px <= this.right && py >= this.y && py <= this.bottom;
  }
}


// ─── Пикселизация ─────────────────────────────────────────────────────────────

/**
 * Пикселизирует область srcCanvas (rx, ry, rw, rh) и рисует результат в outCtx
 * в прямоугольник (outX, outY, outW, outH). blockPx — размер блока в пикселях src.
 */
export function pixelateRect(outCtx, srcCanvas, rx, ry, rw, rh, blockPx, outX, outY, outW, outH) {
  if (rw < 1 || rh < 1) return;
  let imgData;
  try {
    imgData = srcCanvas.getContext('2d').getImageData(rx, ry, rw, rh);
  } catch (e) {
    console.warn('[MaskTool] getImageData failed:', e.message);   // tainted canvas
    return;
  }
  const data = imgData.data;
  const kx = outW / rw, ky = outH / rh;

  for (let by = 0; by < rh; by += blockPx) {
    for (let bx = 0; bx < rw; bx += blockPx) {
      const bw = Math.min(blockPx, rw - bx);
      const bh = Math.min(blockPx, rh - by);
      let r = 0, g = 0, b = 0, count = 0;
      for (let py = by; py < by + bh; py++) {
        let i = (py * rw + bx) * 4;
        for (let px = 0; px < bw; px++, i += 4) { r += data[i]; g += data[i + 1]; b += data[i + 2]; count++; }
      }
      if (!count) continue;
      outCtx.fillStyle = `rgb(${(r / count) | 0},${(g / count) | 0},${(b / count) | 0})`;
      outCtx.fillRect(outX + bx * kx, outY + by * ky, bw * kx + 0.5, bh * ky + 0.5);
    }
  }
}

/** Миниатюра области для карточки (dataURL небольшого canvas). */
function regionThumb(srcCanvas, region, scale, size = 48) {
  const rx = Math.round(region.x * scale), ry = Math.round(region.y * scale);
  const rw = Math.max(1, Math.round(region.w * scale));
  const rh = Math.max(1, Math.round(region.h * scale));

  const cv  = document.createElement('canvas');
  cv.width  = size; cv.height = size;
  const ctx = cv.getContext('2d');
  const fit = Math.min(size / rw, size / rh) * 0.9;
  const dw  = rw * fit, dh = rh * fit;
  const ox  = (size - dw) / 2, oy = (size - dh) / 2;
  ctx.drawImage(srcCanvas, rx, ry, rw, rh, ox, oy, dw, dh);
  pixelateRect(ctx, srcCanvas, rx, ry, rw, rh, Math.max(1, Math.round(region.blockSize * scale)), ox, oy, dw, dh);
  return cv.toDataURL('image/png');
}

const CURSORS = { topLeft: 'nwse-resize', topRight: 'nesw-resize', bottomRight: 'nwse-resize', bottomLeft: 'nesw-resize' };


// ─── MaskTool ─────────────────────────────────────────────────────────────────

export class MaskTool extends ToolBase {

  /** @type {MaskRegion[]} */
  regions   = [];
  selected  = null;
  blockSize = CFG.defaultBlockSize;

  _drawing   = false;
  _drawStart = null;
  _drawRect  = null;
  _drag      = null;
  _resize    = null;

  _srcCanvas = null;   // кэш натуральных пикселей текущего pe.img
  _srcImg    = null;
  _cards     = null;   // CardList

  constructor(photoEditor) {
    super(photoEditor, { id: 'mask', cursor: 'crosshair' });
  }


  // ─── Хуки жизненного цикла ────────────────────────────────────────────────

  onStart()  { this._updateSrcCanvas(); }
  onResume() { this._updateSrcCanvas(); }

  onSuspend() {
    this.selected = null;
    this._drawing = false; this._drawRect = null; this._drag = null; this._resize = null;
  }

  onCancel()  { this._reset(); }
  onDestroy() { this._reset(); }

  onApply() {
    const img = this.pe.img;
    if (!img || !this.regions.length) { this._reset(); return null; }

    this._updateSrcCanvas();
    const src = this._srcCanvas;
    const out = document.createElement('canvas');
    out.width  = img.naturalWidth;
    out.height = img.naturalHeight;
    const ctx  = out.getContext('2d');
    ctx.drawImage(img, 0, 0);

    const k = this.naturalScale;
    for (const region of this.regions) {
      const rx = Math.round(region.x * k), ry = Math.round(region.y * k);
      const rw = Math.max(1, Math.round(region.w * k)), rh = Math.max(1, Math.round(region.h * k));
      const blockPx = Math.max(1, Math.round(region.blockSize * k));
      pixelateRect(ctx, src, rx, ry, rw, rh, blockPx, rx, ry, rw, rh);
    }

    this._reset();
    return out;
  }

  onViewResize(kx, ky) {
    for (const r of this.regions) { r.x *= kx; r.y *= ky; r.w *= kx; r.h *= ky; r._cache = null; }
    if (this._drawRect) { this._drawRect.x *= kx; this._drawRect.y *= ky; this._drawRect.w *= kx; this._drawRect.h *= ky; }
  }

  onDraw(ctx) {
    this._updateSrcCanvas();
    if (!this._srcCanvas) return;
    const k = this.naturalScale;

    const order = this.selected
      ? [...this.regions.filter(r => r !== this.selected), this.selected]
      : this.regions;

    for (const region of order) {
      this._drawPixelated(ctx, region, k);
      this._drawRegionBorder(ctx, region, region === this.selected);
    }

    if (this._drawing && this._drawRect) {
      const { x, y, w, h } = this._drawRect;
      ctx.save();
      ctx.strokeStyle = CFG.selectionColor;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x, y, w, h);
      ctx.fillStyle = 'rgba(255,255,255,0.07)';
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }
  }

  /**
   * Пикселизированное превью области. Результат кэшируется в region._cache и
   * пересчитывается только при изменении геометрии/блока/масштаба — раньше
   * getImageData + пиксельный цикл выполнялись для каждой области на каждый
   * mousemove.
   */
  _drawPixelated(ctx, region, k) {
    const rx = Math.round(region.x * k), ry = Math.round(region.y * k);
    const rw = Math.max(1, Math.round(region.w * k)), rh = Math.max(1, Math.round(region.h * k));
    const blockPx = Math.max(1, Math.round(region.blockSize * k));
    const outW = Math.max(1, Math.round(region.w * this._dpr)), outH = Math.max(1, Math.round(region.h * this._dpr));
    const key = `${rx},${ry},${rw},${rh},${blockPx},${outW},${outH},${this._srcImg?.src}`;

    if (!region._cache || region._cache.key !== key) {
      const cv = document.createElement('canvas');
      cv.width = outW; cv.height = outH;
      pixelateRect(cv.getContext('2d'), this._srcCanvas, rx, ry, rw, rh, blockPx, 0, 0, outW, outH);
      region._cache = { key, canvas: cv };
    }
    ctx.drawImage(region._cache.canvas, region.x, region.y, region.w, region.h);
  }

  _drawRegionBorder(ctx, region, isSelected) {
    const { x, y, w, h } = region;
    ctx.save();
    if (isSelected) {
      ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 3]); ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
      ctx.fillStyle = CFG.selectionColor; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
      for (const p of this._corners(region)) {
        ctx.beginPath(); ctx.arc(p.x, p.y, HR, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      }
    } else {
      ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }
    ctx.restore();
  }

  _corners(r) {
    return [
      { name: 'topLeft',     x: r.x,       y: r.y },
      { name: 'topRight',    x: r.x + r.w, y: r.y },
      { name: 'bottomRight', x: r.x + r.w, y: r.y + r.h },
      { name: 'bottomLeft',  x: r.x,       y: r.y + r.h },
    ];
  }


  // ─── Hit-test ─────────────────────────────────────────────────────────────

  _hitTest(x, y) {
    if (this.selected) {
      for (const c of this._corners(this.selected)) {
        if (Math.hypot(x - c.x, y - c.y) <= HR + 5) return { type: 'resize', handle: c.name, region: this.selected };
      }
      if (this.selected.contains(x, y)) return { type: 'move', region: this.selected };
    }
    for (let i = this.regions.length - 1; i >= 0; i--) {
      const region = this.regions[i];
      if (region.contains(x, y)) return { type: 'move', region };
    }
    return null;
  }

  _cursorFor(hit) {
    if (!hit) return 'crosshair';
    if (hit.type === 'move') return 'move';
    return CURSORS[hit.handle] || 'nwse-resize';
  }

  _setCursor(cur) { if (this.overlayCanvas) this.overlayCanvas.style.cursor = cur; }


  // ─── Указатель ────────────────────────────────────────────────────────────

  onHover(pt) { this._setCursor(this._cursorFor(this._hitTest(pt.x, pt.y))); }

  onPointerDown(pt) {
    const { x, y } = pt;
    const hit = this._hitTest(x, y);
    if (hit) {
      const { type, region } = hit;
      if (this.selected !== region) this._selectRegion(region);
      this._setCursor(this._cursorFor(hit));
      if (type === 'move') {
        this._drag = { startX: x, startY: y, origX: region.x, origY: region.y };
      } else {
        const { handle } = hit;
        this._resize = {
          handle,
          anchorX: (handle === 'topLeft' || handle === 'bottomLeft') ? region.x + region.w : region.x,
          anchorY: (handle === 'topLeft' || handle === 'topRight')   ? region.y + region.h : region.y,
        };
      }
      return;
    }
    this.selected   = null;
    this._drawing   = true;
    this._drawStart = { x, y };
    this._drawRect  = { x, y, w: 0, h: 0 };
    this._syncPanel(); this._updateRegionListActive();
    this._setCursor('crosshair');
    this.requestDraw();
  }

  onPointerMove(pt) {
    const { x, y } = pt;
    if (this._drag && this.selected) {
      const r = this.selected;
      r.x = Math.max(0, Math.min(this._drag.origX + (x - this._drag.startX), this.viewW - r.w));
      r.y = Math.max(0, Math.min(this._drag.origY + (y - this._drag.startY), this.viewH - r.h));
      this.requestDraw();
      return;
    }
    if (this._resize && this.selected) {
      const region = this.selected, rv = this._resize, { handle } = rv;
      const newW = Math.max(MIN, Math.abs(x - rv.anchorX));
      const newH = Math.max(MIN, Math.abs(y - rv.anchorY));
      region.w = newW; region.h = newH;
      region.x = (handle === 'topLeft' || handle === 'bottomLeft') ? rv.anchorX - newW : rv.anchorX;
      region.y = (handle === 'topLeft' || handle === 'topRight')   ? rv.anchorY - newH : rv.anchorY;
      this.requestDraw();
      return;
    }
    if (this._drawing && this._drawStart) {
      const sx = this._drawStart.x, sy = this._drawStart.y;
      this._drawRect = { x: Math.min(sx, x), y: Math.min(sy, y), w: Math.abs(x - sx), h: Math.abs(y - sy) };
      this.requestDraw();
    }
  }

  onPointerUp() {
    if (this._drag)   { this._drag   = null; this._setCursor('move'); this._renderRegionList(); return; }
    if (this._resize) { this._resize = null; this._setCursor('default'); this._renderRegionList(); return; }
    if (!this._drawing) return;
    this._drawing = false;
    const rect = this._drawRect; this._drawRect = null; this._drawStart = null;
    if (!rect || rect.w < MIN || rect.h < MIN) { this.requestDraw(); return; }
    const region = new MaskRegion({ x: rect.x, y: rect.y, w: rect.w, h: rect.h, blockSize: this.blockSize });
    this.regions.push(region);
    this.selected = region;
    this._syncPanel(); this._renderRegionList();
    this.requestDraw();
  }

  onPointerCancel() {
    this._drag = null; this._resize = null;
    this._drawing = false; this._drawRect = null; this._drawStart = null;
    this.requestDraw();
  }


  // ─── Клавиатура ───────────────────────────────────────────────────────────

  onKey(e) {
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) {
      this._removeRegion(this.selected); return true;
    }
    return false;
  }


  // ─── Логика ───────────────────────────────────────────────────────────────

  _updateSrcCanvas() {
    const img = this.pe.img;
    if (!img) { this._srcCanvas = null; this._srcImg = null; return; }
    if (img === this._srcImg) return;
    this._srcImg    = img;
    this._srcCanvas = imageToCanvas(img);
    for (const r of this.regions) r._cache = null;
  }

  _removeRegion(region) {
    this.regions = this.regions.filter(r => r !== region);
    if (this.selected === region) this.selected = this.regions.at(-1) ?? null;
    this._syncPanel(); this._renderRegionList();
    this.requestDraw();
  }

  _selectRegion(region) {
    if (this.selected === region) return;
    this.selected = region;
    this._syncPanel(); this._updateRegionListActive();
    this.requestDraw();
  }

  _reset() {
    this.regions = []; this.selected = null;
    this._drawing = false; this._drawRect = null; this._drawStart = null;
    this._drag = null; this._resize = null;
    this._srcCanvas = null; this._srcImg = null;
    this._cards = null;
  }


  // ─── Панель ───────────────────────────────────────────────────────────────

  buildPanel() {
    const panel = document.createElement('div');
    panel.innerHTML = `
      ${ToolBase.panelHeader({ title: 'Маскирование', prefix: 'mask-panel' })}
      <div class="mask-panel__row mask-panel__row--settings">
        <label class="mask-panel__lbl" title="Размер квадратика пикселизации">
          <span class="mask-panel__lbl-text">Блок</span>
          <input type="range" class="mask-panel__block-size"
                 min="${CFG.minBlockSize}" max="${CFG.maxBlockSize}" value="${this.blockSize}">
          <span class="mask-panel__val-block">${this.blockSize}</span>px
        </label>
        <button type="button"
                class="photoeditor__button photoeditor__button--compact photoeditor__button--danger mask-panel__btn-del"
                style="display:none" title="Удалить выделенную область (Delete)" aria-label="Удалить выделенную область">
          <i class="icon-bin" aria-hidden="true"></i>
        </button>
      </div>
      <div class="mask-panel__regions-wrap" style="display:none">
        <div class="mask-panel__regions-label">Области</div>
        <div class="mask-panel__regions-list"></div>
      </div>
      <div class="mask-panel__hint">
        Нарисуйте прямоугольник на изображении · угловые ручки меняют размер
      </div>`;

    const bsEl  = panel.querySelector('.mask-panel__block-size');
    const bsVal = panel.querySelector('.mask-panel__val-block');
    bsEl.addEventListener('input', () => {
      this.blockSize = Number(bsEl.value); bsVal.textContent = bsEl.value;
      if (this.selected) { this.selected.blockSize = this.blockSize; this.requestDraw(); }
    });
    panel.querySelector('.mask-panel__btn-del').addEventListener('click', () => {
      if (this.selected) this._removeRegion(this.selected);
    });

    this._cards = new CardList(panel.querySelector('.mask-panel__regions-list'), {
      getId:    (r) => r.id,
      render:   (r) => {
        let thumbSrc = '';
        try { if (this._srcCanvas) thumbSrc = regionThumb(this._srcCanvas, r, this.naturalScale); } catch { /* tainted */ }
        return { thumbSrc, color: CFG.selectionColor, title: `Область #${r.id} · блок ${r.blockSize}px` };
      },
      onSelect: (r) => this._selectRegion(r),
      onDelete: (r) => this._removeRegion(r),
      ariaLabel: 'Области пикселизации',
    });
    return panel;
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
    if (!this._panel || !this._cards) return;
    const wrap = this._panel.querySelector('.mask-panel__regions-wrap');
    if (!this.regions.length) { wrap.style.display = 'none'; this._cards.clear(); return; }
    wrap.style.display = '';
    this._cards.render(this.regions, this.selected);
  }

  _updateRegionListActive() { this._cards?.setActive(this.selected); }
}
