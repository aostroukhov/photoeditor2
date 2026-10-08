import { describe, it, expect } from 'vitest';
import { recognizeShape, isStraightLine, makeArrow, countCorners } from '../../DrawTool.js';

function polyline(corners, perSide) {
  const pts = [{ ...corners[0] }];
  for (let s = 0; s < corners.length - 1; s++) for (let i = 1; i <= perSide; i++) {
    const t = i / perSide;
    pts.push({ x: corners[s].x + (corners[s + 1].x - corners[s].x) * t, y: corners[s].y + (corners[s + 1].y - corners[s].y) * t });
  }
  return pts;
}
const rect   = (n) => polyline([{ x: 300, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 180 }, { x: 300, y: 180 }, { x: 300, y: 100 }], n);
const square = (n) => polyline([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 0, y: 0 }], n);
const circle = (n, rx = 60, ry = 60) => Array.from({ length: n + 1 }, (_, i) => ({ x: 200 + rx * Math.cos(i / n * 2 * Math.PI), y: 200 + ry * Math.sin(i / n * 2 * Math.PI) }));

describe('recognizeShape', () => {
  for (const n of [4, 5, 6, 8, 10, 15, 25]) {
    it(`прямоугольник, ${n} точек на сторону → rect`, () => {
      expect(recognizeShape(rect(n))?.shape).toBe('rect');
      expect(recognizeShape(rect(n)).points).toHaveLength(5);
    });
  }
  it('квадрат → square', () => expect(recognizeShape(square(8))?.shape).toBe('square'));
  it('окружность → circle', () => expect(recognizeShape(circle(48))?.shape).toBe('circle'));
  it('эллипс → ellipse', () => expect(recognizeShape(circle(48, 90, 40))?.shape).toBe('ellipse'));
  it('незамкнутый штрих → null', () => {
    expect(recognizeShape(polyline([{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 180, y: 90 }], 10))).toBeNull();
  });
  it('слишком мало точек → null', () => expect(recognizeShape(rect(1))).toBeNull());
});

describe('countCorners', () => {
  it('у прямоугольника 3–4 угла, у окружности 0', () => {
    expect(countCorners(rect(6))).toBeGreaterThanOrEqual(3);
    expect(countCorners(circle(48))).toBe(0);
  });
});

describe('isStraightLine / makeArrow', () => {
  it('прямая распознаётся, стрелка — 5 точек', () => {
    const pts = polyline([{ x: 0, y: 0 }, { x: 200, y: 30 }], 12);
    expect(isStraightLine(pts)).toBe(true);
    expect(makeArrow(pts).points).toHaveLength(5);
  });
  it('дуга — не прямая', () => expect(isStraightLine(circle(24).slice(0, 12))).toBe(false));
});
