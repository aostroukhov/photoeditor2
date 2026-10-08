/**
 * CropTool — кадрирование с поворотом рамки и поворотом изображения на 90°.
 *
 * Рамка (cropArea) хранится в логических координатах overlay; между
 * suspend/resume и при ресайзе — в натуральных (naturalCropArea). Поддерживает
 * фиксированные пропорции (кнопки панели или opts.cropOptions.aspectRatio),
 * перетаскивание, resize за углы и стороны с якорем на противоположной
 * стороне, вращение рамки за ручку, стрелки (Shift ×10), Enter — применить,
 * двойной клик — на всё изображение.
 *
 * Жизненный цикл, canvas, указатель, панель и клавиатура — в ToolBase.
 */

import { EditorConfig } from './EditorConfig.js';
import { ToolBase }     from './ToolBase.js';
import { escapeHtml }   from './utils.js';

const CFG = EditorConfig.crop;

const HANDLE_CURSORS = {
  topLeft: 'nwse-resize', bottomRight: 'nwse-resize',
  topRight: 'nesw-resize', bottomLeft: 'nesw-resize',
  top: 'ns-resize', bottom: 'ns-resize', left: 'ew-resize', right: 'ew-resize',
};

/** Локальные координаты якоря (противоположного угла/стороны) для ручки при размерах w×h. */
function anchorLocal(handle, w, h) {
  return {
    topLeft:     { lx: +w / 2, ly: +h / 2 },
    topRight:    { lx: -w / 2, ly: +h / 2 },
    bottomLeft:  { lx: +w / 2, ly: -h / 2 },
    bottomRight: { lx: -w / 2, ly: -h / 2 },
    top:         { lx: 0,      ly: +h / 2 },
    bottom:      { lx: 0,      ly: -h / 2 },
    left:        { lx: +w / 2, ly: 0 },
    right:       { lx: -w / 2, ly: 0 },
  }[handle];
}


export class CropTool extends ToolBase {

  /** Цвет рамки кадрирования. */
  cropColor        = CFG.cropColor;
  /** Размер ручек масштабирования (логические px). */
  resizeHandleSize = CFG.resizeHandleSize;
  /** Текущее соотношение сторон (null = свободное). */
  aspectRatio      = null;
  /** true — соотношение сторон зафиксировано. */
  fixedAspect      = false;
  /** true — показывать крестики золотого сечения внутри рамки. */
  showGoldenRatio  = CFG.showGoldenRatio;

  /** Текущая область кадрирования в логических px overlay ({x, y, width, height}) или null. */
  cropArea         = null;
  /** Область в натуральных пикселях (переживает suspend/resume и ресайз). */
  naturalCropArea  = null;
  /** Угол поворота рамки в радианах. */
  cropRotation     = 0;

  _externalAspect   = false;   // пропорции заданы извне → кнопки не показываем
  _drag             = null;    // { x, y, cx, cy }
  _resizeHandle     = null;    // имя активной ручки
  _resizeAnchor     = null;    // мировые координаты якоря
  _rotating         = false;
  _rotateStartAngle = 0;
  _rotatingImage    = false;   // идёт поворот изображения (commitCanvas)
  _pendingRotation  = 0;       // накопленный угол кликов, пришедших во время поворота

  constructor(photoEditor) {
    super(photoEditor, { id: 'crop' });
  }


  // ─── Публичная настройка ──────────────────────────────────────────────────

  /** Фиксирует соотношение сторон ('16:9'); кнопки выбора пропорций скрываются. */
  setAspectRatio(ratio) {
    const [w, h] = String(ratio).split(':').map(Number);
    if (!w || !h) return;
    this.aspectRatio = w / h;
    this.fixedAspect = true;
    this._externalAspect = true;
  }

  /** Сбрасывает фиксацию пропорций. */
  resetAspectRatio() {
    this.aspectRatio = null;
    this.fixedAspect = false;
    this._externalAspect = false;
  }

  /** Перерисовать рамку (совместимость с внешним API). */
  drawCropArea() { this.requestDraw(); }

  /** Применить кадрирование (псевдоним apply()). */
  crop() { this.apply(); }


  // ─── Хуки жизненного цикла ────────────────────────────────────────────────

  onStart() {
    this._restoreOrDefaultArea();
    this._resetInteraction();
    this._bindDblClick();
  }

  onResume() {
    this._restoreOrDefaultArea();
    this._resetInteraction();
    this._bindDblClick();
  }

  onSuspend() {
    this._saveCropArea();
    this._resetInteraction();
  }

  onCancel()  { this.cropRotation = 0; this.cropArea = null; this._pendingRotation = 0; this._resetInteraction(); }
  onDestroy() { this.cropRotation = 0; this.cropArea = null; this.naturalCropArea = null; this._resetInteraction(); }

  onApply() {
    const img = this.pe.img;
    this._saveCropArea();
    const na = this.naturalCropArea;
    if (!img || !na) return null;

    const rot = this.cropRotation;
    const nw  = Math.max(1, Math.round(na.width)), nh = Math.max(1, Math.round(na.height));
    const out = document.createElement('canvas');
    out.width = nw; out.height = nh;
    const ctx = out.getContext('2d');

    if (Math.abs(rot) < 0.001) {
      ctx.drawImage(img, na.x, na.y, na.width, na.height, 0, 0, nw, nh);
    } else {
      // С поворотом: рисуем изображение с обратным поворотом вокруг центра рамки
      ctx.save();
      ctx.translate(nw / 2, nh / 2);
      ctx.rotate(-rot);
      ctx.drawImage(img, -(na.x + na.width / 2), -(na.y + na.height / 2), img.naturalWidth, img.naturalHeight);
      ctx.restore();
    }

    this.naturalCropArea = null;
    this.cropArea        = null;
    this.cropRotation    = 0;
    return out;
  }

  onViewResize(kx, ky) {
    if (!this.cropArea) return;
    this.cropArea = {
      x: this.cropArea.x * kx, y: this.cropArea.y * ky,
      width: this.cropArea.width * kx, height: this.cropArea.height * ky,
    };
    this.adjustCropToAspectRatio();
  }

  onDraw(ctx) {
    if (!this.cropArea) this._restoreOrDefaultArea();
    const ca = this.cropArea;
    if (!ca) return;
    const { x, y, width, height } = ca;
    const cx = x + width / 2, cy = y + height / 2, rot = this.cropRotation;
    const W = this.viewW, H = this.viewH;

    // Затемнение вне рамки
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.translate(cx, cy); ctx.rotate(rot);
    ctx.fillStyle = '#000';
    ctx.fillRect(-width / 2, -height / 2, width, height);
    ctx.restore();

    // Рамка, сетка, ручки
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(rot);
    ctx.strokeStyle = this.cropColor;
    ctx.lineWidth   = 1;
    ctx.strokeRect(-width / 2, -height / 2, width, height);

    if (this.showGoldenRatio) {
      const cs = Math.max(4, Math.min(width, height) / 50);
      ctx.beginPath();
      for (const [fx, fy] of [[0.382, 0.382], [0.382, 0.618], [0.618, 0.382], [0.618, 0.618]]) {
        const px = -width / 2 + width * fx, py = -height / 2 + height * fy;
        ctx.moveTo(px - cs, py); ctx.lineTo(px + cs, py);
        ctx.moveTo(px, py - cs); ctx.lineTo(px, py + cs);
      }
      ctx.stroke();
    }

    // Угловые ручки-уголки
    const s = this.resizeHandleSize, hw = width / 2, hh = height / 2;
    ctx.lineWidth = 2.5; ctx.lineCap = 'square';
    for (const [ax, ay, hd, vd] of [[-hw, -hh, 1, 1], [hw, -hh, -1, 1], [-hw, hh, 1, -1], [hw, hh, -1, -1]]) {
      ctx.beginPath();
      ctx.moveTo(ax + hd * s, ay); ctx.lineTo(ax, ay); ctx.lineTo(ax, ay + vd * s);
      ctx.stroke();
    }

    // Ручка вращения
    const rotY = -hh - CFG.rotateHandleOffset;
    ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(0, -hh); ctx.lineTo(0, rotY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, rotY, s * 0.75, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }


  // ─── Область ──────────────────────────────────────────────────────────────

  _restoreOrDefaultArea() {
    const W = this.viewW, H = this.viewH;
    if (!W || !H) return;
    if (this.naturalCropArea) {
      const k = W / (this.pe.img?.naturalWidth || W);
      const n = this.naturalCropArea;
      this.cropArea = { x: n.x * k, y: n.y * k, width: n.width * k, height: n.height * k };
    } else if (!this.cropArea) {
      this.cropArea = { x: W / 6, y: H / 6, width: W / 6 * 4, height: H / 6 * 4 };
    }
    this.adjustCropToAspectRatio();
    this._clampArea();
  }

  /** cropArea (логические px) → naturalCropArea. */
  _saveCropArea() {
    if (!this.cropArea || !this.viewW) return;
    const k = this.naturalScale;
    const c = this.cropArea;
    this.naturalCropArea = { x: c.x * k, y: c.y * k, width: c.width * k, height: c.height * k };
  }

  /** Корректирует cropArea под фиксированное соотношение сторон (сохраняя центр). */
  adjustCropToAspectRatio() {
    const ca = this.cropArea;
    if (!this.fixedAspect || !ca) return;
    const cx = ca.x + ca.width / 2, cy = ca.y + ca.height / 2;
    if (Math.abs(this.aspectRatio - ca.width / ca.height) > 0.01) {
      const nw = ca.height * this.aspectRatio;
      if (ca.width > nw) ca.width = nw; else ca.height = ca.width / this.aspectRatio;
    }
    ca.x = cx - ca.width / 2;
    ca.y = cy - ca.height / 2;
  }

  /**
   * Держит неповёрнутую рамку внутри изображения: иначе результат получал
   * прозрачные поля. Для повёрнутой рамки — только центр внутри.
   */
  _clampArea() {
    const ca = this.cropArea, W = this.viewW, H = this.viewH;
    if (!ca || !W || !H) return;
    if (Math.abs(this.cropRotation) < 0.001) {
      if (ca.width  > W) { ca.width  = W; if (this.fixedAspect) ca.height = W / this.aspectRatio; }
      if (ca.height > H) { ca.height = H; if (this.fixedAspect) ca.width  = H * this.aspectRatio; }
      ca.x = Math.max(0, Math.min(W - ca.width,  ca.x));
      ca.y = Math.max(0, Math.min(H - ca.height, ca.y));
    } else {
      ca.x = Math.max(-ca.width / 2,  Math.min(W - ca.width / 2,  ca.x));
      ca.y = Math.max(-ca.height / 2, Math.min(H - ca.height / 2, ca.y));
    }
  }

  /** Растягивает рамку на всё изображение (двойной клик). */
  expandCropArea() {
    const W = this.viewW, H = this.viewH;
    let nw = W, nh = H;
    if (this.fixedAspect && this.aspectRatio) {
      if (W / H > this.aspectRatio) nw = H * this.aspectRatio; else nh = W / this.aspectRatio;
    }
    this.cropRotation = 0;
    this.cropArea = { x: (W - nw) / 2, y: (H - nh) / 2, width: nw, height: nh };
    this._saveCropArea();
    this.requestDraw();
  }

  _bindDblClick() {
    const cv = this.overlayCanvas;
    if (!cv || cv.dataset.peDbl) return;
    cv.dataset.peDbl = '1';
    cv.addEventListener('dblclick', () => { if (this.isActive) this.expandCropArea(); });
  }

  _resetInteraction() {
    this._drag = null; this._resizeHandle = null; this._resizeAnchor = null; this._rotating = false;
  }


  // ─── Геометрия с учётом поворота ──────────────────────────────────────────

  _toLocal(x, y) {
    const { x: cx, y: cy, width, height } = this.cropArea;
    const ox = cx + width / 2, oy = cy + height / 2;
    const cos = Math.cos(-this.cropRotation), sin = Math.sin(-this.cropRotation);
    const dx = x - ox, dy = y - oy;
    return { lx: dx * cos - dy * sin, ly: dx * sin + dy * cos };
  }

  _toWorld(lx, ly) {
    const { x: cx, y: cy, width, height } = this.cropArea;
    const ox = cx + width / 2, oy = cy + height / 2;
    const cos = Math.cos(this.cropRotation), sin = Math.sin(this.cropRotation);
    return { x: ox + lx * cos - ly * sin, y: oy + lx * sin + ly * cos };
  }

  /** @returns {'rotate'|'inside'|имя ручки|null} */
  _hitTest(x, y) {
    if (!this.cropArea) return null;
    const { width, height } = this.cropArea;
    const { lx, ly } = this._toLocal(x, y);
    const hw = width / 2, hh = height / 2;
    const s  = this.resizeHandleSize + 5;

    if (Math.hypot(lx, ly - (-hh - CFG.rotateHandleOffset)) <= s) return 'rotate';
    for (const [name, cx, cy] of [['topLeft', -hw, -hh], ['topRight', hw, -hh], ['bottomLeft', -hw, hh], ['bottomRight', hw, hh]]) {
      if (Math.hypot(lx - cx, ly - cy) <= s) return name;
    }
    if (Math.abs(ly + hh) <= s && Math.abs(lx) < hw) return 'top';
    if (Math.abs(ly - hh) <= s && Math.abs(lx) < hw) return 'bottom';
    if (Math.abs(lx + hw) <= s && Math.abs(ly) < hh) return 'left';
    if (Math.abs(lx - hw) <= s && Math.abs(ly) < hh) return 'right';
    if (Math.abs(lx) <= hw && Math.abs(ly) <= hh) return 'inside';
    return null;
  }

  _cursorFor(hit) {
    if (!hit) return 'default';
    if (hit === 'rotate') return 'crosshair';
    if (hit === 'inside') return 'move';
    return HANDLE_CURSORS[hit] ?? 'default';
  }

  _setCursor(c) { if (this.overlayCanvas) this.overlayCanvas.style.cursor = c; }


  // ─── Указатель ────────────────────────────────────────────────────────────

  onHover(pt) { this._setCursor(this._cursorFor(this._hitTest(pt.x, pt.y))); }

  onPointerDown(pt) {
    if (!this.cropArea) return;
    const { x, y } = pt;
    const hit = this._hitTest(x, y);
    if (!hit) return;

    if (hit === 'rotate') {
      this._rotating = true;
      const { x: cx, y: cy, width, height } = this.cropArea;
      this._rotateStartAngle = Math.atan2(y - (cy + height / 2), x - (cx + width / 2)) - this.cropRotation;
      this._setCursor('crosshair');
    } else if (hit === 'inside') {
      this._drag = { x, y, cx: this.cropArea.x, cy: this.cropArea.y };
      this._setCursor('move');
    } else {
      this._resizeHandle = hit;
      const a = anchorLocal(hit, this.cropArea.width, this.cropArea.height);
      this._resizeAnchor = this._toWorld(a.lx, a.ly);
      this._setCursor(HANDLE_CURSORS[hit]);
    }
  }

  onPointerMove(pt) {
    if (!this.cropArea) return;
    const { x, y } = pt;

    if (this._rotating) {
      const { x: cx, y: cy, width, height } = this.cropArea;
      this.cropRotation = Math.atan2(y - (cy + height / 2), x - (cx + width / 2)) - this._rotateStartAngle;
      this.requestDraw();
      return;
    }
    if (this._drag) {
      this.cropArea.x = this._drag.cx + (x - this._drag.x);
      this.cropArea.y = this._drag.cy + (y - this._drag.y);
      this._clampArea();
      this.requestDraw();
      return;
    }
    if (this._resizeHandle) {
      const { lx, ly } = this._toLocal(x, y);
      this._resizeLocal(lx, ly);
      this.requestDraw();
    }
  }

  onPointerUp() {
    this._resetInteraction();
    this._clampArea();
    this._saveCropArea();
    this._setCursor('default');
    this.requestDraw();
  }

  onPointerCancel() { this.onPointerUp(); }

  /** Resize по локальным координатам курсора; якорь остаётся на месте. */
  _resizeLocal(lx, ly) {
    const ca = this.cropArea, h = this._resizeHandle;
    const min = 20;
    const ar  = this.fixedAspect ? this.aspectRatio : null;
    const mw  = ar ? Math.max(min, min * ar) : min;
    const mh  = ar ? Math.max(min, min / ar) : min;
    const hw  = ca.width / 2, hh = ca.height / 2;
    let newW = ca.width, newH = ca.height;

    const isLeft = h === 'topLeft' || h === 'bottomLeft' || h === 'left';
    const isTop  = h === 'topLeft' || h === 'topRight'   || h === 'top';
    const horiz  = h !== 'top' && h !== 'bottom';
    const vert   = h !== 'left' && h !== 'right';

    if (horiz) newW = Math.max(mw, isLeft ? hw - lx : hw + lx);
    if (vert)  newH = Math.max(mh, isTop  ? hh - ly : hh + ly);
    if (ar) {
      if (horiz && vert) { newH = Math.max(mh, newW / ar); newW = newH * ar; }
      else if (horiz)    newH = newW / ar;
      else               newW = newH * ar;
    }

    ca.width = newW; ca.height = newH;
    const a = anchorLocal(h, newW, newH);
    if (this._resizeAnchor && a) {
      const cos = Math.cos(this.cropRotation), sin = Math.sin(this.cropRotation);
      ca.x = this._resizeAnchor.x - (a.lx * cos - a.ly * sin) - newW / 2;
      ca.y = this._resizeAnchor.y - (a.lx * sin + a.ly * cos) - newH / 2;
    }
  }


  // ─── Клавиатура ───────────────────────────────────────────────────────────

  onKey(e) {
    if (e.key === 'Enter') { this.apply(); return true; }
    if (!this.cropArea) return false;
    const step = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'ArrowUp':    this.cropArea.y -= step; break;
      case 'ArrowDown':  this.cropArea.y += step; break;
      case 'ArrowLeft':  this.cropArea.x -= step; break;
      case 'ArrowRight': this.cropArea.x += step; break;
      default: return false;
    }
    this._clampArea(); this._saveCropArea(); this.requestDraw();
    return true;
  }


  // ─── Поворот изображения ──────────────────────────────────────────────────

  /**
   * Поворачивает всё изображение на deg° (кратно 90). Клики, пришедшие пока
   * предыдущий поворот кодируется, накапливаются и применяются одним поворотом
   * после его завершения: два быстрых клика дают 180°, а не 90°.
   */
  _rotateImage(deg) {
    this._pendingRotation = (this._pendingRotation + deg) % 360;
    if (this._rotatingImage) return;
    this._runPendingRotation();
  }

  _runPendingRotation() {
    const src = this.pe.img;
    const deg = ((this._pendingRotation % 360) + 360) % 360;
    this._pendingRotation = 0;
    if (!src || deg === 0 || !this.isActive) return;

    this._rotatingImage = true;
    const sw = src.naturalWidth, sh = src.naturalHeight;
    const swap = deg === 90 || deg === 270;
    const canvas = document.createElement('canvas');
    canvas.width  = swap ? sh : sw;
    canvas.height = swap ? sw : sh;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(src, -sw / 2, -sh / 2);

    // Рамка устарела: после загрузки нового изображения onDraw поставит дефолт
    this.naturalCropArea = null;
    this.cropArea        = null;
    this.cropRotation    = 0;
    this.pe.commitCanvas(canvas)
      .catch(err => console.error('[CropTool] rotate:', err))
      .then(() => {
        this._rotatingImage = false;
        this.requestDraw();
        if (this._pendingRotation !== 0) this._runPendingRotation();
      });
  }


  // ─── Панель ───────────────────────────────────────────────────────────────

  buildPanel() {
    const panel = document.createElement('div');
    const ratioButtons = !this._externalAspect
      ? CFG.ratios.map((r, i) => `
          <button type="button"
                  class="pe-panel__crop-ratio-btn${i === 0 && !this.fixedAspect ? ' is-active' : ''}"
                  data-ratio="${r.value ?? ''}" aria-pressed="${i === 0 && !this.fixedAspect}"
                  title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</button>`).join('')
      : '';

    panel.innerHTML = `
      <div class="pe-panel__crop-toolbar" role="toolbar" aria-label="Кадрирование">
        <button type="button" class="pe-panel__crop-tb-btn" data-action="rotate-ccw"
                title="Повернуть против часовой стрелки" aria-label="Повернуть против часовой стрелки">
          <i class="icon-image-rotate-round-ccw" aria-hidden="true"></i>
        </button>
        <button type="button" class="pe-panel__crop-tb-btn" data-action="rotate-cw"
                title="Повернуть по часовой стрелке" aria-label="Повернуть по часовой стрелке">
          <i class="icon-image-rotate-round-cw" aria-hidden="true"></i>
        </button>
        ${!this._externalAspect ? `<div class="pe-panel__crop-sep"></div>${ratioButtons}` : ''}
        <div class="pe-panel__crop-spacer"></div>
        <button type="button" class="pe-panel__crop-tb-btn pe-panel__crop-tb-btn--apply" data-action="apply"
                title="Применить (Enter)">
          <i class="icon-checkmark" aria-hidden="true"></i>
          <span class="pe-panel__crop-tb-label">Применить</span>
        </button>
      </div>`;

    panel.querySelector('[data-action="rotate-ccw"]').addEventListener('click', () => this._rotateImage(-90));
    panel.querySelector('[data-action="rotate-cw"]').addEventListener('click',  () => this._rotateImage(90));
    panel.querySelector('[data-action="apply"]').addEventListener('click',      () => this.apply());

    panel.querySelectorAll('.pe-panel__crop-ratio-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const raw = btn.dataset.ratio;
        const val = raw === '' ? null : parseFloat(raw);
        this.aspectRatio = val;
        this.fixedAspect = val !== null;
        panel.querySelectorAll('.pe-panel__crop-ratio-btn').forEach(b => {
          b.classList.toggle('is-active', b === btn);
          b.setAttribute('aria-pressed', String(b === btn));
        });
        this.adjustCropToAspectRatio();
        this._clampArea();
        this._saveCropArea();
        this.requestDraw();
      });
    });
    return panel;
  }
}
