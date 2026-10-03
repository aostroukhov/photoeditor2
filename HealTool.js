/**
 * HealTool v3.0 — Точечная восстанавливающая кисть
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Архитектура: пиксельная маска + BFS связные компоненты
 * ──────────────────────────────────────────────────────────────────────────────
 *
 *  Вместо объединения мазков в круги алгоритм работает с реальной формой
 *  нарисованной области:
 *
 *  1. МАСКА     — все мазки растеризуются в бинарную пиксельную маску.
 *
 *  2. КОМПОНЕНТЫ — BFS разбивает маску на несвязные компоненты (острова).
 *                  Длинная царапина → одна тонкая компонента, не круг.
 *                  Две отдельные точки → две независимых компоненты.
 *
 *  3. ПАТЧ      — для каждой компоненты stride-поиск лучшего смещения
 *                 (offX, offY) по MSE граничных пикселей. Источник не
 *                 перекрывает маску.
 *
 *  4. КОРРЕКЦИЯ — на граничных пикселях вычисляется mean(dst − src).
 *                 Поправка устраняет тональное расхождение патча с фоном.
 *
 *  5. ФЕЗЕРИНГ  — BFS distance transform внутри компоненты.
 *                 result(p) = src(p+off) + correction × w(dist_to_edge)
 *                 w квадратично убывает к 0 в глубине (нет шва).
 *
 *  Предпросмотр: после mouseup — автоматически в display-разрешении.
 *  Применить:    пересчёт в нативном разрешении.
 *  localStorage: brushSize, searchMult.
 */

import { EditorConfig } from './EditorConfig.js';
import { isEditableTarget } from './utils.js';

const CFG    = EditorConfig.heal;
const LS_KEY = CFG.storageKey;
const DIRS4  = [[-1, 0], [1, 0], [0, -1], [0, 1]];

// ─── localStorage ─────────────────────────────────────────────────────────────

function loadSettings() {
  try { const s = localStorage.getItem(LS_KEY); return s ? JSON.parse(s) : {}; }
  catch { return {}; }
}
function saveSettings(obj) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(obj)); } catch { /* ignore */ }
}

// ─── Canvas helpers ───────────────────────────────────────────────────────────

function imgToCanvas(img) {
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth; cv.height = img.naturalHeight;
  cv.getContext('2d').drawImage(img, 0, 0);
  return cv;
}

function imgToCanvasScaled(img, w, h) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(img, 0, 0, w, h);
  return cv;
}

// ─── Step 1: растеризация мазков в пиксельную маску ──────────────────────────

/**
 * Растеризует массив мазков [{cx,cy,r}] в бинарную маску (Uint8Array).
 * Возвращает маску и общий bounding box всех мазков.
 */
function rasterizeStrokes(strokes, iw, ih) {
  const mask = new Uint8Array(iw * ih);
  let bbX0 = iw, bbY0 = ih, bbX1 = 0, bbY1 = 0;

  for (const s of strokes) {
    const cx = s.cx, cy = s.cy, r = s.r;
    const r2 = r * r;
    const x0 = Math.max(0, Math.floor(cx - r));
    const x1 = Math.min(iw - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r));
    const y1 = Math.min(ih - 1, Math.ceil(cy + r));

    for (let y = y0; y <= y1; y++) {
      const dy2 = (y - cy) * (y - cy);
      for (let x = x0; x <= x1; x++) {
        if ((x - cx) * (x - cx) + dy2 <= r2) mask[y * iw + x] = 1;
      }
    }

    bbX0 = Math.min(bbX0, x0); bbY0 = Math.min(bbY0, y0);
    bbX1 = Math.max(bbX1, x1); bbY1 = Math.max(bbY1, y1);
  }

  bbX0 = Math.max(0, bbX0); bbY0 = Math.max(0, bbY0);
  bbX1 = Math.min(iw - 1, bbX1); bbY1 = Math.min(ih - 1, bbY1);

  return { mask, bbX0, bbY0, bbX1, bbY1 };
}

// ─── Step 2: BFS связные компоненты ──────────────────────────────────────────

/**
 * Разбивает маску на несвязные компоненты.
 * Возвращает массив компонент [{indices, x0,y0,x1,y1}].
 * indices — пиксельные индексы (i = y*iw+x) пикселей компоненты.
 */
function findComponents(mask, iw, ih, bbX0, bbY0, bbX1, bbY1) {
  const visited    = new Uint8Array(iw * ih);
  const components = [];

  for (let y = bbY0; y <= bbY1; y++) {
    for (let x = bbX0; x <= bbX1; x++) {
      const i = y * iw + x;
      if (!mask[i] || visited[i]) continue;

      // BFS новой компоненты
      const queue   = [i];
      const indices = [];
      let qi = 0;
      let cx0 = x, cy0 = y, cx1 = x, cy1 = y;

      while (qi < queue.length) {
        const ci = queue[qi++];
        if (visited[ci]) continue;
        visited[ci] = 1;
        indices.push(ci);
        const cx = ci % iw, cy = (ci / iw) | 0;
        cx0 = Math.min(cx0, cx); cy0 = Math.min(cy0, cy);
        cx1 = Math.max(cx1, cx); cy1 = Math.max(cy1, cy);

        for (const [dx, dy] of DIRS4) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || nx >= iw || ny < 0 || ny >= ih) continue;
          const ni = ny * iw + nx;
          if (mask[ni] && !visited[ni]) queue.push(ni);
        }
      }

      if (indices.length) components.push({ indices, x0: cx0, y0: cy0, x1: cx1, y1: cy1 });
    }
  }

  return components;
}

// ─── Step 3+4: BFS distance transform + patch search + feathered copy ────────

/**
 * BFS distance transform: dist[i] = расстояние до ближайшего не-масочного px.
 * Возвращает { dist, boundary } — массив boundary-индексов (dist=0).
 */
/**
 * BFS distance transform с отслеживанием ближайшего граничного пикселя.
 *
 * nearest[i] — индекс ближайшего boundary-пикселя для каждого px маски.
 * Используется для пространственно-переменной цветокоррекции:
 * каждый внутренний пиксель наследует поправку своего ближайшего соседа
 * на границе, что устраняет ореол на цветных фонах.
 */
function bfsDistanceForComponent(mask, iw, ih, component) {
  const { indices } = component;
  const count    = iw * ih;
  const dist     = new Int16Array(count).fill(-1);
  const nearest  = new Int32Array(count).fill(-1);
  const boundary = [];

  // Граничные пиксели (dist = 0, nearest = self)
  for (const i of indices) {
    const cx = i % iw, cy = (i / iw) | 0;
    let isBound = false;
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx >= iw || ny < 0 || ny >= ih || !mask[ny * iw + nx]) {
        isBound = true; break;
      }
    }
    if (isBound) { dist[i] = 0; nearest[i] = i; boundary.push(i); }
  }

  // BFS: распространяем dist и nearest вглубь маски
  const queue = boundary.slice();
  let qi = 0;
  while (qi < queue.length) {
    const i  = queue[qi++];
    const cx = i % iw, cy = (i / iw) | 0;
    for (const [dx, dy] of DIRS4) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || nx >= iw || ny < 0 || ny >= ih) continue;
      const ni = ny * iw + nx;
      if (!mask[ni] || dist[ni] >= 0) continue;
      dist[ni]    = dist[i] + 1;
      nearest[ni] = nearest[i]; // наследуем ближайший граничный пиксель
      queue.push(ni);
    }
  }

  let maxDist = 1;
  for (const i of indices) if (dist[i] > maxDist) maxDist = dist[i];

  return { dist, nearest, boundary, maxDist };
}

/**
 * Stride-поиск лучшего патча по граничным пикселям.
 * Источник не перекрывает маску.
 */
/**
 * Поиск лучшего патча-источника.
 *
 * Ключевые улучшения для работы у границ изображения:
 *  • Для каждого кандидата (dx,dy) подсчитываем покрытие — долю граничных
 *    пикселей, у которых источник попадает в изображение и не в маску.
 *  • Кандидаты с покрытием < MIN_COVERAGE отклоняются.
 *  • Ошибка нормируется с штрафом за неполное покрытие, поэтому частично
 *    выходящие за край смещения не выигрывают за счёт малого cnt.
 */
function findBestOffset(data, iw, ih, mask, boundary, searchMult) {
  if (!boundary.length) return { offX: 8, offY: 0 };

  const MIN_COVERAGE = 0.55; // минимальная доля граничных пикселей с валидным источником

  const estR    = Math.max(4, Math.sqrt(boundary.length / Math.PI));
  const mult    = searchMult ?? CFG.defaultSearchMult;
  // Минимальный радиус поиска масштабируется с размером изображения:
  // ~60px для display (~600px), ~300–400px для нативного (~3000–4000px).
  // Без этого при нативном разрешении 60px = 1.5% изображения — слишком мало.
  const minSearchR = Math.max(40, Math.round(Math.min(iw, ih) / 10));
  const searchR = Math.min(Math.max(estR * mult, minSearchR), Math.min(iw, ih) / 2);
  const minOff  = Math.max(estR * 1.1, 4);
  const stride  = Math.max(1, Math.round(searchR / 40));

  // Выборка граничных пикселей (≤80 шт. для скорости)
  const step     = Math.max(1, (boundary.length / 80) | 0);
  const sampled  = [];
  for (let bi = 0; bi < boundary.length; bi += step) sampled.push(boundary[bi]);
  const sLen = sampled.length;

  let bestDx = 0, bestDy = 0, bestScore = Infinity, hasBest = false;

  // Перебираем кандидатов; предпочитаем направления внутрь изображения
  for (let dy = -searchR; dy <= searchR; dy += stride) {
    for (let dx = -searchR; dx <= searchR; dx += stride) {
      const d = Math.hypot(dx, dy);
      if (d < minOff || d > searchR) continue;

      let err = 0, cnt = 0;

      for (const i of sampled) {
        const bx = i % iw, by = (i / iw) | 0;
        const sx = bx + dx, sy = by + dy;
        if (sx < 0 || sy < 0 || sx >= iw || sy >= ih) continue;
        if (mask[sy * iw + sx]) continue; // источник в маске — плохой кандидат
        const si = (sy * iw + sx) * 4;
        const dr = data[i * 4]     - data[si];
        const dg = data[i * 4 + 1] - data[si + 1];
        const db = data[i * 4 + 2] - data[si + 2];
        err += dr * dr + dg * dg + db * db;
        cnt++;
      }

      if (!cnt) continue;
      const coverage = cnt / sLen;
      if (coverage < MIN_COVERAGE) continue; // недостаточно валидных пикселей

      // Штраф за неполное покрытие: делим на coverage², чтобы частично OOB
      // кандидаты имели более высокую нормированную ошибку
      const score = (err / cnt) / (coverage * coverage);
      if (score < bestScore) { bestScore = score; bestDx = dx; bestDy = dy; hasBest = true; }
    }
  }

  // Если ничего не нашли (очень маленький участок у самого края) —
  // пробуем снова с пониженным порогом покрытия
  if (!hasBest) {
    for (let dy = -searchR; dy <= searchR; dy += stride) {
      for (let dx = -searchR; dx <= searchR; dx += stride) {
        const d = Math.hypot(dx, dy);
        if (d < minOff || d > searchR) continue;
        let err = 0, cnt = 0;
        for (const i of sampled) {
          const bx = i % iw, by = (i / iw) | 0;
          const sx = bx + dx, sy = by + dy;
          if (sx < 0 || sy < 0 || sx >= iw || sy >= ih) continue;
          if (mask[sy * iw + sx]) continue;
          const si = (sy * iw + sx) * 4;
          const dr = data[i * 4]     - data[si];
          const dg = data[i * 4 + 1] - data[si + 1];
          const db = data[i * 4 + 2] - data[si + 2];
          err += dr * dr + dg * dg + db * db;
          cnt++;
        }
        if (!cnt) continue;
        const score = err / cnt;
        if (score < bestScore) { bestScore = score; bestDx = dx; bestDy = dy; hasBest = true; }
      }
    }
  }

  return hasBest ? { offX: bestDx, offY: bestDy } : { offX: 0, offY: Math.round(estR * 1.5) + 4 };
}

/**
 * Копирует патч в компоненту с пространственно-переменной цветокоррекцией.
 *
 * Вместо одной усреднённой поправки для всей области каждый пиксель
 * использует коррекцию своего БЛИЖАЙШЕГО граничного пикселя (из nearest[]).
 *
 * Это устраняет ореол на цветных и неоднородных фонах: граница плавно
 * совпадает с окружением в каждой точке, а не "в среднем по области".
 */
function featheredPatchCopy(data, iw, ih, component, dist, nearest, boundary, maxDist, offX, offY) {
  // Оцениваем радиус компоненты — нужен для плавного снижения веса у края
  const estR = Math.max(4, Math.sqrt(boundary.length / Math.PI));

  // Предвычисляем локальную коррекцию для каждого boundary-пикселя
  const corrR = new Float32Array(iw * ih);
  const corrG = new Float32Array(iw * ih);
  const corrB = new Float32Array(iw * ih);

  for (const i of boundary) {
    const bx = i % iw, by = (i / iw) | 0;
    const sx = bx + offX, sy = by + offY;
    if (sx < 0 || sy < 0 || sx >= iw || sy >= ih) continue;
    const si = (sy * iw + sx) * 4;
    corrR[i] = data[i * 4]     - data[si];
    corrG[i] = data[i * 4 + 1] - data[si + 1];
    corrB[i] = data[i * 4 + 2] - data[si + 2];
  }

  const featherR = Math.max(2, maxDist * CFG.featherFraction);

  for (const i of component.indices) {
    const px = i % iw, py = (i / iw) | 0;

    // Клампим источник к границам изображения (зеркальное отражение у края).
    // Это лучше, чем пропускать пиксели: не оставляет «дыр» из оригинальных
    // дефектных пикселей, которые потом смешиваются в артефакт.
    const rawSx = px + offX, rawSy = py + offY;
    const sx = Math.max(0, Math.min(iw - 1, rawSx));
    const sy = Math.max(0, Math.min(ih - 1, rawSy));
    const si = (sy * iw + sx) * 4;

    // Коррекция ближайшего граничного пикселя
    const ni = nearest[i];
    const cR = ni >= 0 ? corrR[ni] : 0;
    const cG = ni >= 0 ? corrG[ni] : 0;
    const cB = ni >= 0 ? corrB[ni] : 0;

    // Для пикселей, чей источник был зажат к краю изображения,
    // плавно снижаем вес коррекции чтобы не размазывать граничные пиксели
    const oobFactor = (rawSx === sx && rawSy === sy) ? 1
      : Math.max(0, 1 - Math.hypot(rawSx - sx, rawSy - sy) / (estR + 1));

    const d = dist[i];
    const t = d >= featherR ? 0 : 1 - d / featherR;
    const w = t * t * oobFactor;

    data[i * 4]     = clamp(data[si]     + cR * w);
    data[i * 4 + 1] = clamp(data[si + 1] + cG * w);
    data[i * 4 + 2] = clamp(data[si + 2] + cB * w);
  }
}

function clamp(v) { return v < 0 ? 0 : v > 255 ? 255 : v + 0.5 | 0; }

// ─── Публичная точка входа ────────────────────────────────────────────────────

/**
 * Применяет healing к пиксельной маске.
 *
 * @param {ImageData} imgData    — RGBA, будет изменено
 * @param {number}    iw, ih     — размеры
 * @param {Array}     strokes    — [{cx,cy,r}] в пикселях этого холста
 * @param {number}    searchMult — множитель радиуса поиска
 */
function applyHealingBrush(imgData, iw, ih, strokes, searchMult) {
  if (!strokes.length) return;
  const data = imgData.data;

  const { mask, bbX0, bbY0, bbX1, bbY1 } = rasterizeStrokes(strokes, iw, ih);
  const components = findComponents(mask, iw, ih, bbX0, bbY0, bbX1, bbY1);

  for (const comp of components) {
    const { dist, nearest, boundary, maxDist } = bfsDistanceForComponent(mask, iw, ih, comp);
    const { offX, offY }                         = findBestOffset(data, iw, ih, mask, boundary, searchMult);
    featheredPatchCopy(data, iw, ih, comp, dist, nearest, boundary, maxDist, offX, offY);
  }
}

// ─── HealTool ─────────────────────────────────────────────────────────────────

export class HealTool {

  constructor(photoEditor) {
    this.photoEditor = photoEditor;

    this.isActive    = false;
    this.isSuspended = false;
    this._stopping   = false;
    this._suspending = false;

    // Canvas: накопленная маска кисти (offscreen, solid, без альфа-наслоений)
    this._maskCanvas = null;
    this._maskCtx    = null;
    // Canvas overlay: курсор + composited маска поверх изображения
    this.overlayCanvas = null;
    this.overlayCtx    = null;
    // Canvas preview: отображает healed-результат
    this._previewCanvas = null;
    this._previewCtx    = null;

    // Параметры
    const saved       = loadSettings();
    this.brushSize    = clamp255(CFG.minBrushSize, CFG.maxBrushSize,
                                 saved.brushSize ?? CFG.defaultBrushSize);
    this.searchMult   = clampF(CFG.minSearchMult, CFG.maxSearchMult,
                               saved.searchMult ?? CFG.defaultSearchMult);

    // Мазки [{cx,cy,r}] в display-координатах
    this._strokes   = [];
    this._painting  = false;
    this._lastPoint = null;

    this._previewDebounceId = null;
    this._hasPreview   = false;

    this._panel = null;

    this._cursorX       = -9999;
    this._cursorY       = -9999;
    this._cursorVisible = false;

    this._onMouseDown  = this._onMouseDown.bind(this);
    this._onMouseMove  = this._onMouseMove.bind(this);
    this._onMouseUp    = this._onMouseUp.bind(this);
    this._onMouseLeave = this._onMouseLeave.bind(this);
    this._onTouchStart = this._onTouchStart.bind(this);
    this._onTouchMove  = this._onTouchMove.bind(this);
    this._onTouchEnd   = this._onTouchEnd.bind(this);
    this._onKeyDown    = this._onKeyDown.bind(this);
    this._onWinResize  = this._onWinResize.bind(this);
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
    this._strokes    = [];
    this._hasPreview = false;
    this._clearMask();

    this._createCanvases();
    this._showCanvases();
    this._createPanel();
    this._bindEvents();
    this._drawOverlay();
    this.photoEditor.syncToolButtons?.();
  }

  suspend() {
    if (!this.isActive || this.isSuspended) return;
    this._unbindEvents();
    this._painting = false; this._lastPoint = null; this._cursorVisible = false;
    if (this.overlayCanvas) {
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
      this.overlayCanvas.style.pointerEvents = 'none';
    }
    if (this._previewCanvas) this._previewCanvas.style.display = 'none';

    this._suspending = true;
    this.photoEditor.dialogs?.close('heal');
    this._suspending = false;

    this.isActive = false; this.isSuspended = true;
    this.photoEditor.activeTool = null;
    this.photoEditor.syncToolButtons?.();
  }

  cancel() {
    this._cancelPreviewRaf();
    this._strokes = []; this._hasPreview = false; this._painting = false;
    this._clearMask();
    this._destroyInternal();
  }

  apply() {
    this._cancelPreviewRaf();
    const pe  = this.photoEditor;
    const img = pe.img;

    if (!img || !this._strokes.length) { this._destroyInternal(); return; }

    const srcCanvas = imgToCanvas(img);
    const ctx       = srcCanvas.getContext('2d');
    const iw        = srcCanvas.width;
    const ih        = srcCanvas.height;
    const imgData   = ctx.getImageData(0, 0, iw, ih);

    const dispW  = pe.imgElement?.offsetWidth || img.naturalWidth;
    const scale  = img.naturalWidth / dispW;
    const native = this._strokes.map(s => ({
      cx: s.cx * scale, cy: s.cy * scale, r: Math.max(2, s.r * scale),
    }));

    applyHealingBrush(imgData, iw, ih, native, this.searchMult);
    ctx.putImageData(imgData, 0, 0);

    // Результат фиксируется только через commitImage (история, dirty-флаг).
    // Экспорт в источник — отдельное действие пользователя (ExportPanel / requestClose).
    const url    = srcCanvas.toDataURL('image/png');
    const newImg = new Image();
    newImg.onload  = () => { pe.commitImage(newImg); };
    newImg.onerror = () => console.error('[HealTool] apply(): не удалось декодировать результат');
    newImg.src = url;

    this._strokes = []; this._hasPreview = false;
    this._destroyInternal();
  }

  openSettings() { this.photoEditor.dialogs?.toggle('heal'); }

  destroy() {
    this._cancelPreviewRaf();
    this._strokes = []; this._hasPreview = false; this._painting = false;
    this._destroyInternal();
    this._previewCanvas?.remove(); this._previewCanvas = null; this._previewCtx  = null;
    this.overlayCanvas?.remove();  this.overlayCanvas  = null; this.overlayCtx   = null;
    this._maskCanvas = null; this._maskCtx = null;
  }

  _resume() {
    if (!this.isSuspended) return;
    const imgEl = this.photoEditor.imgElement;
    if (!imgEl?.naturalWidth) return;

    this.isActive = true; this.isSuspended = false;
    this.photoEditor.activeTool = this;

    if (this.overlayCanvas) this.overlayCanvas.style.pointerEvents = '';
    else                    this._createCanvases();
    this._showCanvases();
    if (this._hasPreview && this._previewCanvas) this._previewCanvas.style.display = '';
    if (this._panel) this.photoEditor.dialogs?.open('heal');
    else             this._createPanel();
    this._bindEvents();
    this._drawOverlay();
    this.photoEditor.syncToolButtons?.();
  }

  _destroyInternal() {
    if (this._stopping) return;
    this._stopping = true;
    this._unbindEvents();

    if (!this.isSuspended) {
      this._previewCanvas?.remove(); this._previewCanvas = null; this._previewCtx  = null;
      this.overlayCanvas?.remove();  this.overlayCanvas  = null; this.overlayCtx   = null;
    }

    const panel = this._panel; this._panel = null;
    if (panel) { this.photoEditor.dialogs?.unregister('heal'); panel.remove(); }

    this.isActive = false; this.isSuspended = false; this._stopping = false;
    this.photoEditor.activeTool = null;
    this.photoEditor.syncToolButtons?.();
  }

  _showCanvases() {
    if (this.overlayCanvas)  this.overlayCanvas.style.pointerEvents = '';
    if (this._previewCanvas) this._previewCanvas.style.pointerEvents = 'none';
  }

  // ─── Canvas ───────────────────────────────────────────────────────────────

  _createCanvases() {
    const imgEl  = this.photoEditor.imgElement;
    const w      = imgEl?.offsetWidth  || this.photoEditor.img?.naturalWidth  || 400;
    const h      = imgEl?.offsetHeight || this.photoEditor.img?.naturalHeight || 300;
    const parent = imgEl?.parentElement
      || this.photoEditor.container?.querySelector('.photoeditor__img-container');

    if (!this._maskCanvas) {
      this._maskCanvas = document.createElement('canvas');
      this._maskCanvas.width = w; this._maskCanvas.height = h;
      this._maskCtx = this._maskCanvas.getContext('2d');
    }

    if (!this._previewCanvas) {
      this._previewCanvas = document.createElement('canvas');
      this._previewCanvas.width = w; this._previewCanvas.height = h;
      this._previewCanvas.className = 'heal-tool__preview-canvas';
      Object.assign(this._previewCanvas.style, {
        position: 'absolute', top: '0', left: '0',
        width: '100%', height: '100%', pointerEvents: 'none', display: 'none',
      });
      this._previewCtx = this._previewCanvas.getContext('2d');
      parent?.appendChild(this._previewCanvas);
    }

    if (!this.overlayCanvas) {
      this.overlayCanvas = document.createElement('canvas');
      this.overlayCanvas.width = w; this.overlayCanvas.height = h;
      this.overlayCanvas.className = 'heal-tool__overlay-canvas';
      Object.assign(this.overlayCanvas.style, {
        position: 'absolute', top: '0', left: '0',
        width: '100%', height: '100%', cursor: 'none',
      });
      this.overlayCtx = this.overlayCanvas.getContext('2d');
      parent?.appendChild(this.overlayCanvas);
    }
  }

  _syncCanvasSize() {
    const imgEl = this.photoEditor.imgElement;
    if (!imgEl || !this.overlayCanvas) return;
    const nw = imgEl.offsetWidth || imgEl.width;
    const nh = imgEl.offsetHeight || imgEl.height;
    if (!nw || !nh || (this.overlayCanvas.width === nw && this.overlayCanvas.height === nh)) return;

    const kx = nw / this.overlayCanvas.width;
    const ky = nh / this.overlayCanvas.height;
    for (const s of this._strokes) { s.cx *= kx; s.cy *= ky; s.r *= (kx + ky) / 2; }

    // Масштабируем _maskCanvas с сохранением нарисованной области
    if (this._maskCanvas && this._strokes.length) {
      const tmp = document.createElement('canvas');
      tmp.width = nw; tmp.height = nh;
      tmp.getContext('2d').drawImage(this._maskCanvas, 0, 0, nw, nh);
      this._maskCanvas.width = nw; this._maskCanvas.height = nh;
      this._maskCtx.drawImage(tmp, 0, 0);
    } else if (this._maskCanvas) {
      this._maskCanvas.width = nw; this._maskCanvas.height = nh;
    }

    this.overlayCanvas.width = nw; this.overlayCanvas.height = nh;
    if (this._previewCanvas) { this._previewCanvas.width = nw; this._previewCanvas.height = nh; }
  }

  // ─── Preview ──────────────────────────────────────────────────────────────

  _schedulePreview() {
    clearTimeout(this._previewDebounceId);
    this._previewDebounceId = setTimeout(() => {
      this._previewDebounceId = null;
      this._computePreview();
    }, CFG.previewDebounceMs);
  }

  _cancelPreviewRaf() {
    clearTimeout(this._previewDebounceId);
    this._previewDebounceId = null;
  }

  _computePreview() {
    if (!this._previewCanvas || !this._strokes.length) { this._clearPreview(); return; }
    const pe  = this.photoEditor;
    const img = pe.img;
    if (!img) return;

    const w   = this._previewCanvas.width;
    const h   = this._previewCanvas.height;
    const osc = imgToCanvasScaled(img, w, h);
    const ctx = osc.getContext('2d');
    const id  = ctx.getImageData(0, 0, w, h);

    applyHealingBrush(id, w, h, this._strokes, this.searchMult);

    ctx.putImageData(id, 0, 0);
    this._previewCtx.clearRect(0, 0, w, h);
    this._previewCtx.drawImage(osc, 0, 0);
    this._previewCanvas.style.display = '';
    this._hasPreview = true;
  }

  _clearMask() {
    if (!this._maskCanvas) return;
    this._maskCtx.clearRect(0, 0, this._maskCanvas.width, this._maskCanvas.height);
  }

  _clearPreview() {
    if (!this._previewCanvas) return;
    this._previewCanvas.style.display = 'none';
    this._previewCtx?.clearRect(0, 0, this._previewCanvas.width, this._previewCanvas.height);
    this._hasPreview = false;
  }

  // ─── Overlay (мазки + курсор) ─────────────────────────────────────────────

  _drawOverlay() {
    if (!this.overlayCtx) return;
    this._syncCanvasSize();
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

    // Composit накопленную маску одним слоем — без наслоения прозрачности
    if (this._maskCanvas && this._strokes.length) {
      ctx.save();
      ctx.globalAlpha = 0.35;
      // Окрашиваем: рисуем маску как tint через source-atop
      ctx.drawImage(this._maskCanvas, 0, 0);
      ctx.globalCompositeOperation = 'source-atop';
      ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(60, 160, 255, 0.55)';
      ctx.fillRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
      ctx.restore();

    }

    if (this._cursorVisible) {
      const r = this.brushSize;
      ctx.save();
      ctx.beginPath(); ctx.arc(this._cursorX, this._cursorY, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.90)'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.beginPath(); ctx.arc(this._cursorX, this._cursorY, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 0.75; ctx.stroke();
      ctx.beginPath(); ctx.arc(this._cursorX, this._cursorY, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fill();
      ctx.restore();
    }
  }

  // ─── Координаты ───────────────────────────────────────────────────────────

  _clientToCanvas(cx, cy) {
    const r = this.overlayCanvas.getBoundingClientRect();
    return {
      x: (cx - r.left) * (this.overlayCanvas.width  / r.width),
      y: (cy - r.top)  * (this.overlayCanvas.height / r.height),
    };
  }

  // ─── События ──────────────────────────────────────────────────────────────

  _onMouseDown(e) {
    if (e.button !== 0) return;
    const { x, y } = this._clientToCanvas(e.clientX, e.clientY);
    this._startPaint(x, y);
  }
  _onMouseMove(e) {
    const { x, y } = this._clientToCanvas(e.clientX, e.clientY);
    this._cursorX = x; this._cursorY = y; this._cursorVisible = true;
    this._movePaint(x, y);
    this._drawOverlay();
  }
  _onMouseUp()    { this._endPaint(); }
  _onMouseLeave() { this._cursorVisible = false; if (!this._painting) this._drawOverlay(); }

  _onTouchStart(e) {
    if (e.touches.length !== 1) return; e.preventDefault();
    const { x, y } = this._clientToCanvas(e.touches[0].clientX, e.touches[0].clientY);
    this._startPaint(x, y);
  }
  _onTouchMove(e) {
    if (!this._painting) return; e.preventDefault();
    const { x, y } = this._clientToCanvas(e.touches[0].clientX, e.touches[0].clientY);
    this._cursorX = x; this._cursorY = y; this._cursorVisible = true;
    this._movePaint(x, y); this._drawOverlay();
  }
  _onTouchEnd() { this._endPaint(); }

  _onWinResize() {
    requestAnimationFrame(() => requestAnimationFrame(() => {
      this._drawOverlay();
      if (this._hasPreview) this._schedulePreview();
    }));
  }

  _onKeyDown(e) {
    if (isEditableTarget(e)) return false;
    // e.code — физическая позиция клавиши, не зависит от раскладки.
    // Перехватываем ДО проверки isActive, чтобы preventDefault успел
    // остановить браузерный обработчик Firefox (Quick Find).
    const isBracketL = e.code === 'BracketLeft';
    const isBracketR = e.code === 'BracketRight';
    const isEscape   = e.code === 'Escape' || e.key === 'Escape';

    if ((isBracketL || isBracketR) && this.isActive) {
      e.preventDefault();
      e.stopImmediatePropagation(); // останавливаем все остальные слушатели
      if (isBracketL) {
        this.brushSize = Math.max(CFG.minBrushSize, this.brushSize - CFG.brushSizeStep);
      } else {
        this.brushSize = Math.min(CFG.maxBrushSize, this.brushSize + CFG.brushSizeStep);
      }
      this._saveSettings(); this._syncPanel(); this._drawOverlay();
      return true;
    }

    if (isEscape && this.isActive) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.cancel();
      return true;
    }

    return false;
  }

  // ─── Рисование ────────────────────────────────────────────────────────────

  _startPaint(x, y) {
    this._cancelPreviewRaf();
    this._painting = true; this._lastPoint = { x, y };
    this._addStroke(x, y); this._drawOverlay();
  }

  _movePaint(x, y) {
    if (!this._painting || !this._lastPoint) return;
    const dist = Math.hypot(x - this._lastPoint.x, y - this._lastPoint.y);
    const step = Math.max(1, (this.brushSize / 3) | 0);
    if (dist >= step) { this._addStroke(x, y); this._lastPoint = { x, y }; }
  }

  _endPaint() {
    if (!this._painting) return;
    this._painting = false; this._lastPoint = null;
    if (this._strokes.length) this._schedulePreview();
  }

  _addStroke(x, y) {
    const s = { cx: x, cy: y, r: this.brushSize };
    this._strokes.push(s);
    // Рисуем на offscreen mask-canvas — source-over даёт union без наслоения
    if (this._maskCtx) {
      this._maskCtx.globalCompositeOperation = 'source-over';
      this._maskCtx.fillStyle = '#fff';
      this._maskCtx.beginPath();
      this._maskCtx.arc(x, y, this.brushSize, 0, Math.PI * 2);
      this._maskCtx.fill();
    }
  }

  // ─── Events bind/unbind ───────────────────────────────────────────────────

  _bindEvents() {
    const c = this.overlayCanvas;
    c.addEventListener('mousedown',  this._onMouseDown);
    c.addEventListener('mouseleave', this._onMouseLeave);
    c.addEventListener('touchstart', this._onTouchStart, { passive: false });
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('mouseup',   this._onMouseUp);
    document.addEventListener('touchmove', this._onTouchMove, { passive: false });
    document.addEventListener('touchend',  this._onTouchEnd);
    window.addEventListener('resize',      this._onWinResize);
    document.addEventListener('keydown',   this._onKeyDown, { capture: true });
  }

  _unbindEvents() {
    if (!this.overlayCanvas) return;
    const c = this.overlayCanvas;
    c.removeEventListener('mousedown',  this._onMouseDown);
    c.removeEventListener('mouseleave', this._onMouseLeave);
    c.removeEventListener('touchstart', this._onTouchStart);
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('mouseup',   this._onMouseUp);
    document.removeEventListener('touchmove', this._onTouchMove);
    document.removeEventListener('touchend',  this._onTouchEnd);
    window.removeEventListener('resize',      this._onWinResize);
    document.removeEventListener('keydown',   this._onKeyDown, { capture: true });
  }

  // ─── Панель ───────────────────────────────────────────────────────────────

  _createPanel() {
    if (this._panel) return;

    const panel = document.createElement('div');
    panel.className = 'pe-panel pe-panel--heal';

    const html = `
      <div class="pe-panel__header">
        <span class="pe-panel__title">Восстанавливающая кисть</span>
        <div class="pe-panel__header-actions">
          <button type="button"
                  class="photoeditor__button photoeditor__button--compact heal-panel__btn-cancel"
                  title="Отмена (Esc)">
            <i class="icon-close" aria-hidden="true"></i> Отмена
          </button>
          <button type="button"
                  class="photoeditor__button photoeditor__button--compact photoeditor__button--success heal-panel__btn-apply"
                  title="Применить в полном разрешении">
            <i class="icon-checkmark" aria-hidden="true"></i> Применить
          </button>
        </div>
      </div>

      <div class="pe-panel__row">
        <label class="heal-panel__lbl" title="Радиус кисти ([ и ] для изменения)">
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
        Закрасьте дефект · предпросмотр — автоматически · [ / ] — размер
      </div>`;

    panel.innerHTML = html;
    this._panel = panel;

    // Размер кисти
    const sizeEl  = panel.querySelector('.heal-panel__brush-size');
    const sizeVal = panel.querySelector('.heal-panel__val--size');
    sizeEl.addEventListener('input', () => {
      this.brushSize = Number(sizeEl.value);
      sizeVal.textContent = sizeEl.value;
      this._saveSettings(); this._drawOverlay();
    });

    // Поиск
    const searchEl  = panel.querySelector('.heal-panel__search-mult');
    const searchVal = panel.querySelector('.heal-panel__val--search');
    searchEl.addEventListener('input', () => {
      this.searchMult = Number(searchEl.value);
      searchVal.textContent = searchEl.value;
      this._saveSettings();
      if (this._strokes.length) this._schedulePreview();
    });

    // Кнопки
    panel.querySelector('.heal-panel__btn-clear').addEventListener('click', () => {
      this._cancelPreviewRaf();
      this._strokes = []; this._clearMask(); this._clearPreview(); this._drawOverlay();
    });
    panel.querySelector('.heal-panel__btn-cancel').addEventListener('click', () => this.cancel());
    panel.querySelector('.heal-panel__btn-apply').addEventListener('click',  () => this.apply());

    this.photoEditor.container.appendChild(panel);

    this.photoEditor.dialogs?.register('heal', panel, {
      group:   'tool',
      onClose: () => {
        if (this.isActive && !this._stopping && !this._suspending) this.suspend();
      },
    });
    this.photoEditor.dialogs?.open('heal');
  }

  _syncPanel() {
    if (!this._panel) return;
    const sizeEl  = this._panel.querySelector('.heal-panel__brush-size');
    const sizeVal = this._panel.querySelector('.heal-panel__val--size');
    if (sizeEl)  sizeEl.value        = this.brushSize;
    if (sizeVal) sizeVal.textContent = this.brushSize;
    const searchEl  = this._panel.querySelector('.heal-panel__search-mult');
    const searchVal = this._panel.querySelector('.heal-panel__val--search');
    if (searchEl)  searchEl.value        = this.searchMult;
    if (searchVal) searchVal.textContent = this.searchMult;
  }

  _saveSettings() {
    saveSettings({ brushSize: this.brushSize, searchMult: this.searchMult });
  }
}

// ─── Mini helpers ─────────────────────────────────────────────────────────────

function clamp255(min, max, v) { return v < min ? min : v > max ? max : v; }
function clampF(min, max, v)   { return v < min ? min : v > max ? max : v; }
