/**
 * Математика яркостной и цветовой коррекции (чистые функции, без DOM).
 * Выполняется и на главном потоке (превью), и в Web Worker (apply).
 */

/** Параметры по умолчанию — дублируют EditorConfig.adjust.defaults, чтобы модуль был автономен. */
export const ADJUST_DEFAULTS = {
  exposure: 0, contrast: 0, shadows: 0, highlights: 0,
  saturation: 0, vibrance: 0, temperature: 0, hue: 0,
};

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
  for (const k in ADJUST_DEFAULTS) if ((params[k] ?? 0) !== ADJUST_DEFAULTS[k]) return false;
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


