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

const CFG = EditorConfig.adjust;


// ─── Математика коррекций ─────────────────────────────────────────────────────

export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if      (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else                h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1/6) return p + (q - p) * 6 * t;
  if (t < 1/2) return q;
  if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
  return p;
}

export function hslToRgb(h, s, l) {
  h /= 360;
  if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1/3) * 255),
    Math.round(hue2rgb(p, q, h)       * 255),
    Math.round(hue2rgb(p, q, h - 1/3) * 255),
  ];
}

/**
 * LUT для яркостных коррекций — строится один раз, применяется ко всем пикселям.
 */
export function buildLUT(exposure, contrast, shadows, highlights) {
  const lut       = new Uint8ClampedArray(256);
  const expFactor = Math.pow(2, exposure / 100);
  const conK      = 1 + contrast / 100;
  for (let i = 0; i < 256; i++) {
    let v = i / 255;
    v = v * expFactor;
    v = (v - 0.5) * conK + 0.5;
    if (shadows !== 0) {
      const mask = Math.max(0, 1 - v * 2);
      v += (shadows / 100) * 0.5 * mask * mask;
    }
    if (highlights !== 0) {
      const mask = Math.max(0, (v - 0.5) * 2);
      v += (highlights / 100) * 0.5 * mask * mask;
    }
    lut[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  return lut;
}

/** true, если все параметры равны значениям по умолчанию. */
export function isDefaultParams(params) {
  for (const k in CFG.defaults) if (params[k] !== CFG.defaults[k]) return false;
  return true;
}

/**
 * Применяет все коррекции к ImageData in-place. Один проход по пикселям.
 */
export function applyAdjustments(imageData, params) {
  const { exposure, contrast, shadows, highlights, saturation, vibrance, hue, temperature } = params;
  const data    = imageData.data;
  const len     = data.length;
  const lut     = buildLUT(exposure, contrast, shadows, highlights);
  const satAdj  = saturation / 100;
  const vibAdj  = vibrance   / 100;
  const hueAdj  = hue        || 0;        // градусы: -180..+180
  const tempAdj = temperature || 0;       // -100..+100

  // Температурные поправки (RGB-смещения): тёплая (+) = больше красного/жёлтого,
  // меньше синего; холодная (−) = наоборот
  const tempR = tempAdj >  0 ?  tempAdj * 0.6  : tempAdj * 0.3;
  const tempG = tempAdj >  0 ?  tempAdj * 0.15 : tempAdj * 0.1;
  const tempB = tempAdj >  0 ? -tempAdj * 0.5  : -tempAdj * 0.6;

  const noColor = satAdj === 0 && vibAdj === 0 && hueAdj === 0;
  const noTemp  = tempAdj === 0;

  for (let i = 0; i < len; i += 4) {
    let r = lut[data[i]], g = lut[data[i + 1]], b = lut[data[i + 2]];

    if (!noTemp) {
      r = Math.max(0, Math.min(255, r + tempR));
      g = Math.max(0, Math.min(255, g + tempG));
      b = Math.max(0, Math.min(255, b + tempB));
    }

    if (!noColor) {
      const [h0, s, l] = rgbToHsl(r, g, b);
      let h  = h0;
      let ns = s;

      // Нейтральный (серый) пиксель: s = 0, тон неопределён (rgbToHsl даёт h = 0 —
      // «красный»). Усиливать насыщенность такому пикселю нельзя — он покраснеет.
      if (s > 0) {
        if (satAdj !== 0)
          ns = satAdj > 0 ? ns + satAdj * (1 - ns) : ns + satAdj * ns;

        if (vibAdj !== 0) {
          const vibMask = vibAdj > 0 ? (1 - ns) : ns;
          ns = ns + vibAdj * vibMask * 0.7;
        }

        ns = Math.max(0, Math.min(1, ns));
      }

      // Сдвиг тона (для серого — тождество, hslToRgb при s = 0 вернёт серый)
      if (hueAdj !== 0) {
        h = (h + hueAdj + 360) % 360;
      }

      if (Math.abs(ns - s) > 0.001 || hueAdj !== 0)
        [r, g, b] = hslToRgb(h, ns, l);
    }

    data[i]     = r;
    data[i + 1] = g;
    data[i + 2] = b;
  }
}


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

  onApply() {
    const pe = this.pe;
    this._restoreImgElement();
    if (isDefaultParams(this.params) || !pe.img) { this._freePreview(); return null; }

    // Исходник берём с момента старта/resume; если img сменился — перечитываем
    if (this._fullOrigImg !== pe.img || !this._fullOrig) this._fullOrig = readFullImageData(pe.img);
    const src = this._fullOrig;
    const out = new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
    applyAdjustments(out, this.params);

    const cv  = document.createElement('canvas');
    cv.width  = out.width;
    cv.height = out.height;
    cv.getContext('2d').putImageData(out, 0, 0);

    this.params = { ...CFG.defaults };
    this._freePreview();
    return cv;
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
