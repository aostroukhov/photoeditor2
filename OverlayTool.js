/**
 * OverlayTool — текстовые и графические оверлеи поверх изображения.
 *
 * Оверлеи живут в логических координатах overlay и НЕ наносятся на pe.img до
 * «Применить». Выбранный оверлей двигается, масштабируется за углы
 * (для текста — вместе с размером шрифта) и вращается за жёлтую ручку.
 * При «Применить» набор сохраняется в localStorage-историю; пресеты берутся
 * из EditorConfig.overlay.presets.
 *
 * renderToCanvas() используется также ExportPanel и PhotoEditor: экспорт
 * включает незакоммиченные оверлеи.
 *
 * Жизненный цикл, canvas, указатель, панель и клавиатура — в ToolBase.
 */

import { EditorConfig } from './EditorConfig.js';
import { ToolBase }     from './ToolBase.js';
import { safeCssColor } from './utils.js';

const CFG               = EditorConfig.overlay;
const HANDLE_RADIUS     = CFG.handleRadius;
const MIN_SIZE          = CFG.minSize;
const ROTATE_OFFSET     = CFG.rotateOffset;
const HISTORY_KEY       = CFG.historyKey;
const TEXT_SETTINGS_KEY = CFG.textSettingsKey;
const MAX_OVERLAY_FRAC  = CFG.maxOverlayFrac;

const FONT_FAMILIES = [
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
  'Arial', 'Arial Black', 'Verdana', 'Tahoma', 'Trebuchet MS',
  'Georgia', 'Times New Roman', 'Courier New', 'Impact',
];

function loadTextSettings() {
  try {
    const raw = localStorage.getItem(TEXT_SETTINGS_KEY);
    const o = raw ? JSON.parse(raw) : {};
    return o && typeof o === 'object' ? o : {};
  } catch { return {}; }
}
function saveTextSettings(settings) {
  try { localStorage.setItem(TEXT_SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}
function loadHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}
function saveHistoryList(list) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch { /* квота / private browsing */ }
}
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);


// ─── Модели ───────────────────────────────────────────────────────────────────

let nextOverlayId = 1;

export class Overlay {
  /** Явный тип для сериализации (constructor.name ломается минификацией). */
  static type = 'Overlay';

  constructor({ x = 100, y = 100, width = 200, height = 80, rotation = 0, opacity = 1, lockAspect = true } = {}) {
    this.x = x; this.y = y; this.width = width; this.height = height;
    this.rotation = rotation; this.opacity = opacity; this.lockAspect = lockAspect;
    this.id = nextOverlayId++;
  }
  get cx() { return this.x + this.width  / 2; }
  get cy() { return this.y + this.height / 2; }
  render(_ctx) {}
  toJSON() {
    return {
      type: this.constructor.type,
      x: this.x, y: this.y, width: this.width, height: this.height,
      rotation: this.rotation, opacity: this.opacity, lockAspect: this.lockAspect,
    };
  }
}

export class TextOverlay extends Overlay {
  static type = 'TextOverlay';

  constructor({
    text = 'Текст', fontFamily = 'sans-serif', fontSize = 48,
    fontWeight = 'bold', color = '#ffffff', strokeColor = '#000000',
    strokeWidth = 2, ...rest
  } = {}) {
    super(rest);
    this.text        = String(text);
    this.fontFamily  = fontFamily;
    this.fontSize    = fontSize;
    this.fontWeight  = fontWeight;
    this.color       = color;
    this.strokeColor = strokeColor;
    this.strokeWidth = strokeWidth;
  }
  get font() { return `${this.fontWeight} ${this.fontSize}px ${this.fontFamily}`; }
  render(ctx) {
    ctx.save();
    ctx.globalAlpha  = this.opacity;
    ctx.translate(this.cx, this.cy); ctx.rotate(this.rotation);
    ctx.font         = this.font;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    if (this.strokeWidth > 0 && this.strokeColor) {
      ctx.strokeStyle = this.strokeColor;
      ctx.lineWidth   = this.strokeWidth * 2;
      ctx.lineJoin    = 'round';
      ctx.strokeText(this.text, 0, 0);
    }
    ctx.fillStyle = this.color;
    ctx.fillText(this.text, 0, 0);
    ctx.restore();
  }
  toJSON() {
    return {
      ...super.toJSON(),
      text: this.text, fontFamily: this.fontFamily,
      fontSize: this.fontSize, fontWeight: this.fontWeight,
      color: this.color, strokeColor: this.strokeColor, strokeWidth: this.strokeWidth,
    };
  }
}

export class ImageOverlay extends Overlay {
  static type = 'ImageOverlay';

  constructor({ source = null, srcDataUrl = null, ...rest } = {}) {
    super(rest);
    this.source     = source;
    this.srcDataUrl = srcDataUrl;
  }
  render(ctx) {
    if (!this.source) return;
    ctx.save();
    ctx.globalAlpha = this.opacity;
    ctx.translate(this.cx, this.cy); ctx.rotate(this.rotation);
    ctx.drawImage(this.source, -this.width / 2, -this.height / 2, this.width, this.height);
    ctx.restore();
  }
  toJSON() { return { ...super.toJSON(), srcDataUrl: this.srcDataUrl }; }
}

/** Общий контекст для measureText (размер рамки текстового оверлея). */
let measureCtx = null;
function getMeasureCtx() {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx;
}

/**
 * Подгоняет рамку текстового оверлея под глифы (с учётом обводки), сохраняя центр.
 * Рамка нужна для hit-test, ручек и ручки вращения — раньше она задавалась как
 * доля холста и не зависела от текста, так что текст выходил за ручки.
 */
export function fitTextBox(ov) {
  const ctx = getMeasureCtx();
  if (!ctx) return;
  const cx = ov.cx, cy = ov.cy;
  ctx.font = ov.font;
  const m   = ctx.measureText(ov.text || ' ');
  const pad = Math.max(2, ov.fontSize * 0.08);
  const asc = m.actualBoundingBoxAscent, desc = m.actualBoundingBoxDescent;
  const glyphH = (Number.isFinite(asc) && Number.isFinite(desc) && asc + desc > 0) ? asc + desc : ov.fontSize * 1.15;
  ov.width  = Math.max(MIN_SIZE, m.width + 2 * ov.strokeWidth + 2 * pad);
  ov.height = Math.max(MIN_SIZE, glyphH  + 2 * ov.strokeWidth + 2 * pad);
  ov.x = cx - ov.width / 2;
  ov.y = cy - ov.height / 2;
}

/** Загружает картинку оверлея (data: — без CORS, внешний URL — с crossOrigin). */
function loadOverlayImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith('data:')) img.crossOrigin = 'anonymous';
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('OverlayTool: не удалось загрузить изображение оверлея'));
    img.src = src;
  });
}


// ─── OverlayTool ──────────────────────────────────────────────────────────────

export class OverlayTool extends ToolBase {

  /** Все оверлеи текущей сессии (сохраняются между suspend/resume). */
  overlays = [];
  /** Выбранный оверлей или null. */
  selected = null;

  _historySize   = CFG.historySize;
  _presets       = CFG.presets;   // переопределяется opts.presets (issue #10)
  _drag   = null;   // { startX, startY, origX, origY }
  _resize = null;   // { handle, origW, origH, origX, origY, aspectRatio, origFontSize }
  _rotate = null;   // { startAngle }
  _applyingEntry = false;

  constructor(photoEditor, opts = {}) {
    super(photoEditor, { id: 'overlay' });
    this._historySize = opts.historySize ?? CFG.historySize;
    if (Array.isArray(opts.presets)) this._presets = opts.presets;
  }


  // ─── Хуки жизненного цикла ────────────────────────────────────────────────

  onStart()  {}
  onResume() {}

  onSuspend() {
    this.selected = null;
    this._drag = null; this._resize = null; this._rotate = null;
  }

  onCancel()  { this.overlays = []; this.selected = null; }
  onDestroy() { this.overlays = []; this.selected = null; }

  onApply() {
    if (!this.overlays.length || !this.pe.img) { this.overlays = []; this.selected = null; return null; }
    this._saveHistory();
    const out = this.renderToCanvas();
    this.overlays = []; this.selected = null;
    return out;
  }

  onViewResize(kx, ky) {
    for (const ov of this.overlays) {
      ov.x *= kx; ov.y *= ky; ov.width *= kx; ov.height *= ky;
      // Глифы задаются fontSize, а не рамкой — масштабируем и их
      if (ov instanceof TextOverlay) { ov.fontSize = Math.max(1, ov.fontSize * ky); ov.strokeWidth *= ky; fitTextBox(ov); }
    }
  }

  onDraw(ctx) {
    for (const ov of this.overlays) {
      ov.render(ctx);
      if (ov === this.selected) this._drawHandles(ctx, ov);
    }
  }

  /** Совместимость: внешняя перерисовка. */
  redraw() { this.requestDraw(); }


  // ─── Публичный API ────────────────────────────────────────────────────────

  /**
   * pe.img + все оверлеи в натуральном разрешении.
   * @returns {HTMLCanvasElement}
   */
  renderToCanvas() {
    const img = this.pe.img;
    if (!img) throw new Error('[OverlayTool] renderToCanvas: img не задан');
    const out = document.createElement('canvas');
    out.width  = img.naturalWidth;
    out.height = img.naturalHeight;
    const ctx  = out.getContext('2d');
    ctx.drawImage(img, 0, 0);
    if (!this.overlays.length) return out;
    // viewW может быть 0, если инструмент ни разу не стартовал — тогда оверлеев тоже нет
    const k = this.viewW ? img.naturalWidth / this.viewW : 1;
    for (const ov of this.overlays) { ctx.save(); ctx.scale(k, k); ov.render(ctx); ctx.restore(); }
    return out;
  }

  addTextOverlay(opts = {}) {
    const cw = this.viewW || 400, ch = this.viewH || 300;
    const saved = loadTextSettings();
    const ov = new TextOverlay({
      x: Math.round(cw * 0.35), y: Math.round(ch * 0.42),
      width:  Math.round(cw * MAX_OVERLAY_FRAC),
      height: Math.round(ch * MAX_OVERLAY_FRAC * 0.35),
      fontFamily:  FONT_FAMILIES.includes(saved.fontFamily) ? saved.fontFamily : 'sans-serif',
      fontSize:    num(saved.fontSize, 48),
      fontWeight:  saved.fontWeight === 'normal' ? 'normal' : 'bold',
      color:       safeCssColor(saved.color, '#ffffff'),
      strokeColor: safeCssColor(saved.strokeColor, '#000000'),
      strokeWidth: num(saved.strokeWidth, 2),
      ...opts,
    });
    fitTextBox(ov);
    this._addOverlay(ov);
    return ov;
  }

  addImageOverlay(source, opts = {}) {
    const cw = this.viewW || 400, ch = this.viewH || 300;
    const srcW = source.naturalWidth  || source.width  || cw * MAX_OVERLAY_FRAC;
    const srcH = source.naturalHeight || source.height || ch * MAX_OVERLAY_FRAC;
    const k    = Math.min(1, (cw * MAX_OVERLAY_FRAC) / srcW, (ch * MAX_OVERLAY_FRAC) / srcH);
    const ov   = new ImageOverlay({
      source,
      x: Math.round((cw - srcW * k) / 2), y: Math.round((ch - srcH * k) / 2),
      width: Math.round(srcW * k), height: Math.round(srcH * k),
      ...opts,
    });
    this._addOverlay(ov);
    return ov;
  }

  _addOverlay(ov) {
    this.overlays.push(ov);
    this.selected = ov;
    this._syncPanel(); this.requestDraw();
  }

  _removeOverlay(ov) {
    this.overlays = this.overlays.filter(o => o !== ov);
    if (this.selected === ov) this.selected = this.overlays.at(-1) ?? null;
    this._syncPanel(); this.requestDraw();
  }

  _centerSelected() {
    const ov = this.selected;
    if (!ov) return;
    ov.x = Math.round((this.viewW - ov.width)  / 2);
    ov.y = Math.round((this.viewH - ov.height) / 2);
    this._syncPanel(); this.requestDraw();
  }


  // ─── Геометрия ────────────────────────────────────────────────────────────

  _corners(ov) {
    const hw = ov.width / 2, hh = ov.height / 2;
    const cos = Math.cos(ov.rotation), sin = Math.sin(ov.rotation);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([lx, ly]) => ({
      x: ov.cx + lx * cos - ly * sin,
      y: ov.cy + lx * sin + ly * cos,
    }));
  }

  _rotateHandle(ov) {
    const c   = this._corners(ov);
    const mx  = (c[0].x + c[1].x) / 2, my = (c[0].y + c[1].y) / 2;
    const dx  = mx - ov.cx, dy = my - ov.cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: mx + dx / len * ROTATE_OFFSET, y: my + dy / len * ROTATE_OFFSET };
  }

  _worldToLocal(ov, wx, wy) {
    const dx = wx - ov.cx, dy = wy - ov.cy;
    const cos = Math.cos(-ov.rotation), sin = Math.sin(-ov.rotation);
    return { lx: dx * cos - dy * sin, ly: dx * sin + dy * cos };
  }

  _hitTest(x, y) {
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      const ov = this.overlays[i];
      // Ручки рисуются только у выбранного — у остальных их не проверяем
      if (ov === this.selected) {
        const rh = this._rotateHandle(ov);
        if (Math.hypot(x - rh.x, y - rh.y) <= HANDLE_RADIUS + 6) return { type: 'rotate', ov };
        const names = ['topLeft', 'topRight', 'bottomRight', 'bottomLeft'];
        const corners = this._corners(ov);
        for (let j = 0; j < 4; j++) {
          if (Math.hypot(x - corners[j].x, y - corners[j].y) <= HANDLE_RADIUS + 6) return { type: 'resize', handle: names[j], ov };
        }
      }
      const { lx, ly } = this._worldToLocal(ov, x, y);
      if (Math.abs(lx) <= ov.width / 2 && Math.abs(ly) <= ov.height / 2) return { type: 'move', ov };
    }
    return null;
  }

  _drawHandles(ctx, ov) {
    const c = this._corners(ov);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(c[i].x, c[i].y);
    ctx.closePath(); ctx.stroke();

    ctx.fillStyle = 'rgba(60,143,224,0.9)';
    for (const p of c) { ctx.beginPath(); ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }

    const rh  = this._rotateHandle(ov);
    const mid = { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2 };
    ctx.beginPath(); ctx.moveTo(mid.x, mid.y); ctx.lineTo(rh.x, rh.y); ctx.stroke();
    ctx.fillStyle = 'rgba(255,210,0,0.95)';
    ctx.beginPath(); ctx.arc(rh.x, rh.y, HANDLE_RADIUS, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.restore();
  }


  // ─── Указатель ────────────────────────────────────────────────────────────

  onHover(pt) {
    const hit = this._hitTest(pt.x, pt.y);
    this.overlayCanvas.style.cursor = !hit ? 'default'
      : hit.type === 'rotate' ? 'crosshair'
      : hit.type === 'resize' ? 'nwse-resize'
      : 'move';
  }

  onPointerDown(pt) {
    const { x, y } = pt;
    const hit = this._hitTest(x, y);
    if (!hit) {
      if (this.selected) { this.selected = null; this._syncPanel(); this.requestDraw(); }
      return;
    }
    const { type, ov, handle } = hit;
    if (this.selected !== ov) {
      this.selected = ov;
      // Поднимаем выбранный на верх стека — он рендерится поверх
      this.overlays.splice(this.overlays.indexOf(ov), 1);
      this.overlays.push(ov);
      this._syncPanel(); this.requestDraw();
    }
    if      (type === 'move')   this._drag   = { startX: x, startY: y, origX: ov.x, origY: ov.y };
    else if (type === 'resize') this._resize = { handle, origW: ov.width, origH: ov.height, origX: ov.x, origY: ov.y, aspectRatio: ov.width / ov.height, origFontSize: ov.fontSize };
    else                        this._rotate = { startAngle: Math.atan2(y - ov.cy, x - ov.cx) - ov.rotation };
  }

  onPointerMove(pt) {
    const ov = this.selected;
    if (!ov || (!this._drag && !this._resize && !this._rotate)) return;   // ранний выход: без операции не перерисовываем
    const { x, y } = pt;

    if (this._drag) {
      ov.x = this._drag.origX + (x - this._drag.startX);
      ov.y = this._drag.origY + (y - this._drag.startY);
    } else if (this._rotate) {
      ov.rotation = Math.atan2(y - ov.cy, x - ov.cx) - this._rotate.startAngle;
    } else if (this._resize) {
      const r = this._resize;
      const { lx: dlx, ly: dly } = this._worldToLocal(ov, x, y);
      const sx = (r.handle === 'topRight' || r.handle === 'bottomRight') ? 1 : -1;
      const sy = (r.handle === 'bottomRight' || r.handle === 'bottomLeft') ? 1 : -1;
      const dx = dlx - sx * r.origW / 2, dy = dly - sy * r.origH / 2;
      const newW = Math.max(MIN_SIZE, r.origW + sx * dx * 2);
      const newH = ov.lockAspect ? newW / r.aspectRatio : Math.max(MIN_SIZE, r.origH + sy * dy * 2);
      if (ov instanceof TextOverlay && r.origFontSize) {
        // Текст: растягивание меняет размер шрифта (по большему из коэффициентов),
        // рамка всегда следует за глифами; центр остаётся на месте
        const k = Math.max(newW / r.origW, newH / r.origH);
        ov.fontSize = Math.max(6, Math.round(r.origFontSize * k));
        fitTextBox(ov);
      } else {
        ov.width = newW; ov.height = newH;
        ov.x = r.origX + (r.origW - newW) / 2;
        ov.y = r.origY + (r.origH - newH) / 2;
      }
    }
    this._syncPanel();
    this.requestDraw();
  }

  onPointerUp() {
    this._drag = null; this._resize = null; this._rotate = null;
    if (this.overlayCanvas) this.overlayCanvas.style.cursor = 'default';
  }

  onPointerCancel() { this.onPointerUp(); }


  // ─── Клавиатура ───────────────────────────────────────────────────────────

  onKey(e) {
    if (!this.selected) return false;
    const step = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'ArrowUp':    this.selected.y -= step; break;
      case 'ArrowDown':  this.selected.y += step; break;
      case 'ArrowLeft':  this.selected.x -= step; break;
      case 'ArrowRight': this.selected.x += step; break;
      case 'Home':       this._centerSelected(); return true;
      case 'Delete':
      case 'Backspace':  this._removeOverlay(this.selected); return true;
      default: return false;
    }
    this._syncPanel(); this.requestDraw();
    return true;
  }


  // ─── История ──────────────────────────────────────────────────────────────

  _saveHistory() {
    if (!this.overlays.length) return;
    const list = loadHistory();
    list.unshift({ overlays: this.overlays.map(o => o.toJSON()) });
    list.splice(this._historySize);
    saveHistoryList(list);
  }

  _deleteHistoryEntry(idx) {
    const list = loadHistory();
    list.splice(idx, 1);
    saveHistoryList(list);
    this._renderHistoryPanel();
  }

  /** Восстанавливает набор из записи истории (данные — недоверенные). */
  async _applyHistoryEntry(entry) {
    if (this._applyingEntry) return;
    this._applyingEntry = true;
    this.overlays = []; this.selected = null;
    try {
      for (const d of Array.isArray(entry?.overlays) ? entry.overlays : []) {
        if (!d || typeof d !== 'object') continue;
        if (d.type === 'TextOverlay') {
          // Старые записи: font='bold 48px sans-serif'
          if (d.font && !d.fontFamily) {
            const m = String(d.font).match(/^(\w+)\s+(\d+)px\s+(.+)$/);
            if (m) { d.fontWeight = m[1]; d.fontSize = Number(m[2]); d.fontFamily = m[3]; }
          }
          const tov = new TextOverlay({
            ...d, color: safeCssColor(d.color), strokeColor: safeCssColor(d.strokeColor, '#000000'),
            fontSize: num(d.fontSize, 48), strokeWidth: num(d.strokeWidth, 2),
          });
          fitTextBox(tov);
          this.overlays.push(tov);
        } else if (d.type === 'ImageOverlay' && typeof d.srcDataUrl === 'string') {
          try {
            const img = await loadOverlayImage(d.srcDataUrl);
            this.overlays.push(new ImageOverlay({ ...d, source: img }));
          } catch { /* битая запись — пропускаем */ }
        }
      }
    } finally {
      this._applyingEntry = false;
    }
    this.selected = this.overlays.at(-1) ?? null;
    this._syncPanel(); this._renderHistoryPanel(); this.requestDraw();
  }


  // ─── Панель ───────────────────────────────────────────────────────────────

  buildPanel() {
    const panel = document.createElement('div');
    panel.innerHTML = `
      ${ToolBase.panelHeader({
        title: 'Оверлеи', prefix: 'overlay-panel',
        cancelTitle: 'Отмена — убрать все оверлеи', applyTitle: 'Нанести оверлеи на изображение',
        left: `<div class="overlay-panel__add-btns">
          <button type="button" class="photoeditor__button photoeditor__button--compact overlay-panel__btn-add-text"
                  title="Добавить текст" aria-label="Добавить текст">+<i class="icon-text" aria-hidden="true"></i></button>
          <button type="button" class="photoeditor__button photoeditor__button--compact overlay-panel__btn-add-image"
                  title="Добавить изображение" aria-label="Добавить изображение"><i class="icon-add-photo" aria-hidden="true"></i></button>
        </div>`,
      })}
      <div class="overlay-panel__row overlay-panel__row--selected" style="display:none">
        <button type="button" class="photoeditor__button photoeditor__button--compact photoeditor__button--danger overlay-panel__btn-delete"
                disabled title="Удалить оверлей (Delete)" aria-label="Удалить оверлей">
          <i class="icon-bin" aria-hidden="true"></i>
        </button>
        <label title="Прозрачность">
          <span class="overlay-panel__lbl-text">Прозрачность</span>
          <input type="range" class="overlay-panel__opacity" min="0" max="100" value="100">
          <span class="overlay-panel__val-opacity">100</span>%
        </label>
        <label title="Угол поворота">
          <span class="overlay-panel__lbl-text">Поворот</span>
          <input type="range" class="overlay-panel__rotation" min="-180" max="180" value="0">
          <span class="overlay-panel__val-rotation">0</span>°
        </label>
        <label class="overlay-panel__lock-label" title="Сохранять пропорции">
          <input type="checkbox" class="overlay-panel__lock-aspect" checked>
          <span>Пропорции</span>
        </label>
        <button type="button" class="photoeditor__button photoeditor__button--compact overlay-panel__btn-center"
                title="Центрировать (Home)" aria-label="Центрировать">
          <i class="icon-target" aria-hidden="true"></i>
        </button>
      </div>
      <div class="overlay-panel__row overlay-panel__row--text" style="display:none">
        <label title="Текст оверлея">
          <span class="overlay-panel__lbl-text">Текст</span>
          <input type="text" class="overlay-panel__text-input" value="Текст">
        </label>
        <label title="Цвет текста">
          <span class="overlay-panel__lbl-text">Цвет</span>
          <input type="color" class="overlay-panel__text-color" value="#ffffff">
        </label>
        <label title="Цвет обводки">
          <span class="overlay-panel__lbl-text">Обводка</span>
          <input type="color" class="overlay-panel__stroke-color" value="#000000">
        </label>
        <label title="Толщина обводки">
          <span class="overlay-panel__lbl-text">Толщина</span>
          <input type="range" class="overlay-panel__stroke-width" min="0" max="20" value="2">
          <span class="overlay-panel__val-stroke">2</span>px
        </label>
        <label title="Шрифт">
          <span class="overlay-panel__lbl-text">Шрифт</span>
          <select class="overlay-panel__font-family">
            ${FONT_FAMILIES.map(f => `<option value="${f}">${f}</option>`).join('')}
          </select>
        </label>
        <label title="Размер шрифта">
          <span class="overlay-panel__lbl-text">Размер</span>
          <input type="range" class="overlay-panel__font-size" min="8" max="200" value="48">
          <span class="overlay-panel__val-font-size">48</span>px
        </label>
        <label title="Жирность">
          <span class="overlay-panel__lbl-text">Жирный</span>
          <input type="checkbox" class="overlay-panel__font-weight" checked>
        </label>
      </div>
      <div class="overlay-panel__history" style="display:none">
        <div class="overlay-panel__history-label">История</div>
        <div class="overlay-panel__history-list"></div>
      </div>
      <div class="overlay-panel__presets" style="display:none">
        <div class="overlay-panel__history-label">Пресеты</div>
        <div class="overlay-panel__presets-list"></div>
      </div>`;

    this._bindPanelEvents(panel);
    this._bindHistoryList(panel);
    return panel;
  }

  onPanelReady() {
    this._renderHistoryPanel();
    this._renderPresetsPanel();
  }

  _bindPanelEvents(p) {
    const q = (sel) => p.querySelector(sel);
    const onText = (fn) => (e) => {
      if (!(this.selected instanceof TextOverlay)) return;
      fn(this.selected, e);
      fitTextBox(this.selected);
      saveTextSettings(this._textSettings());
      this.requestDraw();
    };

    q('.overlay-panel__btn-add-text').addEventListener('click', () => {
      if (!this.isActive) return;
      this.addTextOverlay({ text: 'Текст' });
      const inp = q('.overlay-panel__text-input');
      if (inp) { inp.focus(); inp.select(); }
    });

    q('.overlay-panel__btn-add-image').addEventListener('click', () => {
      if (!this.isActive) return;
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*';
      inp.addEventListener('change', () => {
        const file = inp.files?.[0];
        if (!file || !file.type.startsWith('image/')) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
          try {
            const img = await loadOverlayImage(ev.target.result);
            if (this.isActive) this.addImageOverlay(img, { srcDataUrl: ev.target.result });
          } catch (err) { console.warn('[OverlayTool]', err.message); }
        };
        reader.readAsDataURL(file);
      });
      inp.click();
    });

    q('.overlay-panel__btn-delete').addEventListener('click', () => { if (this.selected) this._removeOverlay(this.selected); });
    q('.overlay-panel__btn-center').addEventListener('click', () => this._centerSelected());

    const opEl = q('.overlay-panel__opacity'), opVal = q('.overlay-panel__val-opacity');
    opEl.addEventListener('input', () => {
      if (!this.selected) return;
      this.selected.opacity = opEl.value / 100; opVal.textContent = opEl.value; this.requestDraw();
    });
    const rotEl = q('.overlay-panel__rotation'), rotVal = q('.overlay-panel__val-rotation');
    rotEl.addEventListener('input', () => {
      if (!this.selected) return;
      this.selected.rotation = rotEl.value * Math.PI / 180; rotVal.textContent = rotEl.value; this.requestDraw();
    });
    q('.overlay-panel__lock-aspect').addEventListener('change', (e) => { if (this.selected) this.selected.lockAspect = e.target.checked; });

    const textInp = q('.overlay-panel__text-input');
    textInp.addEventListener('input', (e) => {
      if (this.selected instanceof TextOverlay) { this.selected.text = e.target.value; fitTextBox(this.selected); this.requestDraw(); }
    });
    // Enter в поле — завершить ввод (снять фокус), а не отдавать редактору
    textInp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); textInp.blur(); } });

    q('.overlay-panel__text-color').addEventListener('input',   onText((ov, e) => { ov.color = e.target.value; }));
    q('.overlay-panel__stroke-color').addEventListener('input', onText((ov, e) => { ov.strokeColor = e.target.value; }));
    const swEl = q('.overlay-panel__stroke-width'), swVal = q('.overlay-panel__val-stroke');
    swEl.addEventListener('input', onText((ov) => { ov.strokeWidth = Number(swEl.value); swVal.textContent = swEl.value; }));
    const ffEl = q('.overlay-panel__font-family');
    ffEl.addEventListener('change', onText((ov) => { ov.fontFamily = ffEl.value; }));
    const fsEl = q('.overlay-panel__font-size'), fsVal = q('.overlay-panel__val-font-size');
    fsEl.addEventListener('input', onText((ov) => { ov.fontSize = Number(fsEl.value); fsVal.textContent = fsEl.value; }));
    const fwEl = q('.overlay-panel__font-weight');
    fwEl.addEventListener('change', onText((ov) => { ov.fontWeight = fwEl.checked ? 'bold' : 'normal'; }));
  }

  _textSettings() {
    const ov = this.selected;
    if (!(ov instanceof TextOverlay)) return {};
    return {
      fontFamily: ov.fontFamily, fontSize: ov.fontSize, fontWeight: ov.fontWeight,
      color: ov.color, strokeColor: ov.strokeColor, strokeWidth: ov.strokeWidth,
    };
  }

  _syncPanel() {
    const p = this._panel;
    if (!p) return;
    const q = (sel) => p.querySelector(sel);
    const ov      = this.selected;
    const rowSel  = q('.overlay-panel__row--selected');
    const rowText = q('.overlay-panel__row--text');
    const delBtn  = q('.overlay-panel__btn-delete');

    if (!ov) { rowSel.style.display = 'none'; rowText.style.display = 'none'; delBtn.disabled = true; return; }
    rowSel.style.display = ''; delBtn.disabled = false;
    const deg = Math.round(ov.rotation * 180 / Math.PI);
    q('.overlay-panel__opacity').value            = Math.round(ov.opacity * 100);
    q('.overlay-panel__val-opacity').textContent  = Math.round(ov.opacity * 100);
    q('.overlay-panel__rotation').value           = deg;
    q('.overlay-panel__val-rotation').textContent = deg;
    q('.overlay-panel__lock-aspect').checked      = ov.lockAspect;

    const isText = ov instanceof TextOverlay;
    rowText.style.display = isText ? '' : 'none';
    if (!isText) return;
    const inp = q('.overlay-panel__text-input');
    if (document.activeElement !== inp) inp.value = ov.text;
    q('.overlay-panel__text-color').value          = ov.color;
    q('.overlay-panel__stroke-color').value        = ov.strokeColor;
    q('.overlay-panel__stroke-width').value        = ov.strokeWidth;
    q('.overlay-panel__val-stroke').textContent    = ov.strokeWidth;
    q('.overlay-panel__font-family').value         = ov.fontFamily;
    q('.overlay-panel__font-size').value           = ov.fontSize;
    q('.overlay-panel__val-font-size').textContent = Math.round(ov.fontSize);
    q('.overlay-panel__font-weight').checked       = ov.fontWeight === 'bold';
  }

  /** Карточка истории/пресета: превью текстов и картинок + подпись. Данные недоверенные. */
  _buildCard({ title, textItems, imgItems, summary, deleteIndex = null }) {
    const card = document.createElement('div');
    card.className = 'overlay-history__card';
    card.title     = title;
    card.tabIndex  = 0;
    card.setAttribute('role', 'button');

    if (deleteIndex !== null) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'overlay-history__btn-delete';
      del.dataset.index = String(deleteIndex);
      del.title = 'Удалить'; del.setAttribute('aria-label', 'Удалить запись истории');
      del.innerHTML = '<i class="icon-close" aria-hidden="true"></i>';
      card.appendChild(del);
    }

    const previews = document.createElement('div');
    previews.className = 'overlay-history__previews';
    for (const t of textItems.slice(0, 2)) {
      const d = document.createElement('div');
      d.className   = 'overlay-history__thumb overlay-history__thumb--text';
      d.style.color = safeCssColor(t.color, '#fff');
      d.title       = String(t.text ?? '');
      d.textContent = String(t.text ?? 'T').slice(0, 4) || 'T';
      previews.appendChild(d);
    }
    for (const it of imgItems.slice(0, 2)) {
      const thumb = document.createElement('div');
      thumb.className = 'overlay-history__thumb overlay-history__thumb--img';
      const src = typeof it.src === 'string' ? it.src : null;
      const fallback = () => {
        thumb.innerHTML = '<i class="icon-image" style="font-size:1.25em;margin:auto" aria-hidden="true"></i>';
        thumb.style.cssText += ';display:flex;align-items:center;justify-content:center';
      };
      if (src && (src.startsWith('data:image/') || /^(https?:)?\//.test(src))) {
        const img = document.createElement('img');
        img.style.cssText = 'width:100%;height:100%;object-fit:contain;border-radius:0.2em';
        img.alt = ''; img.onerror = () => { img.remove(); fallback(); };
        img.src = src;
        thumb.appendChild(img);
      } else fallback();
      previews.appendChild(thumb);
    }
    if (!textItems.length && !imgItems.length) {
      previews.innerHTML = '<i class="icon-layers" style="font-size:1.5em;opacity:.6;margin:auto" aria-hidden="true"></i>';
      previews.style.cssText += ';display:flex;align-items:center;justify-content:center';
    }
    card.appendChild(previews);

    const sum = document.createElement('div');
    sum.className   = 'overlay-history__summary';
    sum.textContent = summary;
    card.appendChild(sum);
    return card;
  }

  _renderHistoryPanel() {
    const p = this._panel;
    if (!p) return;
    const history = loadHistory();
    const wrap = p.querySelector('.overlay-panel__history');
    const list = p.querySelector('.overlay-panel__history-list');
    list.innerHTML = '';
    if (!history.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';

    history.forEach((entry, idx) => {
      const items     = Array.isArray(entry?.overlays) ? entry.overlays.filter(o => o && typeof o === 'object') : [];
      const textItems = items.filter(o => o.type === 'TextOverlay');
      const imgItems  = items.filter(o => o.type === 'ImageOverlay').map(o => ({ src: o.srcDataUrl }));
      const summary   = [textItems.length ? `${textItems.length}×Т` : '', imgItems.length ? `${imgItems.length}×Ф` : '']
        .filter(Boolean).join(' ') || 'оверлеи';
      const card = this._buildCard({ title: 'Кликните, чтобы применить набор', textItems, imgItems, summary, deleteIndex: idx });
      card.dataset.index = String(idx);
      list.appendChild(card);
    });
  }

  /** Один делегированный обработчик на список истории (навешивается в buildPanel). */
  _bindHistoryList(panel) {
    const listEl = panel.querySelector('.overlay-panel__history-list');
    const activate = (target) => {
      const delBtn = target.closest('.overlay-history__btn-delete');
      if (delBtn) { this._deleteHistoryEntry(Number(delBtn.dataset.index)); return; }
      const card = target.closest('.overlay-history__card');
      if (!card) return;
      const entry = loadHistory()[Number(card.dataset.index)];
      if (entry) this._applyHistoryEntry(entry);
    };
    listEl.addEventListener('click', (e) => activate(e.target));
    listEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(e.target); }
    });

    const presetsEl = panel.querySelector('.overlay-panel__presets-list');
    const activatePreset = (target) => {
      const card = target.closest('.overlay-history__card');
      const preset = card && this._presets?.[Number(card.dataset.index)];
      if (preset) this._applyPreset(preset);
    };
    presetsEl.addEventListener('click', (e) => activatePreset(e.target));
    presetsEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activatePreset(e.target); }
    });
  }

  /** Пресеты из EditorConfig.overlay.presets (конфиг проекта, не редактируются). */
  _renderPresetsPanel() {
    const p = this._panel;
    if (!p) return;
    const presets = this._presets;
    const wrap = p.querySelector('.overlay-panel__presets');
    const list = p.querySelector('.overlay-panel__presets-list');
    list.innerHTML = '';
    if (!presets?.length) { wrap.style.display = 'none'; return; }
    wrap.style.display = '';
    presets.forEach((preset, idx) => {
      const items = Array.isArray(preset.items) ? preset.items : [];
      const title = preset.label || `Пресет ${idx + 1}`;
      const card  = this._buildCard({
        title, summary: title,
        textItems: items.filter(it => it.type === 'text'),
        imgItems:  items.filter(it => it.type === 'image'),
      });
      card.dataset.index = String(idx);
      list.appendChild(card);
    });
  }

  /** Добавляет оверлеи пресета к текущим. Координаты — доли (0..1) от размера области. */
  async _applyPreset(preset) {
    if (!preset?.items || this._applyingEntry) return;
    this._applyingEntry = true;
    const cw = this.viewW || 400, ch = this.viewH || 300;
    try {
      for (const item of preset.items) {
        const w = Math.round((item.wPct || 0.25) * cw);
        const h = item.hPct ? Math.round(item.hPct * ch) : null;
        const x = item.xPct != null ? Math.round(item.xPct * cw - w / 2) : Math.round((cw - w) / 2);
        const y = item.yPct != null ? Math.round(item.yPct * ch - (h || w) / 2) : Math.round((ch - (h || w)) / 2);
        const opacity = item.opacity ?? 1;

        if (item.type === 'text') {
          this.addTextOverlay({
            text: item.text || 'Текст', fontFamily: item.fontFamily || 'sans-serif',
            fontSize: item.fontSize || 48, fontWeight: item.fontWeight || 'normal',
            color: item.color || '#ffffff', strokeColor: item.strokeColor || '#000000',
            strokeWidth: item.strokeWidth ?? 2,
            x, y, width: w, height: h || Math.round(w * 0.3), opacity,
          });
        } else if (item.type === 'image' && item.src) {
          try {
            const img = await loadOverlayImage(item.src);
            if (!this.isActive) return;
            const oh = h || Math.round(w * (img.naturalHeight / (img.naturalWidth || 1)));
            this.addImageOverlay(img, { srcDataUrl: item.src, x, y, width: w, height: oh, opacity });
          } catch (err) { console.warn('[OverlayTool] пресет:', err.message); }
        }
      }
    } finally {
      this._applyingEntry = false;
    }
    this._syncPanel(); this.requestDraw();
  }
}
