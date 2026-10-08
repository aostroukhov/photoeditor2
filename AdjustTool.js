/**
 * AdjustTool — яркостная и цветовая коррекция (экспозиция, контраст, тени,
 * свет, насыщенность, сочность, теплота, тон).
 *
 * Превью: уменьшенная копия изображения (≤ previewMaxSize) корректируется на
 * каждое движение ползунка и рисуется на overlay-canvas поверх <img>; сам
 * <img> при этом скрывается (opacity 0). apply() применяет те же параметры к
 * полноразмерному ImageData, снятому при старте инструмента.
 *
 * Жизненный цикл, canvas, панель и клавиатура — в ToolBase.
 */

import { EditorConfig } from './EditorConfig.js';
import { ToolBase }     from './ToolBase.js';
import { escapeHtml }   from './utils.js';
import { applyAdjustments, isDefaultParams } from './adjustAlgorithm.js';
import { processImage }   from './pixelOps.js';

// Реэкспорт для unit-тестов и внешнего кода
export { rgbToHsl, hslToRgb, buildLUT, applyAdjustments, isDefaultParams } from './adjustAlgorithm.js';

const CFG = EditorConfig.adjust;


// ─── Вспомогательные ──────────────────────────────────────────────────────────

/** Уменьшенная копия img для быстрого превью. */
function makeSmallCanvas(img, maxSize) {
  const sw = img.naturalWidth, sh = img.naturalHeight;
  const k  = Math.min(1, maxSize / Math.max(sw, sh));
  const pw = Math.max(1, Math.round(sw * k));
  const ph = Math.max(1, Math.round(sh * k));
  const cv = document.createElement('canvas');
  cv.width = pw; cv.height = ph;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, pw, ph);
  return cv;
}

/**
 * Полноразмерный ImageData из img. Снимается один раз при старте —
 * apply() использует его, а не pe.img, чтобы исключить коррекцию превью.
 */
function readFullImageData(img) {
  const cv  = document.createElement('canvas');
  cv.width  = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, cv.width, cv.height);
}


// ─── AdjustTool ───────────────────────────────────────────────────────────────

export class AdjustTool extends ToolBase {

  /** Текущие параметры коррекции. */
  params = { ...CFG.defaults };

  _smallCanvas   = null;   // уменьшенная копия
  _smallOrigData = null;   // её исходные пиксели (ImageData)
  _smallWork     = null;   // рабочий ImageData того же размера (переиспользуется)
  _tmpCanvas     = null;   // буфер для putImageData перед масштабированием на overlay

  _fullOrig      = null;   // полноразмерный ImageData исходника (для apply)
  _fullOrigImg   = null;   // с какого img снят _fullOrig

  constructor(photoEditor) {
    super(photoEditor, { id: 'adjust', canvasPointer: false });
  }


  // ─── Хуки жизненного цикла ────────────────────────────────────────────────

  onStart() {
    this._initPreview();
  }

  onSuspend() {
    this._restoreImgElement();
    // Полноразмерные пиксели (~4 байта/px) не держим в фоне: при resume
    // перечитаем с актуального pe.img — другой инструмент мог его изменить.
    this._fullOrig = null; this._fullOrigImg = null;
  }

  onCancel() {
    this.params = { ...CFG.defaults };
    this._restoreImgElement();
    this._freePreview();
  }

  async onApply() {
    const pe = this.pe;
    this._restoreImgElement();
    if (isDefaultParams(this.params) || !pe.img) { this._freePreview(); return null; }

    // Исходник берём с момента старта/resume; если img сменился — перечитываем
    if (this._fullOrigImg !== pe.img || !this._fullOrig) this._fullOrig = readFullImageData(pe.img);
    const src    = this._fullOrig;
    const params = { ...this.params };
    this.params  = { ...CFG.defaults };
    this._freePreview();

    // Полный кадр — в Worker, включая PNG-кодирование; буфер исходника передаётся
    // transferable (копии нет), при падении Worker пиксели перечитываются из pe.img
    const img = pe.img;
    return processImage('adjust', { imageData: src, onRetry: () => readFullImageData(img) }, params);
  }

  onDestroy() {
    this.params = { ...CFG.defaults };
    this._restoreImgElement();
    this._freePreview();
  }

  onDraw(ctx) {
    if (!this._smallCanvas || !this._smallOrigData || !ctx) return;

    // Клонируем маленький ImageData и применяем коррекцию
    const work = this._smallWork;
    work.data.set(this._smallOrigData.data);
    if (!isDefaultParams(this.params)) applyAdjustments(work, this.params);

    const tmp = this._tmpCanvas;
    tmp.getContext('2d').putImageData(work, 0, 0);

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, 0, 0, this.viewW, this.viewH);

    // Показываем превью вместо оригинала
    if (this.pe.imgElement) this.pe.imgElement.style.opacity = '0';
  }


  // ─── Превью ───────────────────────────────────────────────────────────────

  _initPreview() {
    const img = this.pe.img;
    if (!img) return;

    this._smallCanvas   = makeSmallCanvas(img, CFG.previewMaxSize);
    const sCtx          = this._smallCanvas.getContext('2d');
    this._smallOrigData = sCtx.getImageData(0, 0, this._smallCanvas.width, this._smallCanvas.height);
    this._smallWork     = new ImageData(this._smallOrigData.width, this._smallOrigData.height);
    this._tmpCanvas     = document.createElement('canvas');
    this._tmpCanvas.width  = this._smallOrigData.width;
    this._tmpCanvas.height = this._smallOrigData.height;

    // Полноразмерный снимок — один раз, apply() применит параметры к нему
    this._fullOrig    = readFullImageData(img);
    this._fullOrigImg = img;
  }

  _freePreview() {
    this._smallCanvas = null; this._smallOrigData = null; this._smallWork = null; this._tmpCanvas = null;
    this._fullOrig = null; this._fullOrigImg = null;
  }

  /** Возвращает видимость оригинального <img>. */
  _restoreImgElement() {
    if (this.pe.imgElement) this.pe.imgElement.style.opacity = '';
  }


  // ─── Панель ───────────────────────────────────────────────────────────────

  buildPanel() {
    const defs    = CFG.defaults;
    const sliders = CFG.sliders;

    const slidersHTML = sliders.map(s => `
      <div class="adj-panel__row">
        <label class="adj-panel__lbl" for="pe-adj-${s.param}" title="${escapeHtml(s.hint)}">${escapeHtml(s.label)}</label>
        <input type="range" id="pe-adj-${s.param}"
               class="adj-panel__range"
               data-param="${s.param}"
               min="${s.min}" max="${s.max}" step="${s.step}"
               value="${defs[s.param]}">
        <span class="adj-panel__val" data-val="${s.param}">${defs[s.param]}</span>
        <button type="button" class="adj-panel__reset-one" data-reset="${s.param}"
                title="Сбросить «${escapeHtml(s.label)}»" aria-label="Сбросить «${escapeHtml(s.label)}»">
          <i class="icon-undo" aria-hidden="true"></i>
        </button>
      </div>`).join('');

    const panel = document.createElement('div');
    panel.innerHTML = `
      ${ToolBase.panelHeader({
        title: 'Коррекция', prefix: 'adj-panel', applyTitle: 'Применить коррекцию к изображению',
        left: `<button type="button"
                  class="photoeditor__button photoeditor__button--compact adj-panel__btn-reset"
                  title="Сбросить все параметры">
            <i class="icon-undo" aria-hidden="true"></i> Сбросить
          </button>`,
      })}
      <div class="adj-panel__sliders">${slidersHTML}</div>`;

    panel.querySelectorAll('.adj-panel__range').forEach(range => {
      const param = range.dataset.param;
      const valEl = panel.querySelector(`.adj-panel__val[data-val="${param}"]`);
      range.addEventListener('input', () => {
        this.params[param] = Number(range.value);
        if (valEl) valEl.textContent = range.value;
        this._syncRangeColor(range);
        this.requestDraw();
      });
    });

    panel.querySelectorAll('.adj-panel__reset-one').forEach(btn => {
      btn.addEventListener('click', () => {
        const param = btn.dataset.reset;
        this.params[param] = CFG.defaults[param];
        this._syncPanelValues(panel);
        this.requestDraw();
      });
    });

    panel.querySelector('.adj-panel__btn-reset').addEventListener('click', () => {
      this.params = { ...CFG.defaults };
      this._syncPanelValues(panel);
      this.requestDraw();
    });

    panel.querySelectorAll('.adj-panel__range').forEach(r => this._syncRangeColor(r));
    return panel;
  }

  _syncPanelValues(panel) {
    if (!panel) return;
    panel.querySelectorAll('.adj-panel__range').forEach(range => {
      const param = range.dataset.param;
      range.value = this.params[param];
      const valEl = panel.querySelector(`.adj-panel__val[data-val="${param}"]`);
      if (valEl) valEl.textContent = this.params[param];
      this._syncRangeColor(range);
    });
  }

  _syncRangeColor(range) {
    const min  = Number(range.min);
    const max  = Number(range.max);
    const val  = Number(range.value);
    const zero = (-min / (max - min)) * 100;
    const pct  = ((val - min) / (max - min)) * 100;

    const fillColor = Math.abs(val) < 1
      ? 'hsla(0,0%,100%,.25)'
      : val > 0 ? 'var(--pe-accent)' : '#7ab3ff';

    range.style.setProperty('--adj-fill-from',  Math.min(pct, zero).toFixed(1) + '%');
    range.style.setProperty('--adj-fill-to',    Math.max(pct, zero).toFixed(1) + '%');
    range.style.setProperty('--adj-fill-color', fillColor);
  }
}
