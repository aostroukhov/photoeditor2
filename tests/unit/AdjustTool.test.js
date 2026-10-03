import { describe, it, expect } from 'vitest';
import { applyAdjustments, rgbToHsl, hslToRgb } from '../../AdjustTool.js';
import { EditorConfig } from '../../EditorConfig.js';

const px = (r, g, b) => ({ data: new Uint8ClampedArray([r, g, b, 255]), width: 1, height: 1 });
const run = (rgb, params) => {
  const id = px(...rgb);
  applyAdjustments(id, { ...EditorConfig.adjust.defaults, ...params });
  return [...id.data.slice(0, 3)];
};

describe('rgbToHsl / hslToRgb', () => {
  it('обратимы для насыщенного цвета', () => {
    const [h, s, l] = rgbToHsl(200, 30, 60);
    expect(hslToRgb(h, s, l)).toEqual([200, 30, 60]);
  });
  it('серый имеет s = 0', () => {
    expect(rgbToHsl(128, 128, 128)[1]).toBe(0);
  });
});

describe('applyAdjustments', () => {
  it('нулевые параметры не меняют пиксель', () => {
    expect(run([10, 120, 230], {})).toEqual([10, 120, 230]);
  });

  it('насыщенность не окрашивает нейтральные (серые) пиксели', () => {
    expect(run([128, 128, 128], { saturation: 50 })).toEqual([128, 128, 128]);
    expect(run([128, 128, 128], { vibrance: 50 })).toEqual([128, 128, 128]);
    expect(run([255, 255, 255], { saturation: 100 })).toEqual([255, 255, 255]);
  });

  it('насыщенность +100 усиливает цвет, −100 даёт серый', () => {
    const [r, g, b] = run([200, 100, 100], { saturation: -100 });
    expect(r).toBe(g); expect(g).toBe(b);
    const sat = run([200, 100, 100], { saturation: 100 });
    expect(sat[0] - sat[1]).toBeGreaterThan(100);
  });

  it('экспозиция +100 осветляет, −100 затемняет', () => {
    expect(run([100, 100, 100], { exposure: 100 })[0]).toBeGreaterThan(100);
    expect(run([100, 100, 100], { exposure: -100 })[0]).toBeLessThan(100);
  });

  it('сдвиг тона на 360° — тождество', () => {
    const out = run([200, 50, 80], { hue: 360 });
    expect(Math.abs(out[0] - 200)).toBeLessThanOrEqual(1);
  });
});
