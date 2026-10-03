/**
 * AdjustTool v1.2
 *
 * Исправления v1.2:
 *  • Иконка: icon-filter
 *  • apply() теперь читает пиксели из _origFullImgData (полноразмерный ImageData
 *    сохранённый в момент start), а не из pe.img — исключает любую возможность
 *    применить коррекцию к уменьшенному превью
 *  • _drawPreview: imageSmoothingEnabled=true при upscale превью
 *  • _restoreImgElement вызывается во всех путях выхода
 */

import { EditorConfig } from './EditorConfig.js';

const CFG = EditorConfig.adjust;


// ─── Математика коррекций ─────────────────────────────────────────────────────

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l   = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if      (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else                h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1; if (t > 1) t -= 1;
  if (t < 1/6) return p + (q - p) * 6 * t;
  if (t < 1/2) return q;
  if (t < 2/3) return p + (q - p) * (2/3 - t) * 6;
  return p;
}

function hslToRgb(h, s, l) {
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
function buildLUT(exposure, contrast, shadows, highlights) {
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

/**
 * Применяет все коррекции к ImageData in-place. Один проход по пикселям.
 */
function applyAdjustments(imageData, params) {
  const { exposure, contrast, shadows, highlights, saturation, vibrance, hue, temperature } = params;
  const data    = imageData.data;
  const len     = data.length;
  const lut     = buildLUT(exposure, contrast, shadows, highlights);
  const satAdj  = saturation / 100;
  const vibAdj  = vibrance   / 100;
  const hueAdj  = hue        || 0;        // градусы: -180..+180
  const tempAdj = temperature || 0;       // -100..+100

  // Предрассчитываем температурные поправки (RGB-смещения)
  // Тёплая температура (+) = больше красного/жёлтого, меньше синего
  // Холодная (−) = больше синего, меньше красного
  const tempR = tempAdj >  0 ?  tempAdj * 0.6 : tempAdj * 0.3;   // px-уровни
  const tempG = tempAdj >  0 ?  tempAdj * 0.15 : tempAdj * 0.1;
  const tempB = tempAdj >  0 ? -tempAdj * 0.5 : -tempAdj * 0.6;

  const noColor = satAdj === 0 && vibAdj === 0 && hueAdj === 0;
  const noTemp  = tempAdj === 0;

  for (let i = 0; i < len; i += 4) {
    let r = lut[data[i]];
    let g = lut[data[i + 1]];
    let b = lut[data[i + 2]];

    // Температура — быстрый RGB-сдвиг без HSL
    if (!noTemp) {
      r = Math.max(0, Math.min(255, r + tempR));
      g = Math.max(0, Math.min(255, g + tempG));
      b = Math.max(0, Math.min(255, b + tempB));
    }

    if (!noColor) {
      let [h, s, l] = rgbToHsl(r, g, b);
      let ns = s;

      if (satAdj !== 0)
        ns = satAdj > 0 ? ns + satAdj * (1 - ns) : ns + satAdj * ns;

      if (vibAdj !== 0) {
        const vibMask = vibAdj > 0 ? (1 - ns) : ns;
        ns = ns + vibAdj * vibMask * 0.7;
      }

      ns = Math.max(0, Math.min(1, ns));

      // Сдвиг тона
      if (hueAdj !== 0) {
        h = (h + hueAdj + 360) % 360;
      }

      if (Math.abs(ns - s) > 0.001 || hueAdj !== 0)
        [r, g, b] = hslToRgb(h, ns, l);
      else if (Math.abs(ns - s) <= 0.001 && hueAdj === 0) {
        // только сатурация не изменилась, пересчёт не нужен — уже r,g,b
      }
    }

    data[i]     = r;
    data[i + 1] = g;
    data[i + 2] = b;
    // alpha не трогаем
  }
}

/**
 * Создаёт уменьшенный canvas для превью (≤ maxSize по длинной стороне).
 */
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
 * Читает полноразмерный ImageData из img.
 * Сохраняется один раз при старте — apply() использует его, а не pe.img.
 */
function readFullImageData(img) {
  const cv  = document.createElement('canvas');
  cv.width  = img.naturalWidth;
  cv.height = img.naturalHeight;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  return { canvas: cv, imageData: ctx.getImageData(0, 0, cv.width, cv.height) };
}


// ─── AdjustTool ───────────────────────────────────────────────────────────────

export class AdjustTool {

  constructor(photoEditor) {
    this.photoEditor = photoEditor;
    this.isActive    = false;
    this.isSuspended = false;
    this._stopping   = false;
    this._suspending = false;
    this._panel      = null;
    this.params      = { ...CFG.defaults };

    // Превью-холст (уменьшенный) — для быстрого перерасчёта при движении ползунков
    this._smallCanvas    = null;
    this._smallOrigData  = null;  // оригинальные пиксели уменьшенной копии

    // Полноразмерный ImageData — используется только в apply()
    this._fullOrigData   = null;
    this._fullOrigWidth  = 0;
    this._fullOrigHeight = 0;

    // Overlay-canvas поверх imgElement
    this._previewEl = null;
    this._raf       = null;
    this._dirty     = false;
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
    this._initPreview();
    this._createPanel();
    this._scheduleDraw();
    this.photoEditor.syncToolButtons?.();
  }

  suspend() {
    if (!this.isActive || this.isSuspended) return;
    this._restoreImgElement();
    this._hidePreviewEl();
    this._suspending = true;
    this.photoEditor.dialogs?.close('adjust');
    this._suspending = false;
    this.isActive    = false;
    this.isSuspended = true;
    this.photoEditor.activeTool = null;
    this.photoEditor.syncToolButtons?.();
  }

  cancel() {
    this.params = { ...CFG.defaults };
    this._destroyInternal();
  }

  apply() {
    const pe = this.photoEditor;

    const isDefault = Object.keys(this.params).every(k => this.params[k] === CFG.defaults[k]);
    if (isDefault) { this._destroyInternal(); pe._handleToolStop?.('adjust'); return; }
    if (!this._fullOrigData) { this._destroyInternal(); pe._handleToolStop?.('adjust'); return; }

    // Восстанавливаем imgElement до записи результата
    this._restoreImgElement();

    // Клонируем полноразмерный ImageData (сохранённый при старте инструмента)
    // и применяем коррекцию — гарантированно полное разрешение
    const cloned = new ImageData(
      new Uint8ClampedArray(this._fullOrigData),
      this._fullOrigWidth,
      this._fullOrigHeight,
    );
    applyAdjustments(cloned, this.params);

    // Записываем результат в canvas полного разрешения
    const out = document.createElement('canvas');
    out.width  = this._fullOrigWidth;
    out.height = this._fullOrigHeight;
    out.getContext('2d').putImageData(cloned, 0, 0);

    if (pe.export) pe.export(out);

    const url    = out.toDataURL('image/png');
    const newImg = new Image();
    newImg.onload = () => {
      pe.commitImage(newImg);
    };
    newImg.src = url;

    this.params = { ...CFG.defaults };
    this._destroyInternal();
    pe._handleToolStop?.('adjust');
  }

  openSettings() { this.photoEditor.dialogs?.toggle('adjust'); }

  destroy() { this._destroyInternal(true); }

  _resume() {
    if (!this.isSuspended) return;
    const imgEl = this.photoEditor.imgElement;
    if (!imgEl?.naturalWidth) return;
    this.isActive    = true;
    this.isSuspended = false;
    this.photoEditor.activeTool = this;
    this._initPreview();
    if (this._panel) { this.photoEditor.dialogs?.open('adjust'); }
    else             { this._createPanel(); }
    this._scheduleDraw();
    this.photoEditor.syncToolButtons?.();
  }

  _destroyInternal(silent = false) {
    if (this._stopping) return;
    this._stopping = true;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    this._restoreImgElement();
    this._removePreviewEl();
    this._smallCanvas   = null;
    this._smallOrigData = null;
    this._fullOrigData  = null;
    const panel = this._panel; this._panel = null;
    if (panel) { this.photoEditor.dialogs?.unregister('adjust'); panel.remove(); }
    this.isActive    = false;
    this.isSuspended = false;
    this._stopping   = false;
    this.photoEditor.activeTool = null;
    this.photoEditor.syncToolButtons?.();
  }


  // ─── Превью ───────────────────────────────────────────────────────────────

  _initPreview() {
    const pe    = this.photoEditor;
    const img   = pe.img;
    const imgEl = pe.imgElement;
    if (!img || !imgEl) return;

    // Уменьшенная копия для быстрого превью при движении ползунков
    this._smallCanvas   = makeSmallCanvas(img, CFG.previewMaxSize);
    const sCtx          = this._smallCanvas.getContext('2d');
    this._smallOrigData = sCtx.getImageData(
      0, 0, this._smallCanvas.width, this._smallCanvas.height
    );

    // Полноразмерный ImageData — читаем один раз, apply() будет использовать его
    const { imageData } = readFullImageData(img);
    this._fullOrigData   = imageData.data;   // Uint8ClampedArray
    this._fullOrigWidth  = imageData.width;
    this._fullOrigHeight = imageData.height;

    // Overlay-canvas поверх imgElement
    if (!this._previewEl) {
      this._previewEl = document.createElement('canvas');
      this._previewEl.style.pointerEvents = 'none';
      const parent = imgEl.parentElement
        || pe.container?.querySelector('.photoeditor__img-container');
      parent?.appendChild(this._previewEl);
    }
    this._previewEl.width  = imgEl.offsetWidth  || img.naturalWidth;
    this._previewEl.height = imgEl.offsetHeight || img.naturalHeight;
    this._previewEl.style.display = '';
    this._dirty = true;
  }

  /** Восстанавливает видимость оригинального imgElement */
  _restoreImgElement() {
    if (this.photoEditor.imgElement) {
      this.photoEditor.imgElement.style.opacity = '';
    }
  }

  _hidePreviewEl() {
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = null; }
    if (this._previewEl) {
      this._previewEl.getContext('2d')
        .clearRect(0, 0, this._previewEl.width, this._previewEl.height);
      this._previewEl.style.display = 'none';
    }
  }

  _removePreviewEl() {
    if (this._previewEl) {
      this._previewEl.getContext('2d')
        .clearRect(0, 0, this._previewEl.width, this._previewEl.height);
      this._previewEl.remove();
      this._previewEl = null;
    }
  }

  _scheduleDraw() {
    this._dirty = true;
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      if (this._dirty) this._drawPreview();
    });
  }

  /**
   * Рисует скорректированное превью на overlay-canvas.
   * Работает только с маленьким _smallCanvas — быстро.
   */
  _drawPreview() {
    this._dirty = false;
    if (!this._smallCanvas || !this._smallOrigData || !this._previewEl) return;

    // Клонируем маленький ImageData и применяем коррекцию
    const cloned = new ImageData(
      new Uint8ClampedArray(this._smallOrigData.data),
      this._smallOrigData.width,
      this._smallOrigData.height,
    );

    const isDefault = Object.keys(this.params).every(k => this.params[k] === CFG.defaults[k]);
    if (!isDefault) applyAdjustments(cloned, this.params);

    // Записываем в временный canvas и масштабируем на overlay
    const tmp  = document.createElement('canvas');
    tmp.width  = cloned.width;
    tmp.height = cloned.height;
    tmp.getContext('2d').putImageData(cloned, 0, 0);

    const outCtx = this._previewEl.getContext('2d');
    outCtx.imageSmoothingEnabled = true;
    outCtx.imageSmoothingQuality = 'high';
    outCtx.clearRect(0, 0, this._previewEl.width, this._previewEl.height);
    outCtx.drawImage(tmp, 0, 0, this._previewEl.width, this._previewEl.height);

    // Скрываем оригинальный imgElement — показываем скорректированное превью
    if (this.photoEditor.imgElement) {
      this.photoEditor.imgElement.style.opacity = '0';
    }
  }


  // ─── Панель управления ────────────────────────────────────────────────────

  _createPanel() {
    if (this._panel) return;

    const defs    = CFG.defaults;
    const sliders = CFG.sliders;

    const slidersHTML = sliders.map(s => `
      <div class="adj-panel__row">
        <span class="adj-panel__lbl" title="${s.hint}">${s.label}</span>
        <input type="range"
               class="adj-panel__range"
               data-param="${s.param}"
               min="${s.min}" max="${s.max}" step="${s.step}"
               value="${defs[s.param]}">
        <span class="adj-panel__val" data-val="${s.param}">${defs[s.param]}</span>
        <button type="button" class="adj-panel__reset-one" data-reset="${s.param}" title="Сбросить">
          <i class="icon-undo" aria-hidden="true"></i>
        </button>
      </div>`).join('');

    const panel = document.createElement('div');
    panel.className = 'pe-panel pe-panel--adjust';
    panel.innerHTML = `
      <div class="pe-panel__header">
        <div class="adj-panel__header-left">
          <span class="pe-panel__title">Коррекция</span>
          <button type="button"
                  class="photoeditor__button photoeditor__button--compact adj-panel__btn-reset"
                  title="Сбросить все параметры">
            <i class="icon-undo" aria-hidden="true"></i> Сбросить
          </button>
        </div>
        <div class="pe-panel__header-actions">
          <button type="button"
                  class="photoeditor__button photoeditor__button--compact adj-panel__btn-cancel"
                  title="Отмена">
            <i class="icon-close" aria-hidden="true"></i> Отмена
          </button>
          <button type="button"
                  class="photoeditor__button photoeditor__button--compact photoeditor__button--success adj-panel__btn-apply"
                  title="Применить коррекцию к изображению">
            <i class="icon-checkmark" aria-hidden="true"></i> Применить
          </button>
        </div>
      </div>
      <div class="adj-panel__sliders">${slidersHTML}</div>`;

    panel.querySelectorAll('.adj-panel__range').forEach(range => {
      const param = range.dataset.param;
      const valEl = panel.querySelector(`.adj-panel__val[data-val="${param}"]`);
      range.addEventListener('input', () => {
        this.params[param] = Number(range.value);
        if (valEl) valEl.textContent = range.value;
        this._syncRangeColor(range);
        this._scheduleDraw();
      });
    });

    panel.querySelectorAll('.adj-panel__reset-one').forEach(btn => {
      btn.addEventListener('click', () => {
        const param = btn.dataset.reset;
        this.params[param] = CFG.defaults[param];
        this._syncPanelValues(panel);
        this._scheduleDraw();
      });
    });

    panel.querySelector('.adj-panel__btn-reset').addEventListener('click', () => {
      this.params = { ...CFG.defaults };
      this._syncPanelValues(panel);
      this._scheduleDraw();
    });

    panel.querySelector('.adj-panel__btn-cancel').addEventListener('click', () => this.cancel());
    panel.querySelector('.adj-panel__btn-apply').addEventListener('click',  () => this.apply());

    panel.querySelectorAll('.adj-panel__range').forEach(r => this._syncRangeColor(r));

    this.photoEditor.container.appendChild(panel);
    this._panel = panel;

    this.photoEditor.dialogs?.register('adjust', panel, {
      group:   'tool',
      onClose: () => {
        if (this.isActive && !this._stopping && !this._suspending) this.suspend();
      },
    });
    this.photoEditor.dialogs?.open('adjust');
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
