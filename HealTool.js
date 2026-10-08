/**
 * HealTool — точечная восстанавливающая кисть.
 *
 * Пользователь закрашивает дефект; после паузы (previewDebounceMs) считается
 * предпросмотр в display-разрешении, «Применить» пересчитывает результат в
 * натуральном разрешении. Алгоритм — в healAlgorithm.js (чистые функции).
 *
 * Canvas-слои (снизу вверх): <img> → preview (результат) → overlay (маска + курсор).
 * Маска мазков копится на offscreen-canvas логического размера (source-over
 * даёт объединение без наслоения альфы) и подкрашивается при отрисовке.
 *
 * Жизненный цикл, canvas, указатель, панель и клавиатура — в ToolBase.
 */

import { EditorConfig }      from './EditorConfig.js';
import { ToolBase }          from './ToolBase.js';
import { applyHealingBrush } from './healAlgorithm.js';
import { processImage }      from './pixelOps.js';

const CFG    = EditorConfig.heal;
const LS_KEY = CFG.storageKey;

// ─── localStorage ─────────────────────────────────────────────────────────────

function loadSettings() {
  try { const s = localStorage.getItem(LS_KEY); const o = s ? JSON.parse(s) : {}; return o && typeof o === 'object' ? o : {}; }
  catch { return {}; }
}
function saveSettings(obj) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch { /* ignore */ }
}
/** Число в диапазоне или fallback (NaN/строки из localStorage не проходят). */
function numInRange(v, min, max, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function imgToCanvasScaled(img, w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(img, 0, 0, w, h);
  return cv;
}


// ─── HealTool ─────────────────────────────────────────────────────────────────

export class HealTool extends ToolBase {

  brushSize  = CFG.defaultBrushSize;
  searchMult = CFG.defaultSearchMult;

  /** Мазки [{cx, cy, r}] в логических координатах overlay. */
  _strokes   = [];
  _painting  = false;
  _lastPoint = null;

  _maskCanvas = null; _maskCtx = null;         // накопленная маска (offscreen, логический размер)
  _previewCanvas = null; _previewCtx = null;   // предпросмотр результата (в DOM под overlay)
  _previewTimer  = null;
  _hasPreview    = false;
  _previewImg    = null;    // для какого pe.img посчитано превью

  _cursor = { x: -9999, y: -9999, visible: false };

  constructor(photoEditor) {
    super(photoEditor, { id: 'heal', cursor: 'none' });
    const saved = loadSettings();
    this.brushSize  = numInRange(saved.brushSize,  CFG.minBrushSize,  CFG.maxBrushSize,  CFG.defaultBrushSize);
    this.searchMult = numInRange(saved.searchMult, CFG.minSearchMult, CFG.maxSearchMult, CFG.defaultSearchMult);
  }


  // ─── Хуки жизненного цикла ────────────────────────────────────────────────

  onStart() {
    this._strokes = []; this._hasPreview = false; this._painting = false;
    this._ensureAuxCanvases();
    this._clearMask();
    this._clearPreview();
  }

  onResume() {
    this._painting = false; this._lastPoint = null;
    this._ensureAuxCanvases();
    // Превью освобождено в suspend — пересчитываем, если были мазки
    this._hasPreview = false;
    if (this._strokes.length) this._schedulePreview();
  }

  onSuspend() {
    this._cancelPreviewTimer();
    this._painting = false; this._lastPoint = null; this._cursor.visible = false;
    // Preview-canvas освобождаем (пересчитается при resume), маску мазков оставляем
    this._previewCanvas?.remove();
    this._previewCanvas = null; this._previewCtx = null;
  }

  onCancel()  { this._reset(); }
  onDestroy() { this._reset(); }

  async onApply() {
    this._cancelPreviewTimer();
    const img = this.pe.img;
    if (!img || !this._strokes.length) { this._reset(); return null; }

    const k       = this.naturalScale;
    const strokes = this._strokes.map(s => ({ cx: s.cx * k, cy: s.cy * k, r: Math.max(2, s.r * k) }));
    const opts    = { searchMult: this.searchMult, featherFraction: CFG.featherFraction };
    this._reset();

    // Декодирование (createImageBitmap(Blob)), пиксели, алгоритм и PNG-кодирование —
    // вне главного потока; сюда возвращается готовый Blob (issue #11)
    return processImage('heal', { blob: this.pe.getImageBlob(), image: img }, { strokes, opts });
  }

  onViewResize(kx, ky) {
    for (const s of this._strokes) { s.cx *= kx; s.cy *= ky; s.r *= (kx + ky) / 2; }
    this._resizeAuxCanvases();
    if (this._hasPreview) this._schedulePreview();
  }

  onDraw(ctx) {
    // Накопленная маска одним слоем, подкрашенная через source-atop
    if (this._maskCanvas && this._strokes.length) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      ctx.drawImage(this._maskCanvas, 0, 0, this.viewW, this.viewH);
      ctx.globalCompositeOperation = 'source-atop';
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(60, 160, 255, 0.55)';
      ctx.fillRect(0, 0, this.viewW, this.viewH);
      ctx.restore();
    }

    if (this._cursor.visible) {
      const { x, y } = this._cursor;
      const r = this.brushSize;
      ctx.save();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.90)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.75; ctx.stroke();
      ctx.beginPath(); ctx.arc(x, y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fill();
      ctx.restore();
    }
  }


  // ─── Указатель ────────────────────────────────────────────────────────────

  onHover(pt)  { this._setCursor(pt, true); }
  onHoverEnd() { this._setCursor(null, false); }

  onPointerDown(pt) {
    this._cancelPreviewTimer();
    this._painting  = true;
    this._lastPoint = { x: pt.x, y: pt.y };
    this._setCursor(pt, true);
    this._addStroke(pt.x, pt.y);
    this.requestDraw();
  }

  onPointerMove(pt) {
    this._setCursor(pt, true);
    this._movePaint(pt.x, pt.y);
    this.requestDraw();
  }

  onPointerUp() { this._endPaint(); }
  onPointerCancel() { this._endPaint(); }

  _setCursor(pt, visible) {
    if (pt) { this._cursor.x = pt.x; this._cursor.y = pt.y; }
    this._cursor.visible = visible;
    this.requestDraw();
  }

  _movePaint(x, y) {
    if (!this._painting || !this._lastPoint) return;
    const { x: lx, y: ly } = this._lastPoint;
    const dist = Math.hypot(x - lx, y - ly);
    const step = Math.max(1, (this.brushSize / 3) | 0);
    if (dist < step) return;
    // Интерполируем круги вдоль отрезка с шагом step: иначе при быстром
    // движении мазок рвался на пятна, каждое — своя компонента алгоритма.
    const n = Math.floor(dist / step);
    for (let i = 1; i <= n; i++) {
      const t = (i * step) / dist;
      this._addStroke(lx + (x - lx) * t, ly + (y - ly) * t);
    }
    const t = (n * step) / dist;
    this._lastPoint = { x: lx + (x - lx) * t, y: ly + (y - ly) * t };
  }

  _endPaint() {
    if (!this._painting) return;
    this._painting = false; this._lastPoint = null;
    if (this._strokes.length) this._schedulePreview();
  }

  _addStroke(x, y) {
    this._strokes.push({ cx: x, cy: y, r: this.brushSize });
    if (this._maskCtx) {
      this._maskCtx.globalCompositeOperation = 'source-over';
      this._maskCtx.fillStyle = '#fff';
      this._maskCtx.beginPath();
      this._maskCtx.arc(x, y, this.brushSize, 0, Math.PI * 2);
      this._maskCtx.fill();
    }
  }


  // ─── Клавиатура ───────────────────────────────────────────────────────────

  onKey(e) {
    // e.code — физическая позиция клавиши, не зависит от раскладки
    const isL = e.code === 'BracketLeft', isR = e.code === 'BracketRight';
    if (!isL && !isR) return false;
    this.brushSize = isL
      ? Math.max(CFG.minBrushSize, this.brushSize - CFG.brushSizeStep)
      : Math.min(CFG.maxBrushSize, this.brushSize + CFG.brushSizeStep);
    this._saveSettings(); this._syncPanel(); this.requestDraw();
    return true;
  }


  // ─── Вспомогательные canvas ───────────────────────────────────────────────

  _ensureAuxCanvases() {
    const w = Math.max(1, this.viewW), h = Math.max(1, this.viewH);
    if (!this._maskCanvas) {
      this._maskCanvas = document.createElement('canvas');
      this._maskCtx    = this._maskCanvas.getContext('2d');
    }
    if (this._maskCanvas.width !== w || this._maskCanvas.height !== h) {
      this._maskCanvas.width = w; this._maskCanvas.height = h;
    }
    if (!this._previewCanvas) {
      const cv = document.createElement('canvas');
      cv.className = 'pe-tool-canvas pe-tool-canvas--heal-preview';
      cv.style.pointerEvents = 'none';
      cv.style.display = 'none';
      this._previewCanvas = cv;
      this._previewCtx    = cv.getContext('2d');
    }
    if (this._previewCanvas.width !== w || this._previewCanvas.height !== h) {
      this._previewCanvas.width = w; this._previewCanvas.height = h;
    }
    // Preview — под overlay-canvas
    const parent = this.overlayCanvas?.parentElement;
    if (parent && this._previewCanvas.parentElement !== parent) {
      parent.insertBefore(this._previewCanvas, this.overlayCanvas);
    }
  }

  /** Подгоняет offscreen-маску и preview под новый логический размер, сохраняя маску. */
  _resizeAuxCanvases() {
    const w = Math.max(1, this.viewW), h = Math.max(1, this.viewH);
    if (this._maskCanvas && (this._maskCanvas.width !== w || this._maskCanvas.height !== h)) {
      if (this._strokes.length) {
        const tmp = document.createElement('canvas');
        tmp.width = w; tmp.height = h;
        tmp.getContext('2d').drawImage(this._maskCanvas, 0, 0, w, h);
        this._maskCanvas.width = w; this._maskCanvas.height = h;
        this._maskCtx.drawImage(tmp, 0, 0);
      } else {
        this._maskCanvas.width = w; this._maskCanvas.height = h;
      }
    }
    if (this._previewCanvas && (this._previewCanvas.width !== w || this._previewCanvas.height !== h)) {
      this._previewCanvas.width = w; this._previewCanvas.height = h;   // очищает; пересчёт — в onViewResize
    }
  }

  _clearMask() {
    if (this._maskCtx) this._maskCtx.clearRect(0, 0, this._maskCanvas.width, this._maskCanvas.height);
  }

  _clearPreview() {
    if (!this._previewCanvas) return;
    this._previewCanvas.style.display = 'none';
    this._previewCtx.clearRect(0, 0, this._previewCanvas.width, this._previewCanvas.height);
    this._hasPreview = false;
  }

  _reset() {
    this._cancelPreviewTimer();
    this._strokes = []; this._hasPreview = false; this._painting = false; this._lastPoint = null;
    this._previewCanvas?.remove();
    this._previewCanvas = null; this._previewCtx = null;
    this._maskCanvas = null; this._maskCtx = null;
  }


  // ─── Предпросмотр ─────────────────────────────────────────────────────────

  _schedulePreview() {
    this._cancelPreviewTimer();
    this._previewTimer = setTimeout(() => {
      this._previewTimer = null;
      this._computePreview();
    }, CFG.previewDebounceMs);
  }

  _cancelPreviewTimer() {
    if (this._previewTimer != null) { clearTimeout(this._previewTimer); this._previewTimer = null; }
  }

  _computePreview() {
    if (!this.isActive || !this._previewCanvas) return;
    if (!this._strokes.length) { this._clearPreview(); return; }
    const img = this.pe.img;
    if (!img) return;

    const w = this._previewCanvas.width, h = this._previewCanvas.height;
    const osc = imgToCanvasScaled(img, w, h);
    const ctx = osc.getContext('2d');
    const id  = ctx.getImageData(0, 0, w, h);
    applyHealingBrush(id.data, w, h, this._strokes, { searchMult: this.searchMult, featherFraction: CFG.featherFraction });
    ctx.putImageData(id, 0, 0);

    this._previewCtx.clearRect(0, 0, w, h);
    this._previewCtx.drawImage(osc, 0, 0);
    this._previewCanvas.style.display = '';
    this._hasPreview = true;
    this._previewImg = img;
  }


  // ─── Панель ───────────────────────────────────────────────────────────────

  buildPanel() {
    const panel = document.createElement('div');
    panel.innerHTML = `
      ${ToolBase.panelHeader({ title: 'Ретушь', prefix: 'heal-panel', applyTitle: 'Применить в полном разрешении' })}

      <div class="pe-panel__row">
        <label class="heal-panel__lbl" title="Радиус кисти. Клавиши [ и ] уменьшают/увеличивают">
          <span class="heal-panel__lbl-text">Размер</span>
          <input type="range" class="heal-panel__brush-size"
                 min="${CFG.minBrushSize}" max="${CFG.maxBrushSize}"
                 step="${CFG.brushSizeStep}" value="${this.brushSize}">
          <span class="heal-panel__val heal-panel__val--size">${this.brushSize}</span>px
        </label>
      </div>

      <div class="pe-panel__row">
        <label class="heal-panel__lbl" title="Область поиска донорского патча. Увеличьте для крупных дефектов или пёстрого фона.">
          <span class="heal-panel__lbl-text">Поиск</span>
          <input type="range" class="heal-panel__search-mult"
                 min="${CFG.minSearchMult}" max="${CFG.maxSearchMult}"
                 step="0.5" value="${this.searchMult}">
          <span class="heal-panel__val heal-panel__val--search">${this.searchMult}</span>×
        </label>
      </div>

      <div class="pe-panel__row heal-panel__row--actions">
        <button type="button"
                class="photoeditor__button photoeditor__button--compact heal-panel__btn-clear"
                title="Очистить все мазки">
          <i class="icon-bin" aria-hidden="true"></i> Очистить
        </button>
      </div>

      <div class="pe-panel__hint">
        Закрасьте дефект — предпросмотр появится сам
      </div>`;

    const sizeEl  = panel.querySelector('.heal-panel__brush-size');
    const sizeVal = panel.querySelector('.heal-panel__val--size');
    sizeEl.addEventListener('input', () => {
      this.brushSize = Number(sizeEl.value);
      sizeVal.textContent = sizeEl.value;
      this._saveSettings(); this.requestDraw();
    });

    const searchEl  = panel.querySelector('.heal-panel__search-mult');
    const searchVal = panel.querySelector('.heal-panel__val--search');
    searchEl.addEventListener('input', () => {
      this.searchMult = Number(searchEl.value);
      searchVal.textContent = searchEl.value;
      this._saveSettings();
      if (this._strokes.length) this._schedulePreview();
    });

    panel.querySelector('.heal-panel__btn-clear').addEventListener('click', () => {
      this._cancelPreviewTimer();
      this._strokes = []; this._clearMask(); this._clearPreview(); this.requestDraw();
    });
    return panel;
  }

  _syncPanel() {
    if (!this._panel) return;
    const q = (sel) => this._panel.querySelector(sel);
    const sizeEl = q('.heal-panel__brush-size'), sizeVal = q('.heal-panel__val--size');
    if (sizeEl)  sizeEl.value        = this.brushSize;
    if (sizeVal) sizeVal.textContent = this.brushSize;
    const searchEl = q('.heal-panel__search-mult'), searchVal = q('.heal-panel__val--search');
    if (searchEl)  searchEl.value        = this.searchMult;
    if (searchVal) searchVal.textContent = this.searchMult;
  }

  _saveSettings() {
    saveSettings({ brushSize: this.brushSize, searchMult: this.searchMult });
  }
}
