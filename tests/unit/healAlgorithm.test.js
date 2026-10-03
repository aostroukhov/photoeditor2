import { describe, it, expect } from 'vitest';
import { applyHealingBrush, rasterizeStrokes, findComponents } from '../../healAlgorithm.js';

/** Белый холст w×h с чёрным квадратом дефекта. */
function canvasWithDefect(w, h, dx, dy, ds) {
  const data = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = dy; y < dy + ds; y++) for (let x = dx; x < dx + ds; x++) {
    const i = (y * w + x) * 4; data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
  }
  return data;
}
const px = (data, w, x, y) => Array.from(data.slice((y * w + x) * 4, (y * w + x) * 4 + 3));

describe('rasterizeStrokes / findComponents', () => {
  it('два далёких мазка → две компоненты, bbox ограничен мазками', () => {
    const { mask, bbX0, bbY0, bbX1, bbY1 } = rasterizeStrokes([{ cx: 10, cy: 10, r: 3 }, { cx: 50, cy: 50, r: 3 }], 64, 64);
    expect([bbX0, bbY0, bbX1, bbY1]).toEqual([7, 7, 53, 53]);
    expect(findComponents(mask, 64, 64, bbX0, bbY0, bbX1, bbY1)).toHaveLength(2);
  });
  it('перекрывающиеся мазки → одна компонента', () => {
    const { mask, bbX0, bbY0, bbX1, bbY1 } = rasterizeStrokes([{ cx: 10, cy: 10, r: 4 }, { cx: 14, cy: 10, r: 4 }], 64, 64);
    expect(findComponents(mask, 64, 64, bbX0, bbY0, bbX1, bbY1)).toHaveLength(1);
  });
  it('мазок за пределами кадра не ломает маску', () => {
    const r = rasterizeStrokes([{ cx: -50, cy: -50, r: 3 }], 64, 64);
    expect(findComponents(r.mask, 64, 64, r.bbX0, r.bbY0, r.bbX1, r.bbY1)).toHaveLength(0);
  });
});

describe('applyHealingBrush', () => {
  it('убирает дефект на однородном фоне и не трогает остальное', () => {
    const w = 96, h = 96;
    const data = canvasWithDefect(w, h, 43, 43, 10);
    const n = applyHealingBrush(data, w, h, [{ cx: 48, cy: 48, r: 9 }]);
    expect(n).toBe(1);
    const center = px(data, w, 48, 48);
    expect(center[0]).toBeGreaterThan(240);
    expect(px(data, w, 5, 5)).toEqual([255, 255, 255]);
    expect(px(data, w, 48, 70)).toEqual([255, 255, 255]);
  });

  it('работает у самого края изображения', () => {
    const w = 64, h = 64;
    const data = canvasWithDefect(w, h, 0, 0, 6);
    expect(() => applyHealingBrush(data, w, h, [{ cx: 2, cy: 2, r: 6 }])).not.toThrow();
    expect(px(data, w, 1, 1)[0]).toBeGreaterThan(200);
  });

  it('без мазков — ничего не делает', () => {
    const data = canvasWithDefect(16, 16, 4, 4, 4);
    expect(applyHealingBrush(data, 16, 16, [])).toBe(0);
    expect(px(data, 16, 5, 5)).toEqual([0, 0, 0]);
  });
});
