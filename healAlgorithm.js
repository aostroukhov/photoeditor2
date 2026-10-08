/**
 * Алгоритм восстанавливающей кисти (чистые функции, без DOM).
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Архитектура: пиксельная маска + BFS связные компоненты
 * ──────────────────────────────────────────────────────────────────────────────
 *
 *  1. МАСКА      — мазки растеризуются в бинарную пиксельную маску.
 *  2. КОМПОНЕНТЫ — BFS разбивает маску на несвязные компоненты (острова).
 *                  Длинная царапина → одна тонкая компонента, не круг.
 *  3. ПАТЧ       — для каждой компоненты stride-поиск лучшего смещения
 *                  (offX, offY) по MSE граничных пикселей. Источник не
 *                  перекрывает маску.
 *  4. КОРРЕКЦИЯ  — на граничных пикселях вычисляется dst − src; каждый
 *                  внутренний пиксель наследует поправку ближайшего граничного.
 *  5. ФЕЗЕРИНГ   — BFS distance transform внутри компоненты:
 *                  result(p) = src(p+off) + correction × w(dist_to_edge),
 *                  w квадратично убывает к 0 в глубине (нет шва).
 *
 *  Все рабочие массивы шага 4–5 выделяются в окне bbox компоненты (+1 px),
 *  а не на весь кадр: для 12 Мп это разница между ~200 МБ и килобайтами
 *  на каждую компоненту.
 *
 *  Модуль не трогает DOM и может выполняться в Web Worker.
 */

const DIRS4 = [[-1, 0], [1, 0], [0, -1], [0, 1]];

/** Параметры по умолчанию (дублируют EditorConfig.heal, чтобы модуль был автономен). */
export const HEAL_DEFAULTS = {
  featherFraction:   0.4,
  defaultSearchMult: 4,
};

// ─── Step 1: растеризация мазков в пиксельную маску ──────────────────────────

/**
 * Растеризует массив мазков [{cx,cy,r}] в бинарную маску (Uint8Array iw×ih).
 * @returns {{ mask: Uint8Array, bbX0: number, bbY0: number, bbX1: number, bbY1: number }}
 */
export function rasterizeStrokes(strokes, iw, ih) {
  const mask = new Uint8Array(iw * ih);
  let bbX0 = iw, bbY0 = ih, bbX1 = -1, bbY1 = -1;

  for (const s of strokes) {
    const cx = s.cx, cy = s.cy, r = s.r;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(iw - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(ih - 1, Math.ceil(cy + r));
    if (x0 > x1 || y0 > y1) continue;

    for (let y = y0; y <= y1; y++) {
      const dy2 = (y - cy) * (y - cy);
      for (let x = x0; x <= x1; x++) {
        if ((x - cx) * (x - cx) + dy2 <= r2) mask[y * iw + x] = 1;
      }
    }

    bbX0 = Math.min(bbX0, x0); bbY0 = Math.min(bbY0, y0);
    bbX1 = Math.max(bbX1, x1); bbY1 = Math.max(bbY1, y1);
  }

  if (bbX1 < 0) { bbX0 = 0; bbY0 = 0; bbX1 = -1; bbY1 = -1; }
  return { mask, bbX0, bbY0, bbX1, bbY1 };
}

// ─── Step 2: BFS связные компоненты ──────────────────────────────────────────

/**
 * Разбивает маску на несвязные компоненты (4-связность).
 * @returns {Array<{ indices: number[], x0, y0, x1, y1 }>}  indices — глобальные
 *          индексы пикселей (i = y*iw + x), x0..y1 — bbox компоненты.
 */
export function findComponents(mask, iw, ih, bbX0, bbY0, bbX1, bbY1) {
  const components = [];
  if (bbX1 < bbX0 || bbY1 < bbY0) return components;

  // visited — только в пределах общего bbox всех мазков
  const bw = bbX1 - bbX0 + 1, bh = bbY1 - bbY0 + 1;
  const visited = new Uint8Array(bw * bh);
  const vIdx = (x, y) => (y - bbY0) * bw + (x - bbX0);

  for (let y = bbY0; y <= bbY1; y++) {
    for (let x = bbX0; x <= bbX1; x++) {
      const i = y * iw + x;
      if (!mask[i] || visited[vIdx(x, y)]) continue;

      const queue   = [i];
      const indices = [];
      let qi = 0;
      let cx0 = x, cy0 = y, cx1 = x, cy1 = y;
      visited[vIdx(x, y)] = 1;

      while (qi < queue.length) {
        const ci = queue[qi++];
        indices.push(ci);
        const cx = ci % iw, cy = (ci / iw) | 0;
        if (cx < cx0) cx0 = cx; if (cy < cy0) cy0 = cy;
        if (cx > cx1) cx1 = cx; if (cy > cy1) cy1 = cy;

        for (const [dx, dy] of DIRS4) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < bbX0 || nx > bbX1 || ny < bbY0 || ny > bbY1) continue;
          const ni = ny * iw + nx;
          const vi = vIdx(nx, ny);
          if (mask[ni] && !visited[vi]) { visited[vi] = 1; queue.push(ni); }
        }
      }

      components.push({ indices, x0: cx0, y0: cy0, x1: cx1, y1: cy1 });
    }
  }

  return components;
}

// ─── Step 3: поиск лучшего патча ─────────────────────────────────────────────

/**
 * Stride-поиск смещения источника по MSE выборки граничных пикселей.
 *
 *  • Покрытие — доля граничных пикселей, у которых источник попадает в кадр
 *    и не в маску; кандидаты с покрытием < minCoverage отклоняются.
 *  • Ошибка нормируется с штрафом за неполное покрытие, чтобы частично
 *    выходящие за край смещения не выигрывали за счёт малого cnt.
 *  • Если ничего не найдено — повтор без порога покрытия.
 */
export function findBestOffset(data, iw, ih, mask, boundary, searchMult = HEAL_DEFAULTS.defaultSearchMult) {
  if (!boundary.length) return { offX: 8, offY: 0 };

  const estR       = Math.max(4, Math.sqrt(boundary.length / Math.PI));
  // Минимальный радиус поиска масштабируется с размером изображения:
  // при нативном разрешении 60px — слишком мало.
  const minSearchR = Math.max(40, Math.round(Math.min(iw, ih) / 10));
  const searchR    = Math.min(Math.max(estR * searchMult, minSearchR), Math.min(iw, ih) / 2);
  const minOff     = Math.max(estR * 1.1, 4);
  const stride     = Math.max(1, Math.round(searchR / 40));

  // Выборка граничных пикселей (≤80 шт. для скорости)
  const step    = Math.max(1, (boundary.length / 80) | 0);
  const sampled = [];
  for (let bi = 0; bi < boundary.length; bi += step) sampled.push(boundary[bi]);
  const sLen = sampled.length;

  const scan = (minCoverage) => {
    let bestDx = 0, bestDy = 0, bestScore = Infinity, found = false;
    for (let dy = -searchR; dy <= searchR; dy += stride) {
      for (let dx = -searchR; dx <= searchR; dx += stride) {
        const d = Math.hypot(dx, dy);
        if (d < minOff || d > searchR) continue;

        let err = 0, cnt = 0;
        for (const i of sampled) {
          const bx = i % iw, by = (i / iw) | 0;
          const sx = bx + dx, sy = by + dy;
          if (sx < 0 || sy < 0 || sx >= iw || sy >= ih) continue;
          if (mask[sy * iw + sx]) continue;            // источник в маске — плохой кандидат
          const si = (sy * iw + sx) * 4;
          const dr = data[i * 4]     - data[si];
          const dg = data[i * 4 + 1] - data[si + 1];
          const db = data[i * 4 + 2] - data[si + 2];
          err += dr * dr + dg * dg + db * db;
          cnt++;
        }
        if (!cnt) continue;
        const coverage = cnt / sLen;
        if (coverage < minCoverage) continue;
        const score = (err / cnt) / (coverage * coverage);
        if (score < bestScore) { bestScore = score; bestDx = dx; bestDy = dy; found = true; }
      }
    }
    return found ? { offX: bestDx, offY: bestDy } : null;
  };

  return scan(0.55) ?? scan(0) ?? { offX: 0, offY: Math.round(estR * 1.5) + 4 };
}

// ─── Step 4+5: distance transform, коррекция, фезеринг (в окне компоненты) ───

/**
 * Лечит одну компоненту. Все рабочие массивы — в окне bbox компоненты + 1 px.
 */
function healComponent(data, iw, ih, mask, comp, searchMult, featherFraction) {
  const x0 = Math.max(0, comp.x0 - 1), y0 = Math.max(0, comp.y0 - 1);
  const x1 = Math.min(iw - 1, comp.x1 + 1), y1 = Math.min(ih - 1, comp.y1 + 1);
  const lw = x1 - x0 + 1, lh = y1 - y0 + 1;
  const toLocal = (gi) => (((gi / iw) | 0) - y0) * lw + ((gi % iw) - x0);

  const dist    = new Int16Array(lw * lh).fill(-1);
  const nearest = new Int32Array(lw * lh).fill(-1);   // локальный индекс ближайшего граничного px
  const boundary = [];                                // глобальные индексы граничных пикселей

  // Граничные пиксели (dist = 0, nearest = self): соседствуют с НЕ-масочным
  // пикселем внутри кадра. Край изображения границей не считается — иначе
  // пиксели дефекта у края становились «эталоном» для цветокоррекции.
  for (const i of comp.indices) {
    const cx = i % iw, cy = (i / iw) | 0;
    let isBound = false;
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx >= iw || ny < 0 || ny >= ih) continue;
      if (!mask[ny * iw + nx]) { isBound = true; break; }
    }
    if (isBound) { const li = toLocal(i); dist[li] = 0; nearest[li] = li; boundary.push(i); }
  }
  if (!boundary.length) return;   // маска накрыла весь кадр — лечить нечем

  // BFS вглубь маски: dist и nearest
  const queue = boundary.slice();
  let qi = 0, maxDist = 1;
  while (qi < queue.length) {
    const i  = queue[qi++];
    const li = toLocal(i);
    const cx = i % iw, cy = (i / iw) | 0;
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
      const ni = ny * iw + nx;
      if (!mask[ni]) continue;
      const nli = toLocal(ni);
      if (dist[nli] >= 0) continue;
      dist[nli]    = dist[li] + 1;
      nearest[nli] = nearest[li];
      if (dist[nli] > maxDist) maxDist = dist[nli];
      queue.push(ni);
    }
  }

  const { offX, offY } = findBestOffset(data, iw, ih, mask, boundary, searchMult);

  // Локальная коррекция и валидный источник для каждого граничного пикселя
  const corrR  = new Float32Array(lw * lh);
  const corrG  = new Float32Array(lw * lh);
  const corrB  = new Float32Array(lw * lh);
  const srcIdx = new Int32Array(lw * lh).fill(-1);   // глобальный индекс источника граничного px
  for (const i of boundary) {
    const bx = i % iw, by = (i / iw) | 0;
    const sx = bx + offX, sy = by + offY;
    if (sx < 0 || sy < 0 || sx >= iw || sy >= ih) continue;
    const sgi = sy * iw + sx;
    if (mask[sgi]) continue;
    const si = sgi * 4, li = toLocal(i);
    srcIdx[li] = sgi;
    corrR[li] = data[i * 4]     - data[si];
    corrG[li] = data[i * 4 + 1] - data[si + 1];
    corrB[li] = data[i * 4 + 2] - data[si + 2];
  }

  const estR     = Math.max(4, Math.sqrt(boundary.length / Math.PI));
  const featherR = Math.max(2, maxDist * featherFraction);

  for (const i of comp.indices) {
    const px = i % iw, py = (i / iw) | 0;
    const li = toLocal(i);

    const ni = nearest[li];
    const cR = ni >= 0 ? corrR[ni] : 0;
    const cG = ni >= 0 ? corrG[ni] : 0;
    const cB = ni >= 0 ? corrB[ni] : 0;

    // Источник пикселя. Если он вне кадра или сам лежит в маске (у края
    // изображения или при узком смещении) — берём источник ближайшего
    // граничного пикселя: он гарантированно валиден. Иначе в результат
    // попадали бы пиксели самого дефекта.
    const rawSx = px + offX, rawSy = py + offY;
    let si, oobFactor = 1;
    if (rawSx >= 0 && rawSy >= 0 && rawSx < iw && rawSy < ih && !mask[rawSy * iw + rawSx]) {
      si = (rawSy * iw + rawSx) * 4;
    } else if (ni >= 0 && srcIdx[ni] >= 0) {
      si = srcIdx[ni] * 4;
    } else {
      // Крайний случай: зажимаем к кадру и снижаем вес коррекции
      const sx = rawSx < 0 ? 0 : rawSx >= iw ? iw - 1 : rawSx;
      const sy = rawSy < 0 ? 0 : rawSy >= ih ? ih - 1 : rawSy;
      si = (sy * iw + sx) * 4;
      oobFactor = Math.max(0, 1 - Math.hypot(rawSx - sx, rawSy - sy) / (estR + 1));
    }

    const d = dist[li];
    const t = d >= featherR ? 0 : 1 - d / featherR;
    const w = t * t * oobFactor;

    data[i * 4]     = clamp(data[si]     + cR * w);
    data[i * 4 + 1] = clamp(data[si + 1] + cG * w);
    data[i * 4 + 2] = clamp(data[si + 2] + cB * w);
  }
}

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0; }

// ─── Публичная точка входа ────────────────────────────────────────────────────

/**
 * Применяет healing к области, заданной мазками. Изменяет data in-place.
 *
 * @param {Uint8ClampedArray} data   RGBA-пиксели (ImageData.data)
 * @param {number} iw
 * @param {number} ih
 * @param {Array<{cx:number, cy:number, r:number}>} strokes  в пикселях этого холста
 * @param {{ searchMult?: number, featherFraction?: number }} [opts]
 * @returns {number} число обработанных компонент
 */
export function applyHealingBrush(data, iw, ih, strokes, opts = {}) {
  if (!strokes?.length) return 0;
  const searchMult      = opts.searchMult      ?? HEAL_DEFAULTS.defaultSearchMult;
  const featherFraction = opts.featherFraction ?? HEAL_DEFAULTS.featherFraction;

  const { mask, bbX0, bbY0, bbX1, bbY1 } = rasterizeStrokes(strokes, iw, ih);
  const components = findComponents(mask, iw, ih, bbX0, bbY0, bbX1, bbY1);
  for (const comp of components) healComponent(data, iw, ih, mask, comp, searchMult, featherFraction);
  return components.length;
}
