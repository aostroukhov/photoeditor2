import { EditorConfig } from './EditorConfig.js';
import { escapeHtml, safeCssColor } from './utils.js';

/**
 * OverlayTool v3.6
 *
 * Изменения v3.6:
 *  • Все внутренние поля и методы переведены на ES2022 Private Fields (#).
 *  • Bound-обработчики событий объявлены как приватные поля — гарантирует
 *    корректный removeEventListener и исключает подмену снаружи.
 *  • Убраны вызовы _handleToolStop (метод удалён из PhotoEditor v3.6).
 *  • apply() больше не экспортирует в this.photoEditor.export автоматически —
 *    сохранение в источник только через requestClose().
 *  • destroyCanvas() переименован в destroy() для единообразия API инструментов.
 *  • Добавлен публичный метод redraw() — тонкая обёртка над #draw().
 *    Нужен для вызова из других инструментов (CropTool.crop()), поскольку
 *    ES2022 Private Fields запрещают доступ к #draw() из чужого класса.
 *
 * ── Архитектурная заметка о redraw() ─────────────────────────────────────────
 *
 * #draw() намеренно приватный: он управляет внутренним состоянием canvas
 * и не должен вызываться произвольно. Единственный легитимный внешний вызов —
 * уведомление от CropTool о смене изображения после crop(), что требует
 * перерисовки незакоммиченных оверлеев. Именно для этого и существует redraw().
 *
 * ── Жизненный цикл ───────────────────────────────────────────────────────────
 *   start()         — активация или resume из suspended-состояния.
 *   suspend()       — приостановка: скрываем UI, сохраняем overlays[].
 *   cancel()        — отмена: уничтожаем canvas без записи в img.
 *   apply()         — применение: записываем оверлеи в img через commitImage().
 *   openSettings()  — повторный клик по кнопке инструмента.
 *   destroy()       — полный сброс при PhotoEditor.close().
 *
 * Оверлеи НЕ наносятся на photoEditor.img до нажатия «Применить».
 * При переключении инструментов canvas скрывается (suspend),
 * настройки и оверлеи сохраняются до следующего resume().
 *
 * ── Публичные поля ────────────────────────────────────────────────────────────
 *   isActive, isSuspended
 *   overlayCanvas, overlayCtx   (CropTool проверяет overlayCanvas)
 *   overlays, selected
 *
 * ── Публичные методы ─────────────────────────────────────────────────────────
 *   start(), suspend(), cancel(), apply(), openSettings(), destroy()
 *   renderToCanvas()
 *   onKeyDown(e)
 *   addTextOverlay(opts), addImageOverlay(source, opts)
 *   redraw()
 *
 * ── Приватные поля (#) ────────────────────────────────────────────────────────
 *   #historySize, #stopping, #suspending
 *   #drag, #resize, #rotate, #panel
 *   Bound-обработчики: #onMouseDownBound и т.д.
 */

const HANDLE_RADIUS     = EditorConfig.overlay.handleRadius;
const MIN_SIZE          = EditorConfig.overlay.minSize;
const ROTATE_OFFSET     = EditorConfig.overlay.rotateOffset;
const HISTORY_KEY       = EditorConfig.overlay.historyKey;
const TEXT_SETTINGS_KEY = EditorConfig.overlay.textSettingsKey;
const MAX_OVERLAY_FRAC  = EditorConfig.overlay.maxOverlayFrac;

const FONT_FAMILIES = [
  'sans-serif', 'serif', 'monospace', 'cursive', 'fantasy',
  'Arial', 'Arial Black', 'Verdana', 'Tahoma', 'Trebuchet MS',
  'Georgia', 'Times New Roman', 'Courier New', 'Impact',
];

function _loadTextSettings() {
  try {
    const raw = localStorage.getItem(TEXT_SETTINGS_KEY);
    if (!raw) return {};
    return JSON.parse(raw);
  } catch { return {}; }
}

function _saveTextSettings(settings) {
  try { localStorage.setItem(TEXT_SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}


// ─── Модели ───────────────────────────────────────────────────────────────────

class Overlay {
  constructor({ x=100, y=100, width=200, height=80, rotation=0, opacity=1, lockAspect=true } = {}) {
    this.x = x; this.y = y; this.width = width; this.height = height;
    this.rotation = rotation; this.opacity = opacity; this.lockAspect = lockAspect;
    this.id = Overlay._nextId++;
  }
  get cx() { return this.x + this.width  / 2; }
  get cy() { return this.y + this.height / 2; }
  render(_ctx) {}
  toJSON() {
    return {
      type: this.constructor.name,
      x: this.x, y: this.y, width: this.width, height: this.height,
      rotation: this.rotation, opacity: this.opacity, lockAspect: this.lockAspect,
    };
  }
}
Overlay._nextId = 1;

export class TextOverlay extends Overlay {
  constructor({
    text = 'Текст', fontFamily = 'sans-serif', fontSize = 48,
    fontWeight = 'bold', color = '#ffffff', strokeColor = '#000000',
    strokeWidth = 2, ...rest
  } = {}) {
    super(rest);
    this.text        = text;
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
    ctx.globalAlpha   = this.opacity;
    ctx.translate(this.cx, this.cy); ctx.rotate(this.rotation);
    ctx.font          = this.font;
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'middle';
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
    ctx.drawImage(this.source, -this.width/2, -this.height/2, this.width, this.height);
    ctx.restore();
  }
  toJSON() { return { ...super.toJSON(), srcDataUrl: this.srcDataUrl }; }
}


// ─── OverlayTool ──────────────────────────────────────────────────────────────

export class OverlayTool {

  // ── Приватные поля ──────────────────────────────────────────────────────────

  /** Максимальная глубина истории оверлеев (число сохранённых наборов). */
  #historySize;

  /**
   * true — идёт destroy/cancel; предотвращает повторный вход
   * (например, если onClose панели вызывает cancel()).
   */
  /** true — идёт асинхронное восстановление набора из истории. */
  #applyingEntry = false;
  #stopping = false;

  /**
   * true — идёт programmatic suspend(); предотвращает вызов suspend()
   * из onClose панели при закрытии диалога изнутри suspend().
   */
  #suspending = false;

  /** Состояние перетаскивания оверлея: { startX, startY, origX, origY }. */
  #drag   = null;
  /** Состояние resize оверлея: { handle, origW, origH, origX, origY, aspectRatio }. */
  #resize = null;
  /** Состояние вращения оверлея: { startAngle }. */
  #rotate = null;

  /** DOM-элемент панели управления. null когда инструмент неактивен. */
  #panel  = null;

  // ── Bound-обработчики событий ─────────────────────────────────────────────
  //
  // Приватные стрелочные поля: один объект функции на весь жизненный цикл.
  // Это обязательное условие для корректного removeEventListener.
  // Без этого каждый вызов _bindEvents создаёт новый объект → утечка слушателей.

  #onMouseDownBound  = (e) => this.#onMouseDown(e);
  #onMouseMoveBound  = (e) => this.#onMouseMove(e);
  #onMouseUpBound    = ()  => this.#onMouseUp();
  #onTouchStartBound = (e) => this.#onTouchStart(e);
  #onTouchMoveBound  = (e) => this.#onTouchMove(e);
  #onTouchEndBound   = ()  => this.#onTouchEnd();
  #onWinResizeBound  = ()  => this.#onWinResize();


  // ── Публичные поля ──────────────────────────────────────────────────────────

  /** true — инструмент активен (canvas виден, события привязаны). */
  isActive    = false;
  /** true — приостановлен (оверлеи сохранены, canvas скрыт). */
  isSuspended = false;

  /**
   * Canvas-оверлей поверх imgElement.
   * Публичный: CropTool проверяет его наличие перед вызовом redraw().
   */
  overlayCanvas = null;
  /** 2D-контекст overlayCanvas. */
  overlayCtx    = null;

  /** Все оверлеи текущей сессии (сохраняются между suspend/resume). */
  overlays  = [];
  /** Выбранный оверлей или null. */
  selected  = null;


  // ── Конструктор ─────────────────────────────────────────────────────────────

  constructor(photoEditor, opts = {}) {
    this.photoEditor  = photoEditor;
    this.#historySize = opts.historySize ?? EditorConfig.overlay.historySize;
  }


  // ── Публичный API: жизненный цикл ───────────────────────────────────────────

  start() {
    if (this.isSuspended) { this.#resume(); return; }
    if (this.isActive)    return;

    const imgEl = this.photoEditor.imgElement;
    if (!imgEl || !imgEl.naturalWidth) {
      imgEl?.addEventListener('load', () => {
        if (this.photoEditor.imgElement?.naturalWidth) this.start();
      }, { once: true });
      return;
    }

    this.isActive = true;
    this.photoEditor.activeTool = this;
    this.#createCanvas();
    this.#showCanvas();
    this.#createPanel();
    this.#bindEvents();
    this.#draw();
    this.photoEditor.syncToolButtons?.();
  }

  /**
   * Приостановить — скрыть canvas и панель, сохранить overlays[].
   * Состояние переживает переключение на другой инструмент.
   */
  suspend() {
    if (!this.isActive || this.isSuspended) return;

    this.#unbindEvents();
    this.selected = null;

    if (this.overlayCanvas) {
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
      this.overlayCanvas.style.pointerEvents = 'none';
      this.#draw();
    }

    // Флаг: предотвращает вызов suspend() из onClose панели во время suspend()
    this.#suspending = true;
    this.photoEditor.dialogs?.close('overlay');
    this.#suspending = false;

    this.isActive    = false;
    this.isSuspended = true;
    this.photoEditor.activeTool = null;
    this.photoEditor.syncToolButtons?.();
  }

  /** Отмена — уничтожить canvas и панель без записи в img. */
  cancel() {
    this.overlays = [];
    this.selected = null;
    this.#destroyInternal();
  }

  /**
   * Применить — нанести оверлеи на изображение через commitImage().
   * Сохранение в источник (this.photoEditor.export) происходит только
   * при явном закрытии через requestClose().
   */
  apply() {
    this.#saveHistory();
    const result = this.renderToCanvas();
    this.photoEditor.commitCanvas(result).catch(err => console.error('[OverlayTool] apply():', err));

    this.overlays = [];
    this.selected = null;
    this.#destroyInternal();
  }

  /** Повторный клик по кнопке инструмента в тулбаре — переключить панель. */
  openSettings() {
    this.photoEditor.dialogs?.toggle('overlay');
  }

  /**
   * Полный сброс при PhotoEditor.close().
   * Переименован из destroyCanvas() для единообразия API инструментов.
   */
  destroy() {
    this.overlays = [];
    this.selected = null;
    this.#destroyInternal();
    this.overlayCanvas?.remove();
    this.overlayCanvas = null;
    this.overlayCtx    = null;
  }

  /**
   * Публичная обёртка над #draw() для вызова из других инструментов.
   *
   * Необходима потому что ES2022 Private Fields запрещают обращение
   * к #draw() из кода другого класса — это SyntaxError при парсинге.
   * CropTool.crop() вызывает redraw() после смены изображения, чтобы
   * незакоммиченные оверлеи отрисовались поверх нового img.
   */
  redraw() {
    this.#draw();
  }

  /**
   * Обработчик клавиатуры — вызывается из PhotoEditor#onKeyDown.
   * Возвращает true если событие обработано.
   *
   * @param {KeyboardEvent} e
   * @returns {boolean}
   */
  onKeyDown(e) {
    if (e.key === 'Escape') { this.cancel(); return true; }
    if (!this.selected) return false;
    const step = e.shiftKey ? 10 : 1;
    switch (e.key) {
      case 'ArrowUp':    this.selected.y -= step; break;
      case 'ArrowDown':  this.selected.y += step; break;
      case 'ArrowLeft':  this.selected.x -= step; break;
      case 'ArrowRight': this.selected.x += step; break;
      case 'Home':    this.#centerSelected(); break;
      case 'Delete':
      case 'Backspace': this.#removeOverlay(this.selected); break;
      default: return false;
    }
    this.#draw(); this.#syncPanel(); return true;
  }


  // ── Публичный API: экспорт ───────────────────────────────────────────────────

  /**
   * Рендерит итоговый canvas: pe.img + все оверлеи в натуральном разрешении.
   * Используется в apply() и ExportPanel (#getResultCanvas).
   *
   * @returns {HTMLCanvasElement}
   * @throws {Error} Если pe.img не задан.
   */
  renderToCanvas() {
    const pe  = this.photoEditor;
    const img = pe.img;
    if (!img) throw new Error('[OverlayTool] renderToCanvas: img не задан');

    const out = document.createElement('canvas');
    out.width  = img.naturalWidth;
    out.height = img.naturalHeight;
    const ctx  = out.getContext('2d');
    ctx.drawImage(img, 0, 0);

    if (!this.overlays.length) return out;

    const dispW = pe.imgElement?.width || out.width;
    const k     = img.naturalWidth / dispW;
    this.overlays.forEach(ov => {
      ctx.save(); ctx.scale(k, k); ov.render(ctx); ctx.restore();
    });
    return out;
  }


  // ── Публичный API: управление оверлеями ─────────────────────────────────────

  /**
   * Добавляет текстовый оверлей с настройками из последнего сохранения (localStorage).
   * @param {object} [opts]  Переопределение параметров TextOverlay.
   * @returns {TextOverlay}
   */
  addTextOverlay(opts = {}) {
    const cw    = this.overlayCanvas?.width  || 400;
    const ch    = this.overlayCanvas?.height || 300;
    const saved = _loadTextSettings();
    const ov    = new TextOverlay({
      x: Math.round(cw * 0.35), y: Math.round(ch * 0.42),
      width:       Math.round(cw * MAX_OVERLAY_FRAC),
      height:      Math.round(ch * MAX_OVERLAY_FRAC * 0.35),
      fontFamily:  saved.fontFamily  || 'sans-serif',
      fontSize:    saved.fontSize    || 48,
      fontWeight:  saved.fontWeight  || 'bold',
      color:       saved.color       || '#ffffff',
      strokeColor: saved.strokeColor || '#000000',
      strokeWidth: saved.strokeWidth ?? 2,
      ...opts,
    });
    this.#addOverlay(ov);
    return ov;
  }

  /**
   * Добавляет оверлей изображения, масштабируя его под canvas.
   * @param {HTMLImageElement} source
   * @param {object}           [opts]  Переопределение параметров ImageOverlay.
   * @returns {ImageOverlay}
   */
  addImageOverlay(source, opts = {}) {
    const cw   = this.overlayCanvas?.width  || 400;
    const ch   = this.overlayCanvas?.height || 300;
    const srcW = source.naturalWidth  || source.width  || cw * MAX_OVERLAY_FRAC;
    const srcH = source.naturalHeight || source.height || ch * MAX_OVERLAY_FRAC;
    const k    = Math.min(1, (cw * MAX_OVERLAY_FRAC) / srcW, (ch * MAX_OVERLAY_FRAC) / srcH);
    const ov   = new ImageOverlay({
      source,
      x: Math.round((cw - srcW*k) / 2),
      y: Math.round((ch - srcH*k) / 2),
      width:  Math.round(srcW*k),
      height: Math.round(srcH*k),
      ...opts,
    });
    this.#addOverlay(ov);
    return ov;
  }


  // ── Приватные методы: жизненный цикл ────────────────────────────────────────

  #resume() {
    if (!this.isSuspended) return;
    const imgEl = this.photoEditor.imgElement;
    if (!imgEl || !imgEl.naturalWidth) return;

    this.isActive    = true;
    this.isSuspended = false;
    this.photoEditor.activeTool = this;

    if (this.overlayCanvas) {
      this.overlayCanvas.style.pointerEvents = '';
    } else {
      this.#createCanvas();
    }

    this.#showCanvas();
    if (this.#panel) {
      this.photoEditor.dialogs?.open('overlay');
    } else {
      this.#createPanel();
    }

    this.#bindEvents();
    this.#draw();
    this.photoEditor.syncToolButtons?.();
  }

  /**
   * @param {boolean} [silent=false]  Не трогать диалог — при destroy() DOM уже разрушается.
   */
  #destroyInternal() {
    if (this.#stopping) return;
    this.#stopping = true;

    this.#unbindEvents();

    // Canvas не удаляем при обычном cancel/apply — только при полном destroy()
    if (!this.isSuspended) {
      if (this.overlayCanvas) {
        this.overlayCanvas.remove();
        this.overlayCanvas = null;
        this.overlayCtx    = null;
      }
    }

    const panel = this.#panel;
    this.#panel = null;
    if (panel) {
      this.photoEditor.dialogs?.unregister('overlay');
      panel.remove();
    }

    this.isActive    = false;
    this.isSuspended = false;
    this.#stopping   = false;
    this.photoEditor.activeTool = null;
    this.photoEditor.syncToolButtons?.();
  }

  #showCanvas() {
    if (this.overlayCanvas) this.overlayCanvas.style.pointerEvents = '';
  }


  // ── Приватные методы: управление оверлеями ──────────────────────────────────

  #addOverlay(ov) {
    this.overlays.push(ov);
    this.selected = ov;
    this.#draw(); this.#syncPanel();
  }

  #removeOverlay(ov) {
    this.overlays = this.overlays.filter(o => o !== ov);
    if (this.selected === ov) this.selected = this.overlays.at(-1) ?? null;
    this.#draw(); this.#syncPanel();
  }

  /** Центрировать выбранный оверлей по обеим осям. */
  #centerSelected() {
    const ov = this.selected;
    if (!ov || !this.overlayCanvas) return;
    ov.x = Math.round((this.overlayCanvas.width  - ov.width)  / 2);
    ov.y = Math.round((this.overlayCanvas.height - ov.height) / 2);
  }



  // ── Приватные методы: история ────────────────────────────────────────────────

  /**
   * Сохраняет текущий набор оверлеев в localStorage-историю.
   * Вызывается в apply() перед записью в img.
   */
  #saveHistory() {
    if (!this.overlays.length) return;
    try {
      const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
      raw.unshift({ overlays: this.overlays.map(o => o.toJSON()) });
      raw.splice(this.#historySize);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(raw));
    } catch {}
  }

  #loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]'); }
    catch { return []; }
  }

  #deleteHistoryEntry(idx) {
    try {
      const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]');
      raw.splice(idx, 1);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(raw));
    } catch {}
    this.#renderHistoryPanel();
  }

  /**
   * Восстанавливает набор оверлеев из записи истории.
   * TextOverlay восстанавливается мгновенно, ImageOverlay — через Promise (загрузка img).
   *
   * @param {{ overlays: object[] }} entry
   */
  async #applyHistoryEntry(entry) {
    if (this.#applyingEntry) return;   // карточку кликнули повторно до загрузки картинок
    this.#applyingEntry = true;
    this.overlays = []; this.selected = null;
    try {
    for (const d of entry.overlays ?? []) {
      if (d.type === 'TextOverlay') {
        // Обратная совместимость: старые записи хранят font='bold 48px sans-serif'
        if (d.font && !d.fontFamily) {
          const m = d.font.match(/^(\w+)\s+(\d+)px\s+(.+)$/);
          if (m) { d.fontWeight = m[1]; d.fontSize = Number(m[2]); d.fontFamily = m[3]; }
        }
        this.overlays.push(new TextOverlay(d));
      } else if (d.type === 'ImageOverlay' && d.srcDataUrl) {
        await new Promise(res => {
          const img   = new Image();
          img.onload  = () => { this.overlays.push(new ImageOverlay({ ...d, source: img })); res(); };
          img.onerror = res;
          img.src     = d.srcDataUrl;
        });
      }
    }
    } finally {
      this.#applyingEntry = false;
    }
    this.selected = this.overlays.at(-1) ?? null;
    this.#draw(); this.#syncPanel(); this.#renderHistoryPanel();
  }


  // ── Приватные методы: canvas ─────────────────────────────────────────────────

  #createCanvas() {
    if (this.overlayCanvas) return;
    const imgEl = this.photoEditor.imgElement;
    const w = imgEl?.offsetWidth  || imgEl?.width  || this.photoEditor.img?.naturalWidth  || 400;
    const h = imgEl?.offsetHeight || imgEl?.height || this.photoEditor.img?.naturalHeight || 300;

    this.overlayCanvas        = document.createElement('canvas');
    this.overlayCanvas.width  = w;
    this.overlayCanvas.height = h;
    this.overlayCtx           = this.overlayCanvas.getContext('2d');

    const parent = imgEl?.parentElement
      || this.photoEditor.container?.querySelector('.photoeditor__img-container');
    parent?.appendChild(this.overlayCanvas);
  }

  /**
   * Синхронизирует размер canvas с текущим display-размером imgElement.
   * При изменении масштабирует координаты и размеры всех оверлеев.
   */
  #syncCanvasSize() {
    const imgEl = this.photoEditor.imgElement;
    if (!imgEl || !this.overlayCanvas) return;
    const newW = imgEl.offsetWidth  || imgEl.width;
    const newH = imgEl.offsetHeight || imgEl.height;
    if (!newW || !newH) return;
    const kx = newW / this.overlayCanvas.width;
    const ky = newH / this.overlayCanvas.height;
    if (Math.abs(kx-1) > 0.001 || Math.abs(ky-1) > 0.001) {
      this.overlays.forEach(ov => {
        ov.x *= kx; ov.y *= ky; ov.width *= kx; ov.height *= ky;
        // Глифы текста задаются fontSize, а не рамкой — масштабируем и их,
        // иначе после ресайза окна ручки перестают совпадать с текстом.
        if (ov instanceof TextOverlay) {
          ov.fontSize    = Math.max(1, ov.fontSize * ky);
          ov.strokeWidth = ov.strokeWidth * ky;
        }
      });
    }
    this.overlayCanvas.width  = newW;
    this.overlayCanvas.height = newH;
  }


  // ── Приватные методы: отрисовка ──────────────────────────────────────────────

  #draw() {
    if (!this.overlayCtx) return;
    this.#syncCanvasSize();
    const ctx = this.overlayCtx;
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    this.overlays.forEach(ov => {
      ov.render(ctx);
      // Ручки трансформации — только когда инструмент активен
      if (ov === this.selected && this.isActive) this.#drawHandles(ctx, ov);
    });
  }

  #drawHandles(ctx, ov) {
    const c = this.#getCorners(ov);
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(c[0].x, c[0].y);
    c.slice(1).forEach(p => ctx.lineTo(p.x, p.y));
    ctx.closePath(); ctx.stroke();

    ctx.fillStyle = 'rgba(60,143,224,0.9)';
    c.forEach(p => {
      ctx.beginPath(); ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI*2);
      ctx.fill(); ctx.stroke();
    });

    const rh  = this.#getRotateHandle(ov);
    const mid = { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2 };
    ctx.beginPath(); ctx.moveTo(mid.x, mid.y); ctx.lineTo(rh.x, rh.y); ctx.stroke();

    ctx.fillStyle = 'rgba(255,210,0,0.95)';
    ctx.beginPath(); ctx.arc(rh.x, rh.y, HANDLE_RADIUS, 0, Math.PI*2);
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }


  // ── Приватные методы: геометрия ─────────────────────────────────────────────

  /** Возвращает мировые координаты четырёх углов оверлея с учётом вращения. */
  #getCorners(ov) {
    const hw = ov.width/2, hh = ov.height/2;
    const cos = Math.cos(ov.rotation), sin = Math.sin(ov.rotation);
    return [[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].map(([lx, ly]) => ({
      x: ov.cx + lx*cos - ly*sin,
      y: ov.cy + lx*sin + ly*cos,
    }));
  }

  /** Возвращает мировые координаты ручки вращения (над центром верхней грани). */
  #getRotateHandle(ov) {
    const c   = this.#getCorners(ov);
    const mx  = (c[0].x + c[1].x) / 2, my = (c[0].y + c[1].y) / 2;
    const dx  = mx - ov.cx, dy = my - ov.cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: mx + dx/len * ROTATE_OFFSET, y: my + dy/len * ROTATE_OFFSET };
  }

  /** Переводит мировые координаты в локальные (центр оверлея = 0,0, угол = 0). */
  #worldToLocal(ov, wx, wy) {
    const dx  = wx - ov.cx, dy = wy - ov.cy;
    const cos = Math.cos(-ov.rotation), sin = Math.sin(-ov.rotation);
    return { lx: dx*cos - dy*sin, ly: dx*sin + dy*cos };
  }

  /**
   * Hit-test по всем оверлеям (от верхнего к нижнему).
   * @returns {{ type: 'rotate'|'resize'|'move', ov: Overlay, handle?: string }|null}
   */
  #hitTest(x, y) {
    for (let i = this.overlays.length - 1; i >= 0; i--) {
      const ov = this.overlays[i];

      // Ручки рисуются только у выбранного оверлея — у остальных их проверять
      // нельзя: клик рядом с невидимой ручкой начинал вращение «чужого» оверлея.
      if (ov === this.selected) {
        const rh = this.#getRotateHandle(ov);
        if (Math.hypot(x - rh.x, y - rh.y) <= HANDLE_RADIUS + 6)
          return { type: 'rotate', ov };

        const names   = ['topLeft','topRight','bottomRight','bottomLeft'];
        const corners = this.#getCorners(ov);
        for (let j = 0; j < 4; j++) {
          if (Math.hypot(x - corners[j].x, y - corners[j].y) <= HANDLE_RADIUS + 6)
            return { type: 'resize', handle: names[j], ov };
        }
      }

      const { lx, ly } = this.#worldToLocal(ov, x, y);
      if (Math.abs(lx) <= ov.width/2 && Math.abs(ly) <= ov.height/2)
        return { type: 'move', ov };
    }
    return null;
  }


  // ── Приватные методы: взаимодействие ────────────────────────────────────────

  #clientToCanvas(cx, cy) {
    const r = this.overlayCanvas.getBoundingClientRect();
    return {
      x: (cx - r.left) * (this.overlayCanvas.width  / r.width),
      y: (cy - r.top)  * (this.overlayCanvas.height / r.height),
    };
  }

  #onMouseDown(e) {
    if (e.button !== 0) return;
    const { x, y } = this.#clientToCanvas(e.clientX, e.clientY);
    this.#startInteraction(x, y);
  }
  #onMouseMove(e) {
    const { x, y } = this.#clientToCanvas(e.clientX, e.clientY);
    this.#updateCursor(x, y); this.#continueInteraction(x, y);
  }
  #onMouseUp() { this.#endInteraction(); }

  #onTouchStart(e) {
    if (e.touches.length !== 1) return;
    e.preventDefault();
    const { x, y } = this.#clientToCanvas(e.touches[0].clientX, e.touches[0].clientY);
    this.#startInteraction(x, y);
  }
  #onTouchMove(e) {
    if (!this.#drag && !this.#resize && !this.#rotate) return;
    e.preventDefault();
    const { x, y } = this.#clientToCanvas(e.touches[0].clientX, e.touches[0].clientY);
    this.#continueInteraction(x, y);
  }
  #onTouchEnd() { this.#endInteraction(); }

  #onWinResize() {
    requestAnimationFrame(() => requestAnimationFrame(() => this.#draw()));
  }

  #startInteraction(x, y) {
    const hit = this.#hitTest(x, y);
    if (!hit) { this.selected = null; this.#draw(); this.#syncPanel(); return; }

    const { type, ov, handle } = hit;
    if (this.selected !== ov) {
      this.selected = ov;
      // Поднимаем выбранный оверлей на верх стека (последний рендерится поверх)
      const idx = this.overlays.indexOf(ov);
      this.overlays.splice(idx, 1); this.overlays.push(ov);
      this.#draw(); this.#syncPanel();
    }

    if      (type === 'move')   this.#drag   = { startX: x, startY: y, origX: ov.x, origY: ov.y };
    else if (type === 'resize') this.#resize = { handle, origW: ov.width, origH: ov.height, origX: ov.x, origY: ov.y, aspectRatio: ov.width / ov.height, origFontSize: ov.fontSize };
    else if (type === 'rotate') this.#rotate = { startAngle: Math.atan2(y - ov.cy, x - ov.cx) - ov.rotation };
  }

  #continueInteraction(x, y) {
    const ov = this.selected; if (!ov) return;

    if (this.#drag) {
      ov.x = this.#drag.origX + (x - this.#drag.startX);
      ov.y = this.#drag.origY + (y - this.#drag.startY);
    }

    if (this.#rotate) {
      ov.rotation = Math.atan2(y - ov.cy, x - ov.cx) - this.#rotate.startAngle;
    }

    if (this.#resize) {
      const r = this.#resize;
      const { lx: dlx, ly: dly } = this.#worldToLocal(ov, x, y);
      let newW, newH;
      switch (r.handle) {
        case 'bottomRight': { const dx=dlx-r.origW/2, dy=dly-r.origH/2; newW=Math.max(MIN_SIZE,r.origW+dx*2); newH=ov.lockAspect?newW/r.aspectRatio:Math.max(MIN_SIZE,r.origH+dy*2); break; }
        case 'topLeft':     { const dx=dlx+r.origW/2, dy=dly+r.origH/2; newW=Math.max(MIN_SIZE,r.origW-dx*2); newH=ov.lockAspect?newW/r.aspectRatio:Math.max(MIN_SIZE,r.origH-dy*2); break; }
        case 'topRight':    { const dx=dlx-r.origW/2, dy=dly+r.origH/2; newW=Math.max(MIN_SIZE,r.origW+dx*2); newH=ov.lockAspect?newW/r.aspectRatio:Math.max(MIN_SIZE,r.origH-dy*2); break; }
        case 'bottomLeft':  { const dx=dlx+r.origW/2, dy=dly-r.origH/2; newW=Math.max(MIN_SIZE,r.origW-dx*2); newH=ov.lockAspect?newW/r.aspectRatio:Math.max(MIN_SIZE,r.origH+dy*2); break; }
        default: newW = ov.width; newH = ov.height;
      }
      ov.width  = newW; ov.height = newH;
      ov.x = r.origX + (r.origW - newW) / 2;
      ov.y = r.origY + (r.origH - newH) / 2;
      // Для текста растягивание рамки меняет размер шрифта пропорционально высоте
      if (ov instanceof TextOverlay && r.origFontSize) {
        ov.fontSize = Math.max(1, Math.round(r.origFontSize * newH / r.origH));
      }
    }

    this.#draw(); this.#syncPanel();
  }

  #endInteraction() {
    this.#drag = null; this.#resize = null; this.#rotate = null;
    if (this.overlayCanvas) this.overlayCanvas.style.cursor = 'default';
  }

  #updateCursor(x, y) {
    if (this.#drag || this.#resize || this.#rotate) return;
    const hit = this.#hitTest(x, y);
    this.overlayCanvas.style.cursor = !hit           ? 'default'
      : hit.type === 'rotate' ? 'crosshair'
      : hit.type === 'resize' ? 'nwse-resize'
      : 'move';
  }


  // ── Приватные методы: подписка на события ───────────────────────────────────

  #bindEvents() {
    const c = this.overlayCanvas;
    c.addEventListener('mousedown',  this.#onMouseDownBound);
    c.addEventListener('touchstart', this.#onTouchStartBound, { passive: false });
    document.addEventListener('mousemove', this.#onMouseMoveBound);
    document.addEventListener('mouseup',   this.#onMouseUpBound);
    document.addEventListener('touchmove', this.#onTouchMoveBound, { passive: false });
    document.addEventListener('touchend',  this.#onTouchEndBound);
    window.addEventListener('resize',      this.#onWinResizeBound);
  }

  #unbindEvents() {
    if (!this.overlayCanvas) return;
    const c = this.overlayCanvas;
    c.removeEventListener('mousedown',  this.#onMouseDownBound);
    c.removeEventListener('touchstart', this.#onTouchStartBound);
    document.removeEventListener('mousemove', this.#onMouseMoveBound);
    document.removeEventListener('mouseup',   this.#onMouseUpBound);
    document.removeEventListener('touchmove', this.#onTouchMoveBound);
    document.removeEventListener('touchend',  this.#onTouchEndBound);
    window.removeEventListener('resize',      this.#onWinResizeBound);
  }


  // ── Приватные методы: панель управления ──────────────────────────────────────

  #createPanel() {
    if (this.#panel) return;

    const panel = document.createElement('div');
    panel.className = 'pe-panel pe-panel--overlay';
    panel.innerHTML = `
      <div class="pe-panel__header">
        <div class="overlay-panel__add-btns">
          <button type="button" class="photoeditor__button photoeditor__button--compact overlay-panel__btn-add-text"
                  title="Добавить текст">
            +<i class="icon-text" aria-hidden="true"></i>
          </button>
          <button type="button" class="photoeditor__button photoeditor__button--compact overlay-panel__btn-add-image"
                  title="Добавить изображение">
            <i class="icon-add-photo" aria-hidden="true"></i>
          </button>
        </div>
        <div class="pe-panel__header-actions">
          <button type="button" class="photoeditor__button photoeditor__button--compact overlay-panel__btn-cancel"
                  title="Отмена — убрать все оверлеи">
            <i class="icon-close" aria-hidden="true"></i> Отмена
          </button>
          <button type="button" class="photoeditor__button photoeditor__button--compact photoeditor__button--success overlay-panel__btn-apply"
                  title="Нанести оверлеи на изображение">
            <i class="icon-checkmark" aria-hidden="true"></i> Применить
          </button>
        </div>
      </div>
      <div class="overlay-panel__row overlay-panel__row--selected" style="display:none">
        <button type="button" class="photoeditor__button photoeditor__button--compact photoeditor__button--danger overlay-panel__btn-delete"
                disabled title="Удалить оверлей">
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
        <button type="button"
                class="photoeditor__button photoeditor__button--compact overlay-panel__btn-center"
                title="Центрировать (Home)">
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

    this.#bindPanelEvents(panel);
    this.#bindHistoryList(panel);
    this.photoEditor.container.appendChild(panel);
    this.#panel = panel;

    this.photoEditor.dialogs?.register('overlay', panel, {
      group:   'tool',
      onClose: () => {
        // Пользователь закрыл крестиком → suspend (сохраняем оверлеи).
        // Programmatic close (из suspend()) → игнорируем.
        if (this.isActive && !this.#stopping && !this.#suspending) {
          this.suspend();
        }
      },
    });
    this.photoEditor.dialogs?.open('overlay');
    this.#renderHistoryPanel();
    this.#renderPresetsPanel();
  }

  #bindPanelEvents(p) {
    // +Текст
    p.querySelector('.overlay-panel__btn-add-text').addEventListener('click', () => {
      if (!this.isActive) return;
      this.addTextOverlay({ text: 'Текст' });
      this.#syncPanel();
      const inp = p.querySelector('.overlay-panel__text-input');
      if (inp) { inp.focus(); inp.select(); }
    });

    // +Фото — файловый input без добавления в DOM
    p.querySelector('.overlay-panel__btn-add-image').addEventListener('click', () => {
      if (!this.isActive) return;
      const inp  = document.createElement('input');
      inp.type   = 'file'; inp.accept = 'image/*';
      inp.addEventListener('change', () => {
        const file = inp.files?.[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
          const img   = new Image();
          img.onload  = () => this.addImageOverlay(img, { srcDataUrl: ev.target.result });
          img.src     = ev.target.result;
        };
        reader.readAsDataURL(file);
      });
      inp.click();
    });

    // Удалить / центрировать / отмена / применить
    p.querySelector('.overlay-panel__btn-delete').addEventListener('click',  () => {
      if (this.selected) this.#removeOverlay(this.selected);
    });
    p.querySelector('.overlay-panel__btn-center')?.addEventListener('click', () => {
      if (this.selected) { this.#centerSelected(); this.#draw(); this.#syncPanel(); }
    });
    p.querySelector('.overlay-panel__btn-cancel').addEventListener('click', () => this.cancel());
    p.querySelector('.overlay-panel__btn-apply').addEventListener('click',  () => this.apply());

    // Прозрачность
    const opEl  = p.querySelector('.overlay-panel__opacity');
    const opVal = p.querySelector('.overlay-panel__val-opacity');
    opEl.addEventListener('input', () => {
      if (!this.selected) return;
      this.selected.opacity = opEl.value / 100; opVal.textContent = opEl.value; this.#draw();
    });

    // Поворот
    const rotEl  = p.querySelector('.overlay-panel__rotation');
    const rotVal = p.querySelector('.overlay-panel__val-rotation');
    rotEl.addEventListener('input', () => {
      if (!this.selected) return;
      this.selected.rotation = rotEl.value * Math.PI / 180;
      rotVal.textContent = rotEl.value; this.#draw();
    });

    // Пропорции
    p.querySelector('.overlay-panel__lock-aspect').addEventListener('change', e => {
      if (this.selected) this.selected.lockAspect = e.target.checked;
    });

    // Текстовые поля: передаём изменения в TextOverlay и сохраняем настройки
    const textInp = p.querySelector('.overlay-panel__text-input');
    textInp.addEventListener('input', e => {
      if (this.selected instanceof TextOverlay) { this.selected.text = e.target.value; this.#draw(); }
    });
    // Enter в поле текста не должен всплывать до обработчика редактора (там он применяет кроп)
    textInp.addEventListener('keydown', e => { if (e.key === 'Enter') e.stopPropagation(); });

    p.querySelector('.overlay-panel__text-color').addEventListener('input', e => {
      if (this.selected instanceof TextOverlay) {
        this.selected.color = e.target.value; this.#draw();
        _saveTextSettings(this.#getTextSettings());
      }
    });
    p.querySelector('.overlay-panel__stroke-color').addEventListener('input', e => {
      if (this.selected instanceof TextOverlay) {
        this.selected.strokeColor = e.target.value; this.#draw();
        _saveTextSettings(this.#getTextSettings());
      }
    });
    const swEl  = p.querySelector('.overlay-panel__stroke-width');
    const swVal = p.querySelector('.overlay-panel__val-stroke');
    swEl.addEventListener('input', () => {
      if (this.selected instanceof TextOverlay) {
        this.selected.strokeWidth = Number(swEl.value);
        swVal.textContent = swEl.value; this.#draw();
        _saveTextSettings(this.#getTextSettings());
      }
    });

    const fontFamilyEl = p.querySelector('.overlay-panel__font-family');
    fontFamilyEl.addEventListener('change', () => {
      if (this.selected instanceof TextOverlay) {
        this.selected.fontFamily = fontFamilyEl.value; this.#draw();
        _saveTextSettings(this.#getTextSettings());
      }
    });

    const fontSizeEl  = p.querySelector('.overlay-panel__font-size');
    const fontSizeVal = p.querySelector('.overlay-panel__val-font-size');
    fontSizeEl.addEventListener('input', () => {
      if (this.selected instanceof TextOverlay) {
        this.selected.fontSize = Number(fontSizeEl.value);
        fontSizeVal.textContent = fontSizeEl.value; this.#draw();
        _saveTextSettings(this.#getTextSettings());
      }
    });

    const fontWeightEl = p.querySelector('.overlay-panel__font-weight');
    fontWeightEl.addEventListener('change', () => {
      if (this.selected instanceof TextOverlay) {
        this.selected.fontWeight = fontWeightEl.checked ? 'bold' : 'normal';
        this.#draw();
        _saveTextSettings(this.#getTextSettings());
      }
    });
  }

  /** Собирает текущие настройки текста для сохранения в localStorage. */
  #getTextSettings() {
    const ov = this.selected;
    if (!(ov instanceof TextOverlay)) return {};
    return {
      fontFamily:  ov.fontFamily,
      fontSize:    ov.fontSize,
      fontWeight:  ov.fontWeight,
      color:       ov.color,
      strokeColor: ov.strokeColor,
      strokeWidth: ov.strokeWidth,
    };
  }

  #syncPanel() {
    if (!this.#panel) return;
    const ov      = this.selected;
    const rowSel  = this.#panel.querySelector('.overlay-panel__row--selected');
    const rowText = this.#panel.querySelector('.overlay-panel__row--text');
    const delBtn  = this.#panel.querySelector('.overlay-panel__btn-delete');

    if (!ov) {
      rowSel.style.display = 'none'; rowText.style.display = 'none';
      delBtn.disabled = true; return;
    }
    rowSel.style.display = ''; delBtn.disabled = false;
    const deg = Math.round(ov.rotation * 180 / Math.PI);
    this.#panel.querySelector('.overlay-panel__opacity').value            = Math.round(ov.opacity * 100);
    this.#panel.querySelector('.overlay-panel__val-opacity').textContent  = Math.round(ov.opacity * 100);
    this.#panel.querySelector('.overlay-panel__rotation').value           = deg;
    this.#panel.querySelector('.overlay-panel__val-rotation').textContent = deg;
    this.#panel.querySelector('.overlay-panel__lock-aspect').checked      = ov.lockAspect;

    const isText = ov instanceof TextOverlay;
    rowText.style.display = isText ? '' : 'none';
    if (isText) {
      const inp = this.#panel.querySelector('.overlay-panel__text-input');
      if (document.activeElement !== inp) inp.value = ov.text;
      this.#panel.querySelector('.overlay-panel__text-color').value          = ov.color;
      this.#panel.querySelector('.overlay-panel__stroke-color').value        = ov.strokeColor;
      this.#panel.querySelector('.overlay-panel__stroke-width').value        = ov.strokeWidth;
      this.#panel.querySelector('.overlay-panel__val-stroke').textContent    = ov.strokeWidth;
      this.#panel.querySelector('.overlay-panel__font-family').value         = ov.fontFamily;
      this.#panel.querySelector('.overlay-panel__font-size').value           = ov.fontSize;
      this.#panel.querySelector('.overlay-panel__val-font-size').textContent = ov.fontSize;
      this.#panel.querySelector('.overlay-panel__font-weight').checked       = ov.fontWeight === 'bold';
    }
  }

  #renderHistoryPanel() {
    if (!this.#panel) return;
    const history = this.#loadHistory();
    const histEl  = this.#panel.querySelector('.overlay-panel__history');
    const listEl  = this.#panel.querySelector('.overlay-panel__history-list');
    if (!history.length) { histEl.style.display = 'none'; return; }
    histEl.style.display = ''; listEl.innerHTML = '';

    history.forEach((entry, idx) => {
      const items     = Array.isArray(entry?.overlays) ? entry.overlays : [];
      const textItems = items.filter(o => o.type === 'TextOverlay');
      const imgItems  = items.filter(o => o.type === 'ImageOverlay');
      const summary   = [
        textItems.length ? `${textItems.length}×Т` : '',
        imgItems.length  ? `${imgItems.length}×Ф`  : '',
      ].filter(Boolean).join(' ');

      // Данные из localStorage — недоверенные: экранируем текст и валидируем цвет/URL
      const card = document.createElement('div');
      card.className     = 'overlay-history__card';
      card.title         = 'Кликните чтобы применить';
      card.dataset.index = String(idx);
      card.innerHTML = `
        <button type="button" class="overlay-history__btn-delete" data-index="${idx}" title="Удалить" aria-label="Удалить запись истории">
          <i class="icon-close" aria-hidden="true"></i>
        </button>
        <div class="overlay-history__previews">
          ${textItems.slice(0, 2).map(t => {
            const text = String(t.text ?? '');
            return `<div class="overlay-history__thumb overlay-history__thumb--text"
                  style="color:${safeCssColor(t.color)}" title="${escapeHtml(text)}">${escapeHtml(text.slice(0, 5))}</div>`;
          }).join('')}
          ${imgItems.slice(0, 2).map(im =>
            typeof im.srcDataUrl === 'string' && im.srcDataUrl.startsWith('data:image/')
              ? `<img class="overlay-history__thumb overlay-history__thumb--img" src="${escapeHtml(im.srcDataUrl)}" alt="">`
              : ''
          ).join('')}
        </div>
        <div class="overlay-history__summary">${escapeHtml(summary || 'оверлеи')}</div>`;
      listEl.appendChild(card);
    });
  }

  /**
   * Один делегированный обработчик на список истории — навешивается один раз
   * в #createPanel. Раньше он добавлялся при каждой перерисовке списка, и после
   * N перерисовок один клик выполнялся N раз (удалялось несколько записей,
   * #applyHistoryEntry стартовал параллельно).
   */
  #bindHistoryList(panel) {
    const listEl = panel.querySelector('.overlay-panel__history-list');
    if (!listEl) return;
    listEl.addEventListener('click', e => {
      const delBtn = e.target.closest('.overlay-history__btn-delete');
      if (delBtn) {
        e.stopPropagation();
        this.#deleteHistoryEntry(Number(delBtn.dataset.index));
        return;
      }
      const card = e.target.closest('.overlay-history__card');
      if (!card) return;
      const entry = this.#loadHistory()[Number(card.dataset.index)];
      if (entry) this.#applyHistoryEntry(entry);
    });
  }

  /**
   * Рендерит секцию пресетов из EditorConfig.overlay.presets.
   * Пресеты задаются в конфиге проекта; пользователь их не редактирует.
   * Клик по карточке — немедленное добавление пресета к текущим оверлеям.
   */
  #renderPresetsPanel() {
    if (!this.#panel) return;
    const presets = EditorConfig.overlay.presets;
    const wrap    = this.#panel.querySelector('.overlay-panel__presets');
    const listEl  = this.#panel.querySelector('.overlay-panel__presets-list');
    if (!listEl) return;
    if (!presets?.length) { wrap.style.display = 'none'; return; }

    wrap.style.display = ''; listEl.innerHTML = '';

    presets.forEach((preset, idx) => {
      const card = document.createElement('div');
      card.className = 'overlay-history__card';
      card.title     = preset.label || `Пресет ${idx + 1}`;

      const textItems = preset.items.filter(it => it.type === 'text');
      const imgItems  = preset.items.filter(it => it.type === 'image');

      const previewsEl = document.createElement('div');
      previewsEl.className = 'overlay-history__previews';

      textItems.slice(0, 2).forEach(t => {
        const d = document.createElement('div');
        d.className   = 'overlay-history__thumb overlay-history__thumb--text';
        d.style.color = t.color || '#fff';
        d.title       = t.text || '';
        d.textContent = (t.text || 'T').slice(0, 4);
        previewsEl.appendChild(d);
      });

      imgItems.slice(0, 2).forEach(it => {
        const thumb = document.createElement('div');
        thumb.className = 'overlay-history__thumb overlay-history__thumb--img';
        if (it.src) {
          const img = document.createElement('img');
          img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:0.2em';
          img.src = it.src; img.alt = '';
          img.onerror = () => {
            img.remove();
            thumb.innerHTML = '<i class="icon-image" style="font-size:1.25em;margin:auto"></i>';
            thumb.style.cssText += ';display:flex;align-items:center;justify-content:center';
          };
          thumb.appendChild(img);
        } else {
          thumb.innerHTML = '<i class="icon-image" style="font-size:1.25em;margin:auto"></i>';
          thumb.style.cssText += ';display:flex;align-items:center;justify-content:center';
        }
        previewsEl.appendChild(thumb);
      });

      if (!textItems.length && !imgItems.length) {
        const ic = document.createElement('i');
        ic.className   = 'icon-layers';
        ic.style.cssText = 'font-size:1.5em;opacity:.6;margin:auto';
        previewsEl.style.cssText += ';display:flex;align-items:center;justify-content:center';
        previewsEl.appendChild(ic);
      }

      const summary = document.createElement('div');
      summary.className   = 'overlay-history__summary';
      summary.textContent = card.title;

      card.appendChild(previewsEl);
      card.appendChild(summary);
      card.addEventListener('click', () => this.#applyPreset(preset));
      listEl.appendChild(card);
    });
  }

  /**
   * Добавляет оверлеи пресета к текущим (не очищает существующие).
   * Координаты задаются в процентах (0..1) от размера canvas.
   *
   * @param {{ items: object[], label?: string }} preset
   */
  async #applyPreset(preset) {
    if (!preset?.items) return;
    const cw = this.overlayCanvas?.width  || 400;
    const ch = this.overlayCanvas?.height || 300;

    for (const item of preset.items) {
      const w = Math.round((item.wPct || 0.25) * cw);
      const h = item.hPct ? Math.round(item.hPct * ch) : null;
      const x = item.xPct != null ? Math.round(item.xPct * cw - w / 2) : Math.round((cw - w) / 2);
      const y = item.yPct != null ? Math.round(item.yPct * ch - (h || w) / 2) : Math.round((ch - (h || w)) / 2);
      const opacity = item.opacity ?? 1;

      if (item.type === 'text') {
        this.addTextOverlay({
          text:        item.text        || 'Текст',
          fontFamily:  item.fontFamily  || 'sans-serif',
          fontSize:    item.fontSize    || 48,
          fontWeight:  item.fontWeight  || 'normal',
          color:       item.color       || '#ffffff',
          strokeColor: item.strokeColor || '#000000',
          strokeWidth: item.strokeWidth ?? 2,
          x, y, width: w, height: h || Math.round(w * 0.3), opacity,
        });
      } else if (item.type === 'image' && item.src) {
        await new Promise(resolve => {
          const img = new Image(); img.crossOrigin = 'anonymous';
          img.onload = () => {
            const aspect = img.naturalHeight / (img.naturalWidth || 1);
            const oh     = h || Math.round(w * aspect);
            this.addImageOverlay(img, { srcDataUrl: item.src, x, y, width: w, height: oh, opacity });
            resolve();
          };
          img.onerror = resolve; // не блокируем при ошибке загрузки
          img.src = item.src;
        });
      }
    }

    this.#draw();
    this.#syncPanel();
  }
}
