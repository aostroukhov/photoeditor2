/**
 * ToolBase — базовый класс инструмента PhotoEditor.
 *
 * Берёт на себя всё, что раньше копировалось в каждый инструмент:
 *
 *  • жизненный цикл  start / suspend / resume / cancel / apply / destroy с
 *    флагами реентерабельности и синхронизацией pe.activeTool / кнопок тулбара;
 *  • overlay-canvas поверх изображения с учётом devicePixelRatio: инструмент
 *    рисует в логических CSS-пикселях (viewW × viewH), backing store — в
 *    физических; ResizeObserver следит за размером <img> и вызывает
 *    onViewResize(kx, ky) для пересчёта состояния;
 *  • Pointer Events (мышь, тач, стилус) с захватом указателя и коалесингом
 *    pointermove в один вызов на кадр; pointercancel закрывает жест;
 *  • клавиатура ТОЛЬКО через PhotoEditor → onKeyDown(e) (без собственных
 *    document-слушателей); Escape → cancel(), остальное — onKey(e);
 *  • панель инструмента: регистрация в DialogManager (group 'tool'),
 *    закрытие извне → suspend(), стандартная шапка с «Отмена/Применить»;
 *  • фиксация результата только через pe.commitCanvas(canvas).
 *
 * ── Контракт для наследника ──────────────────────────────────────────────────
 *
 *   constructor(pe)            super(pe, { id: 'myTool', ...опции })
 *   onStart()                  инструмент активирован, canvas и viewW/viewH готовы
 *   onResume()                 возврат из suspend (по умолчанию → onStart())
 *   onSuspend()                уход в фон (панель закрыта, другой инструмент)
 *   onCancel()                 отмена без записи результата
 *   onApply() → canvas|Promise<canvas>|null   результат в натуральном разрешении
 *   onDestroy()                закрытие редактора
 *   onViewResize(kx, ky)       размер области изменился — масштабировать состояние
 *   onDraw(ctx)                перерисовать overlay (ctx уже в логических координатах)
 *   onPointerDown/Move/Up(pt, e), onPointerCancel(e), onHover(pt, e), onHoverEnd(e)
 *   onKey(e) → boolean         горячие клавиши инструмента (кроме Escape)
 *   buildPanel() → HTMLElement|null   разметка панели (с .pe-panel__header)
 *   onPanelReady(panel)        панель вставлена в DOM и зарегистрирована
 *
 * ── Опции конструктора ───────────────────────────────────────────────────────
 *   id              {string}   ключ в TOOL_REGISTRY и DialogManager (обязателен)
 *   useCanvas       {boolean}  создавать overlay-canvas (по умолчанию true)
 *   canvasPointer   {boolean}  canvas принимает указатель (true); false — только отрисовка
 *   hidpi           {boolean}  учитывать devicePixelRatio (true)
 *   cursor          {string}   CSS-курсор над canvas ('default')
 */

import { waitForImage, clientToLogical } from './canvasUtils.js';

export class ToolBase {

  // ── Публичное состояние (читает PhotoEditor) ───────────────────────────────

  /** true — инструмент активен (canvas виден, события привязаны). */
  isActive    = false;
  /** true — приостановлен (состояние сохранено, canvas скрыт). */
  isSuspended = false;

  /** Canvas-оверлей поверх изображения (null, если инструмент без canvas или неактивен). */
  overlayCanvas = null;
  /** 2D-контекст overlayCanvas. */
  overlayCtx    = null;

  // ── Защищённое состояние (для наследников) ─────────────────────────────────

  _panel      = null;
  _stopping   = false;
  _suspending = false;

  _dpr   = 1;
  _viewW = 0;
  _viewH = 0;

  _drawRaf   = null;
  _drawDirty = false;

  _moveRaf     = null;
  _pendingMove = null;
  _pointerId   = null;

  _resizeObserver = null;
  _startPending   = false;

  _onPointerDownBound   = (e) => this._onPointerDown(e);
  _onPointerMoveBound   = (e) => this._onPointerMove(e);
  _onPointerUpBound     = (e) => this._onPointerUp(e);
  _onPointerCancelBound = (e) => this._onPointerCancel(e);
  _onPointerLeaveBound  = (e) => this._onPointerLeave(e);
  _onWindowResizeBound  = ()  => this.requestDraw();

  constructor(photoEditor, opts = {}) {
    if (!opts.id) throw new Error('ToolBase: требуется opts.id');
    this.photoEditor = photoEditor;
    this.id = opts.id;
    this._opts = {
      useCanvas:     true,
      canvasPointer: true,
      hidpi:         true,
      cursor:        'default',
      ...opts,
    };
  }

  /** Короткий алиас на редактор. */
  get pe() { return this.photoEditor; }

  /** Логическая ширина overlay-canvas (CSS px) — используйте вместо overlayCanvas.width. */
  get viewW() { return this._viewW; }
  /** Логическая высота overlay-canvas (CSS px). */
  get viewH() { return this._viewH; }

  /** Масштаб: логические px overlay → натуральные px изображения. */
  get naturalScale() {
    const img = this.pe.img;
    if (!img || !this._viewW) return 1;
    return img.naturalWidth / this._viewW;
  }


  // ── Жизненный цикл ─────────────────────────────────────────────────────────

  start() {
    if (this.isSuspended) { this._resume(); return; }
    if (this.isActive || this._startPending) return;

    const imgEl = this.pe.imgElement;
    if (!imgEl?.naturalWidth) {
      // Изображение ещё декодируется — стартуем по готовности (один раз)
      this._startPending = true;
      waitForImage(imgEl).then(
        () => { this._startPending = false; if (!this.isActive && this.pe.imgElement?.naturalWidth) this.start(); },
        () => { this._startPending = false; },
      );
      return;
    }

    this.isActive = true;
    this.pe.activeTool = this;
    this._activate(() => this.onStart());
  }

  _resume() {
    if (!this.isSuspended) return;
    if (!this.pe.imgElement?.naturalWidth) return;
    this.isActive    = true;
    this.isSuspended = false;
    this.pe.activeTool = this;
    this._activate(() => this.onResume());
  }

  /** Общая часть start/resume: canvas, наблюдение за размером, хук, панель, указатель. */
  _activate(hook) {
    if (this._opts.useCanvas) {
      this._ensureCanvas();
      this._syncCanvasSize();
      this._showCanvas();
    }
    this._observeResize();
    hook();
    this._ensurePanel();
    if (this._opts.useCanvas && this._opts.canvasPointer) this._bindPointer();
    this.requestDraw();
    this.pe.syncToolButtons?.();
  }

  suspend() {
    if (!this.isActive || this.isSuspended) return;
    this._unbindPointer();
    this._unobserveResize();
    this._cancelFrames();
    this.onSuspend();
    if (this.overlayCanvas) {
      this._clearCanvas();
      this.overlayCanvas.style.pointerEvents = 'none';
    }
    this._suspending = true;
    this.pe.dialogs?.close(this.id);
    this._suspending = false;

    this.isActive    = false;
    this.isSuspended = true;
    if (this.pe.activeTool === this) this.pe.activeTool = null;
    this.pe.syncToolButtons?.();
  }

  cancel() {
    if (this._stopping) return;
    this.onCancel();
    this._teardown();
  }

  apply() {
    if (this._stopping) return;
    let out = null;
    try {
      out = this.onApply();
    } catch (err) {
      console.error(`[${this.constructor.name}] apply():`, err);
    }
    if (out && typeof out.then === 'function') {
      out.then(cv => cv && this.pe.commitCanvas(cv))
         .catch(err => console.error(`[${this.constructor.name}] apply():`, err));
    } else if (out) {
      this.pe.commitCanvas(out)
          .catch(err => console.error(`[${this.constructor.name}] apply():`, err));
    }
    this._teardown();
  }

  destroy() {
    this.onDestroy();
    this._teardown();
  }

  /** Повторный клик по кнопке инструмента в тулбаре — переключить панель. */
  openSettings() { this.pe.dialogs?.toggle(this.id); }

  /**
   * Вызывается PhotoEditor для активного инструмента.
   * @returns {boolean} true — событие перехвачено
   */
  onKeyDown(e) {
    if (!this.isActive) return false;
    if (e.key === 'Escape') { this.cancel(); return true; }
    return this.onKey(e) === true;
  }

  _teardown() {
    if (this._stopping) return;
    this._stopping = true;

    this._unbindPointer();
    this._unobserveResize();
    this._cancelFrames();
    this._removeCanvas();

    const panel = this._panel;
    this._panel = null;
    if (panel) {
      this.pe.dialogs?.unregister(this.id);
      panel.remove();
    }

    this.isActive    = false;
    this.isSuspended = false;
    this._stopping   = false;
    if (this.pe.activeTool === this) this.pe.activeTool = null;
    this.pe.syncToolButtons?.();
  }


  // ── Хуки (переопределяются наследником) ────────────────────────────────────

  onStart()   {}
  onResume()  { this.onStart(); }
  onSuspend() {}
  onCancel()  {}
  onApply()   { return null; }
  onDestroy() {}
  onViewResize(_kx, _ky) {}
  onDraw(_ctx) {}
  onPointerDown(_pt, _e) {}
  onPointerMove(_pt, _e) {}
  onPointerUp(_pt, _e)   {}
  onPointerCancel(e)     { this.onPointerUp(null, e); }
  onHover(_pt, _e)       {}
  onHoverEnd(_e)         {}
  onKey(_e)              { return false; }
  buildPanel()           { return null; }
  onPanelReady(_panel)   {}


  // ── Canvas ─────────────────────────────────────────────────────────────────

  _ensureCanvas() {
    if (this.overlayCanvas) return;
    const imgEl  = this.pe.imgElement;
    const parent = imgEl?.parentElement
      || this.pe.container?.querySelector('.photoeditor__img-container');
    const cv = document.createElement('canvas');
    cv.className = `pe-tool-canvas pe-tool-canvas--${this.id}`;
    cv.style.cursor = this._opts.cursor;
    if (!this._opts.canvasPointer) cv.style.pointerEvents = 'none';
    this.overlayCanvas = cv;
    this.overlayCtx    = cv.getContext('2d');
    this._viewW = 0; this._viewH = 0; this._dpr = 0;
    parent?.appendChild(cv);
  }

  _removeCanvas() {
    if (!this.overlayCanvas) return;
    this.overlayCanvas.remove();
    this.overlayCanvas = null;
    this.overlayCtx    = null;
    this._viewW = 0; this._viewH = 0;
  }

  _showCanvas() {
    if (!this.overlayCanvas) return;
    this.overlayCanvas.style.pointerEvents = this._opts.canvasPointer ? '' : 'none';
  }

  _clearCanvas() {
    const ctx = this.overlayCtx;
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
  }

  /**
   * Подгоняет backing store под размер <img> и DPR.
   * При изменении логического размера вызывает onViewResize(kx, ky).
   * @returns {boolean} true — размер изменился
   */
  _syncCanvasSize() {
    const imgEl = this.pe.imgElement;
    const cv    = this.overlayCanvas;
    if (!imgEl || !cv) return false;
    const w   = imgEl.offsetWidth  || imgEl.width  || this.pe.img?.naturalWidth  || 0;
    const h   = imgEl.offsetHeight || imgEl.height || this.pe.img?.naturalHeight || 0;
    if (!w || !h) return false;
    const dpr = this._opts.hidpi ? (window.devicePixelRatio || 1) : 1;
    if (w === this._viewW && h === this._viewH && dpr === this._dpr) return false;

    const kx = this._viewW ? w / this._viewW : 1;
    const ky = this._viewH ? h / this._viewH : 1;
    const resized = this._viewW > 0 && (Math.abs(kx - 1) > 1e-6 || Math.abs(ky - 1) > 1e-6);

    this._viewW = w; this._viewH = h; this._dpr = dpr;
    cv.width  = Math.max(1, Math.round(w * dpr));
    cv.height = Math.max(1, Math.round(h * dpr));

    if (resized) this.onViewResize(kx, ky);
    return true;
  }

  /** Планирует перерисовку overlay на ближайший кадр (повторные вызовы схлопываются). */
  requestDraw() {
    this._drawDirty = true;
    if (this._drawRaf != null) return;
    this._drawRaf = requestAnimationFrame(() => {
      this._drawRaf = null;
      if (this._drawDirty) this._flushDraw();
    });
  }

  /** Перерисовать немедленно (например, перед чтением пикселей). */
  _flushDraw() {
    this._drawDirty = false;
    if (!this.isActive) return;
    if (this.overlayCtx) {
      this._syncCanvasSize();
      const ctx = this.overlayCtx;
      ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
      ctx.clearRect(0, 0, this._viewW, this._viewH);
      this.onDraw(ctx);
    } else {
      this.onDraw(null);
    }
  }

  _cancelFrames() {
    if (this._drawRaf != null) { cancelAnimationFrame(this._drawRaf); this._drawRaf = null; }
    if (this._moveRaf != null) { cancelAnimationFrame(this._moveRaf); this._moveRaf = null; }
    this._pendingMove = null;
    this._drawDirty   = false;
  }


  // ── Размер области ─────────────────────────────────────────────────────────

  _observeResize() {
    const imgEl = this.pe.imgElement;
    if (typeof ResizeObserver !== 'undefined' && imgEl && !this._resizeObserver) {
      this._resizeObserver = new ResizeObserver(() => this.requestDraw());
      this._resizeObserver.observe(imgEl);
    }
    window.addEventListener('resize', this._onWindowResizeBound);
  }

  _unobserveResize() {
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    window.removeEventListener('resize', this._onWindowResizeBound);
  }


  // ── Указатель ──────────────────────────────────────────────────────────────

  _bindPointer() {
    const cv = this.overlayCanvas;
    if (!cv) return;
    cv.addEventListener('pointerdown',   this._onPointerDownBound);
    cv.addEventListener('pointermove',   this._onPointerMoveBound);
    cv.addEventListener('pointerup',     this._onPointerUpBound);
    cv.addEventListener('pointercancel', this._onPointerCancelBound);
    cv.addEventListener('pointerleave',  this._onPointerLeaveBound);
  }

  _unbindPointer() {
    const cv = this.overlayCanvas;
    if (cv) {
      cv.removeEventListener('pointerdown',   this._onPointerDownBound);
      cv.removeEventListener('pointermove',   this._onPointerMoveBound);
      cv.removeEventListener('pointerup',     this._onPointerUpBound);
      cv.removeEventListener('pointercancel', this._onPointerCancelBound);
      cv.removeEventListener('pointerleave',  this._onPointerLeaveBound);
      if (this._pointerId != null) {
        try { cv.releasePointerCapture(this._pointerId); } catch { /* уже отпущен */ }
      }
    }
    this._pointerId = null;
  }

  /** Координаты события → логические координаты canvas. */
  _pt(e) {
    return clientToLogical(this.overlayCanvas, e.clientX, e.clientY, this._viewW, this._viewH);
  }

  _onPointerDown(e) {
    if (!this.isActive || !e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (this._pointerId != null) return;            // второй палец — игнорируем
    this._pointerId = e.pointerId;
    try { this.overlayCanvas.setPointerCapture(e.pointerId); } catch { /* не критично */ }
    e.preventDefault();
    this.onPointerDown(this._pt(e), e);
    if (this._drawDirty) this._flushDrawNow();
  }

  _onPointerMove(e) {
    if (!this.isActive) return;
    if (this._pointerId != null && e.pointerId !== this._pointerId) return;
    this._pendingMove = e;
    if (this._moveRaf != null) return;
    this._moveRaf = requestAnimationFrame(() => {
      this._moveRaf = null;
      this._dispatchPendingMove();
    });
  }

  _dispatchPendingMove() {
    const e = this._pendingMove;
    this._pendingMove = null;
    if (!e || !this.isActive || !this.overlayCanvas) return;
    const pt = this._pt(e);
    if (this._pointerId != null) this.onPointerMove(pt, e);
    else                         this.onHover(pt, e);
    if (this._drawDirty) this._flushDrawNow();
  }

  _onPointerUp(e) {
    if (e.pointerId !== this._pointerId) return;
    this._dispatchPendingMove();                     // не терять последнее движение
    this._pointerId = null;
    try { this.overlayCanvas?.releasePointerCapture(e.pointerId); } catch { /* ok */ }
    this.onPointerUp(this._pt(e), e);
    if (this._drawDirty) this._flushDrawNow();
  }

  _onPointerCancel(e) {
    if (e.pointerId !== this._pointerId) return;
    this._pendingMove = null;
    this._pointerId   = null;
    this.onPointerCancel(e);
    this.requestDraw();
  }

  _onPointerLeave(e) {
    if (this._pointerId != null) return;             // во время жеста capture держит события
    this.onHoverEnd(e);
    if (this._drawDirty) this._flushDrawNow();
  }

  /** Рисует в текущем кадре, отменяя запланированный rAF (без лишнего кадра задержки). */
  _flushDrawNow() {
    if (this._drawRaf != null) { cancelAnimationFrame(this._drawRaf); this._drawRaf = null; }
    this._flushDraw();
  }


  // ── Панель ─────────────────────────────────────────────────────────────────

  _ensurePanel() {
    if (this._panel) { this.pe.dialogs?.open(this.id); return; }
    const panel = this.buildPanel();
    if (!panel) return;
    panel.classList.add('pe-panel', `pe-panel--${this.id}`);
    this._panel = panel;
    this._bindPanelActions(panel);
    this.pe.container?.appendChild(panel);
    this.pe.dialogs?.register(this.id, panel, {
      group:   'tool',
      onClose: () => {
        // Закрыта извне (крестик, Импорт/Экспорт, Escape) → suspend с сохранением состояния.
        // Programmatic close из suspend()/teardown игнорируем.
        if (this.isActive && !this._stopping && !this._suspending) this.suspend();
      },
    });
    this.pe.dialogs?.open(this.id);
    this.onPanelReady(panel);
  }

  _bindPanelActions(panel) {
    panel.querySelector('.pe-panel__btn-cancel')?.addEventListener('click', () => this.cancel());
    panel.querySelector('.pe-panel__btn-apply') ?.addEventListener('click', () => this.apply());
  }

  /**
   * Стандартная шапка панели: заголовок, произвольный блок слева, «Отмена/Применить».
   * Кнопки получают классы pe-panel__btn-cancel/apply и, если задан prefix,
   * ещё `${prefix}__btn-cancel/apply` (совместимость с существующими стилями).
   *
   * @param {{ title: string, prefix?: string, left?: string, actions?: boolean,
   *           applyTitle?: string, cancelTitle?: string }} o
   * @returns {string} HTML
   */
  static panelHeader({ title, prefix = '', left = '', actions = true, applyTitle = 'Применить', cancelTitle = 'Отмена' }) {
    const p = (name) => `pe-panel__btn-${name}${prefix ? ` ${prefix}__btn-${name}` : ''}`;
    const buttons = actions ? `
        <div class="pe-panel__header-actions">
          <button type="button" class="photoeditor__button photoeditor__button--compact ${p('cancel')}"
                  title="${cancelTitle} (Escape)">
            <i class="icon-close" aria-hidden="true"></i> Отмена
          </button>
          <button type="button" class="photoeditor__button photoeditor__button--compact photoeditor__button--success ${p('apply')}"
                  title="${applyTitle}">
            <i class="icon-checkmark" aria-hidden="true"></i> Применить
          </button>
        </div>` : '';
    return `
      <div class="pe-panel__header">
        ${left ? `<div class="pe-panel__header-left"><span class="pe-panel__title">${title}</span>${left}</div>`
               : `<span class="pe-panel__title">${title}</span>`}
        ${buttons}
      </div>`;
  }
}
