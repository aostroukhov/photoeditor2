import { EditorConfig } from './EditorConfig.js';

/**
 * CropTool v3.6
 *
 * Изменения v3.6:
 *  • Все внутренние поля и методы переведены на ES2022 Private Fields (#).
 *    Синтаксическая защита движка: обращение к #-полям снаружи класса —
 *    SyntaxError при парсинге.
 *  • Bound-обработчики событий объявлены как приватные поля (#xBound),
 *    что гарантирует корректное removeEventListener без утечек.
 *  • Убраны вызовы _handleToolStop (метод удалён из PhotoEditor v3.6).
 *  • Убран вызов _updateInfo: commitImage() обновляет инфо автоматически.
 *  • apply() больше не экспортирует результат в this.photoEditor.export
 *    автоматически — сохранение в источник происходит только при явном
 *    закрытии редактора через requestClose().
 *
 * ── Жизненный цикл ────────────────────────────────────────────────────────────
 *   start()   — активация: показываем canvas + панель, восстанавливаем состояние.
 *   suspend() — приостановка (переключение на другой инструмент):
 *               скрываем canvas и панель, сохраняем cropArea.
 *   cancel()  — отмена: уничтожаем canvas и панель без записи в img.
 *   apply()   — псевдоним crop().
 *   crop()    — применение: пишем результат в img через commitImage(), уничтожаем.
 *   destroy() — полный сброс (PhotoEditor.close).
 *
 * ── Публичные поля ────────────────────────────────────────────────────────────
 *   isActive, isSuspended
 *   cropColor, resizeHandleSize, aspectRatio, fixedAspect, showGoldenRatio
 *   overlayCanvas, overlayCtx    (нужны OverlayTool для перерисовки)
 *   cropArea, naturalCropArea, cropRotation
 *
 * ── Приватные поля (#) ────────────────────────────────────────────────────────
 *   #panel, #externalAspect, #rotating, #rotateStartAngle
 *   #stopping, #suspending, #dragStart, #resizeAnchor
 *   Bound-обработчики: #expandCropAreaBound, #onMouseDownBound, #onMouseUpBound,
 *     #onMouseMoveBound, #onTouchMoveBound, #onContainerResizeBound,
 *     #onTouchStartBound, #onTouchEndBound, #drawCropAreaBound
 */
export class CropTool {

  // ── Приватные поля ──────────────────────────────────────────────────────────

  /** Элемент панели управления кропом. null когда инструмент неактивен. */
  #panel = null;

  /**
   * true — соотношение сторон задано извне (через opts.cropOptions.aspectRatio).
   * При этом кнопки выбора пропорций в панели не показываются.
   */
  #externalAspect = false;

  /** true — пользователь вращает рамку (зажат дескриптор вращения). */
  #rotating = false;

  /** Угол курсора в момент начала вращения (для вычисления дельты). */
  #rotateStartAngle = 0;

  /**
   * true — идёт destroy/cancel; предотвращает повторный вход
   * (например, если onClose панели вызывает cancel()).
   */
  #stopping = false;

  /**
   * true — идёт programmatic suspend(); предотвращает вызов cancel()
   * из onClose панели при закрытии диалога изнутри suspend().
   */
  #suspending = false;

  /** Состояние drag (перетаскивание рамки): { x, y, cx, cy } в момент mousedown. */
  #dragStart = null;

  /** Мировые координаты якорного угла при resize (противоположный курсору угол). */
  #resizeAnchor = null;

  // ── Bound-обработчики событий ─────────────────────────────────────────────
  //
  // Объявляем как приватные поля, а не через .bind() в конструкторе.
  // Преимущества:
  //   1. Один и тот же объект функции — removeEventListener работает корректно.
  //   2. Нет публичных свойств-призраков на экземпляре (this.onMouseDown = ...).
  //   3. Приватность: внешний код не может подменить обработчик.

  #expandCropAreaBound    = ()  => this.#expandCropArea();
  #onMouseDownBound       = (e) => this.#onMouseDown(e);
  #onMouseUpBound         = ()  => this.#onMouseUp();
  #onMouseMoveBound       = (e) => this.#onMouseMove(e);
  #onTouchMoveBound       = (e) => this.#onTouchMove(e);
  #onContainerResizeBound = ()  => this.#onContainerResize();
  #onTouchStartBound      = (e) => this.#onTouchStart(e);
  #onTouchEndBound        = ()  => this.#onTouchEnd();
  #drawCropAreaBound      = ()  => this.drawCropArea();


  // ── Публичные поля ──────────────────────────────────────────────────────────

  /** Цвет рамки кадрирования. */
  cropColor        = EditorConfig.crop.cropColor;
  /** Размер ручек масштабирования в пикселях. */
  resizeHandleSize = EditorConfig.crop.resizeHandleSize;
  /** Текущее соотношение сторон (null = свободное). */
  aspectRatio      = null;
  /** true — соотношение сторон зафиксировано. */
  fixedAspect      = false;
  /** true — показывать сетку золотого сечения внутри рамки. */
  showGoldenRatio  = EditorConfig.crop.showGoldenRatio;

  /** Идентификатор активного touch-пальца. */
  touchId          = null;
  /** Текущая область кадрирования в display-пикселях. */
  cropArea         = null;
  /** Область кадрирования в натуральных пикселях (сохраняется между suspend/resume). */
  naturalCropArea  = null;
  /** Canvas-оверлей поверх imgElement. Публичный: OverlayTool обращается к нему для перерисовки. */
  overlayCanvas    = null;
  /** 2D-контекст overlayCanvas. Публичный: инструменты могут читать его размер. */
  overlayCtx       = null;

  /** Угол поворота рамки кадрирования в радианах. */
  cropRotation     = 0;

  /** true — инструмент активен (canvas виден, события привязаны). */
  isActive         = false;
  /** true — приостановлен (состояние сохранено, canvas скрыт). */
  isSuspended      = false;

  /** true — идёт drag рамки. */
  dragging         = false;
  /** true — идёт resize рамки. */
  resizing         = false;
  /** Активная ручка resize ('topLeft' | 'topRight' | ... | null). */
  activeHandle     = null;


  // ── Конструктор ─────────────────────────────────────────────────────────────

  constructor(photoEditor) {
    this.photoEditor = photoEditor;
  }


  // ── Публичные методы: настройка ─────────────────────────────────────────────

  /**
   * Задаёт фиксированное соотношение сторон (например '16:9').
   * Помечает соотношение как внешнее — кнопки выбора пропорций скрываются.
   *
   * @param {string} ratio  Строка вида 'W:H', например '4:3', '16:9'.
   */
  setAspectRatio(ratio) {
    const [w, h]    = ratio.split(':').map(Number);
    this.aspectRatio  = w / h;
    this.fixedAspect  = true;
    this.#externalAspect = true;
  }

  /**
   * Сбрасывает фиксированное соотношение сторон на свободное.
   */
  resetAspectRatio() {
    this.aspectRatio  = null;
    this.fixedAspect  = false;
    this.#externalAspect = false;
  }


  // ── Публичные методы: жизненный цикл ────────────────────────────────────────

  /**
   * Активировать инструмент.
   * Если был suspended — возобновляет (resume).
   * Если новый — инициализирует cropArea по умолчанию.
   */
  start() {
    if (this.isSuspended) { this.#resume(); return; }

    this.isActive = true;
    this.photoEditor.activeTool = this;

    const imgEl = this.photoEditor.imgElement;

    // Восстанавливаем сохранённую область или ставим дефолт (2/3 изображения)
    if (this.naturalCropArea) {
      const k = imgEl.width / this.photoEditor.img.naturalWidth;
      this.cropArea = {
        x:      this.naturalCropArea.x      * k,
        y:      this.naturalCropArea.y      * k,
        width:  this.naturalCropArea.width  * k,
        height: this.naturalCropArea.height * k,
      };
    } else {
      this.cropArea = {
        x:      imgEl.width  / 6,
        y:      imgEl.height / 6,
        width:  imgEl.width  / 6 * 4,
        height: imgEl.height / 6 * 4,
      };
    }

    this.dragging = false; this.resizing = false; this.activeHandle = null;

    // Создаём canvas-оверлей поверх imgElement
    this.overlayCanvas        = document.createElement('canvas');
    this.overlayCanvas.width  = imgEl.width;
    this.overlayCanvas.height = imgEl.height;
    this.overlayCtx           = this.overlayCanvas.getContext('2d');
    imgEl.parentElement.appendChild(this.overlayCanvas);

    this.#createPanel();
    this.#unbindEvents();
    this.#bindEvents();
    this.adjustCropToAspectRatio();
    this.#onContainerResize();
  }

  /**
   * Приостановить — скрыть UI, сохранить состояние.
   * Вызывается при переключении на другой инструмент.
   */
  suspend() {
    if (!this.isActive || this.isSuspended) return;

    this.#saveCropArea();
    this.#unbindEvents();

    if (this.overlayCanvas) {
      this.overlayCtx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
      this.overlayCanvas.style.pointerEvents = 'none';
    }

    // Флаг предотвращает вызов cancel() из onClose панели во время suspend()
    this.#suspending = true;
    this.photoEditor.dialogs?.close('crop');
    this.#suspending = false;

    this.isActive    = false;
    this.isSuspended = true;
    this.photoEditor.activeTool = null;
    this.photoEditor.syncToolButtons?.();
  }

  /** Отмена — полностью уничтожить без записи в img. */
  cancel() {
    this.cropRotation = 0;
    this.#destroy();
  }

  /** Применить кроп — псевдоним crop() для единообразия API инструментов. */
  apply() { this.crop(); }

  /** Повторный клик по кнопке инструмента в тулбаре — переключить панель. */
  openSettings() {
    this.photoEditor.dialogs?.toggle('crop');
  }

  /**
   * Полный сброс при PhotoEditor.close().
   * Silent-режим: не пытается закрыть панель (DOM уже разрушается).
   */
  destroy() {
    this.#destroy(/* silent */ true);
  }

  /**
   * Обработчик клавиатуры — вызывается из PhotoEditor#onKeyDown.
   * Возвращает true если событие обработано (PhotoEditor вызовет preventDefault).
   *
   * @param {KeyboardEvent} e
   * @returns {boolean}
   */
  onKeyDown(e) {
    if (e.key === 'Escape') { this.cancel(); return true; }
    if (e.key === 'Enter')  { this.crop();   return true; }
    if (!this.cropArea) return false;
    const k    = this.photoEditor.img.naturalWidth / this.photoEditor.imgElement.width;
    const step = (e.shiftKey ? 10 : 1) / k;
    switch (e.key) {
      case 'ArrowUp':    this.cropArea.y -= step; this.drawCropArea(); return true;
      case 'ArrowDown':  this.cropArea.y += step; this.drawCropArea(); return true;
      case 'ArrowLeft':  this.cropArea.x -= step; this.drawCropArea(); return true;
      case 'ArrowRight': this.cropArea.x += step; this.drawCropArea(); return true;
    }
    return false;
  }


  // ── Приватные методы: жизненный цикл ────────────────────────────────────────

  /** Возобновить из suspended-состояния. */
  #resume() {
    if (!this.isSuspended) return;

    this.isActive    = true;
    this.isSuspended = false;
    this.photoEditor.activeTool = this;

    const imgEl = this.photoEditor.imgElement;

    // Пересоздаём canvas если он был потерян во время suspended
    if (!this.overlayCanvas) {
      this.overlayCanvas        = document.createElement('canvas');
      this.overlayCanvas.width  = imgEl.width;
      this.overlayCanvas.height = imgEl.height;
      this.overlayCtx           = this.overlayCanvas.getContext('2d');
      imgEl.parentElement.appendChild(this.overlayCanvas);
    } else {
      this.overlayCanvas.style.pointerEvents = '';
    }

    // Пересчитываем cropArea под текущий размер imgElement
    if (this.naturalCropArea) {
      const k = imgEl.width / this.photoEditor.img.naturalWidth;
      this.cropArea = {
        x:      this.naturalCropArea.x      * k,
        y:      this.naturalCropArea.y      * k,
        width:  this.naturalCropArea.width  * k,
        height: this.naturalCropArea.height * k,
      };
    }

    this.dragging = false; this.resizing = false; this.activeHandle = null;
    this.#unbindEvents();
    this.#bindEvents();

    this.photoEditor.dialogs?.open('crop');
    this.#onContainerResize();
    this.photoEditor.syncToolButtons?.();
  }

  /**
   * Сохраняет текущую cropArea в натуральных пикселях (naturalCropArea).
   * Вызывается перед suspend(), onMouseUp(), crop() — чтобы не потерять
   * область при изменении размера окна между сессиями.
   */
  #saveCropArea() {
    if (!this.cropArea || !this.photoEditor.imgElement) return;
    const k = this.photoEditor.img.naturalWidth / this.photoEditor.imgElement.width;
    this.naturalCropArea = {
      x:      this.cropArea.x      * k,
      y:      this.cropArea.y      * k,
      width:  this.cropArea.width  * k,
      height: this.cropArea.height * k,
    };
  }

  /**
   * Уничтожить canvas и панель.
   * @param {boolean} [silent=false]  true — не вызывать dialogs.unregister
   *   (используется в destroy() когда PhotoEditor уже закрывается).
   */
  #destroy(silent = false) {
    if (this.#stopping) return;
    this.#stopping = true;

    this.#unbindEvents();

    if (this.overlayCanvas) {
      this.overlayCanvas.remove();
      this.overlayCanvas = null;
      this.overlayCtx    = null;
    }

    const panel = this.#panel;
    this.#panel = null;
    if (panel) {
      this.photoEditor.dialogs?.unregister('crop');
      panel.remove();
    }

    this.isActive    = false;
    this.isSuspended = false;
    this.#stopping   = false;
    this.photoEditor.activeTool = null;
    this.photoEditor.syncToolButtons?.();
  }


  // ── Приватные методы: панель управления ─────────────────────────────────────

  /** Список предустановленных соотношений из конфига. */
  static get #RATIOS() { return EditorConfig.crop.ratios; }

  /** Создаёт и монтирует панель управления кропом. Идемпотентен. */
  #createPanel() {
    if (this.#panel) return;

    const panel = document.createElement('div');
    panel.className = 'pe-panel pe-panel--crop';

    const ratioButtons = !this.#externalAspect
      ? CropTool.#RATIOS.map((r, i) => `
          <button type="button"
                  class="pe-panel__crop-ratio-btn${i === 0 && !this.fixedAspect ? ' is-active' : ''}"
                  data-ratio="${r.value ?? ''}"
                  title="${r.label}">${r.label}</button>`
        ).join('')
      : '';

    panel.innerHTML = `
      <div class="pe-panel__crop-toolbar">
        <button type="button"
                class="pe-panel__crop-tb-btn"
                data-action="rotate-ccw"
                title="Повернуть 90° влево">
          <i class="icon-image-rotate-round-ccw" aria-hidden="true"></i>
        </button>
        <button type="button"
                class="pe-panel__crop-tb-btn"
                data-action="rotate-cw"
                title="Повернуть 90° вправо">
          <i class="icon-image-rotate-round-cw" aria-hidden="true"></i>
        </button>
        ${!this.#externalAspect
          ? `<div class="pe-panel__crop-sep"></div>${ratioButtons}`
          : ''}
        <div class="pe-panel__crop-spacer"></div>
        <button type="button"
                class="pe-panel__crop-tb-btn pe-panel__crop-tb-btn--apply"
                data-action="apply"
                title="Применить (Enter)">
          <i class="icon-checkmark" aria-hidden="true"></i>
          <span class="pe-panel__crop-tb-label">Применить</span>
        </button>
      </div>`;

    panel.querySelector('[data-action="rotate-ccw"]').addEventListener('click', () => this.#rotateImage(-90));
    panel.querySelector('[data-action="rotate-cw"]').addEventListener('click',  () => this.#rotateImage(90));
    panel.querySelector('[data-action="apply"]').addEventListener('click',      () => this.crop());

    if (!this.#externalAspect) {
      panel.querySelectorAll('.pe-panel__crop-ratio-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const raw = btn.dataset.ratio;
          const val = raw === '' ? null : parseFloat(raw);
          this.aspectRatio = val;
          this.fixedAspect = val !== null;
          panel.querySelectorAll('.pe-panel__crop-ratio-btn')
            .forEach(b => b.classList.remove('is-active'));
          btn.classList.add('is-active');
          this.#saveCropArea();
          this.adjustCropToAspectRatio();
          this.drawCropArea();
        });
      });
    }

    this.photoEditor.container.appendChild(panel);
    this.#panel = panel;

    this.photoEditor.dialogs?.register('crop', panel, {
      group:   'tool',
      onClose: () => {
        // Вызываем cancel() только при явном закрытии пользователем,
        // не во время programmatic suspend() или destroy()
        if ((this.isActive || this.isSuspended) && !this.#stopping && !this.#suspending) {
          this.cancel();
        }
      },
    });

    this.photoEditor.dialogs?.open('crop');
  }


  // ── Приватные методы: поворот изображения ───────────────────────────────────

  /**
   * Поворачивает всё изображение на ±90°.
   * После поворота сбрасывает naturalCropArea и пересоздаёт canvas-оверлей
   * под новые размеры imgElement.
   *
   * @param {number} deg  Угол в градусах (+90 = по часовой, -90 = против).
   */
  #rotateImage(deg) {
    const src = this.photoEditor.img;
    const sw = src.naturalWidth, sh = src.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width  = sh; canvas.height = sw;
    const ctx = canvas.getContext('2d');
    ctx.translate(sh / 2, sw / 2);
    ctx.rotate(deg * Math.PI / 180);
    ctx.drawImage(src, -sw / 2, -sh / 2);

    const dataUrl = canvas.toDataURL('image/png');
    const newImg  = new Image();
    newImg.onload = () => {
      this.photoEditor.commitImage(newImg); // обновляет img, imgElement, info, history
      this.naturalCropArea = null;          // область устарела после поворота

      this.photoEditor.imgElement.addEventListener('load', () => {
        // Пересоздаём canvas под новые размеры
        if (this.overlayCanvas) {
          this.overlayCanvas.remove();
          this.overlayCanvas = null;
          this.overlayCtx    = null;
        }
        const imgEl = this.photoEditor.imgElement;
        this.overlayCanvas        = document.createElement('canvas');
        this.overlayCanvas.width  = imgEl.width;
        this.overlayCanvas.height = imgEl.height;
        this.overlayCtx           = this.overlayCanvas.getContext('2d');
        imgEl.parentElement.appendChild(this.overlayCanvas);

        this.#unbindEvents();
        this.#bindEvents();
        this.cropArea = {
          x: imgEl.width / 6, y: imgEl.height / 6,
          width: imgEl.width / 6 * 4, height: imgEl.height / 6 * 4,
        };
        this.adjustCropToAspectRatio();
        this.#onContainerResize();
      }, { once: true });
    };
    newImg.src = dataUrl;
  }


  // ── Приватные методы: события ────────────────────────────────────────────────

  #bindEvents() {
    this.overlayCanvas.addEventListener('dblclick',   this.#expandCropAreaBound);
    this.overlayCanvas.addEventListener('mousedown',  this.#onMouseDownBound);
    document.addEventListener('mouseup',   this.#onMouseUpBound);
    document.addEventListener('mousemove', this.#onMouseMoveBound);
    this.overlayCanvas.addEventListener('touchstart', this.#onTouchStartBound, { passive: false });
    document.addEventListener('touchend',  this.#onTouchEndBound);
    document.addEventListener('touchmove', this.#onTouchMoveBound, { passive: false });
    this.photoEditor.imgElement.addEventListener('load', this.#onContainerResizeBound);
    window.addEventListener('orientationchange', this.#onContainerResizeBound);
    window.addEventListener('resize', this.#onContainerResizeBound);
  }

  #unbindEvents() {
    if (this.overlayCanvas) {
      this.overlayCanvas.removeEventListener('dblclick',   this.#expandCropAreaBound);
      this.overlayCanvas.removeEventListener('mousedown',  this.#onMouseDownBound);
      this.overlayCanvas.removeEventListener('touchstart', this.#onTouchStartBound);
    }
    document.removeEventListener('mouseup',   this.#onMouseUpBound);
    document.removeEventListener('mousemove', this.#onMouseMoveBound);
    document.removeEventListener('touchend',  this.#onTouchEndBound);
    document.removeEventListener('touchmove', this.#onTouchMoveBound);
    this.photoEditor.imgElement?.removeEventListener('load', this.#onContainerResizeBound);
    window.removeEventListener('orientationchange', this.#onContainerResizeBound);
    window.removeEventListener('resize', this.#onContainerResizeBound);
  }

  #onContainerResize() {
    if (!this.overlayCanvas) return;
    // Двойной rAF: ждём завершения layout перед перерисовкой
    requestAnimationFrame(() => requestAnimationFrame(this.#drawCropAreaBound));
  }


  // ── Приватные методы: геометрия с учётом поворота ───────────────────────────

  /**
   * Переводит экранные координаты в локальные (центр рамки = 0,0, угол = 0).
   * Используется для корректного hit-test и resize при повёрнутой рамке.
   */
  #toLocal(x, y) {
    const { x: cx, y: cy, width, height } = this.cropArea;
    const ox  = cx + width / 2, oy = cy + height / 2;
    const cos = Math.cos(-this.cropRotation), sin = Math.sin(-this.cropRotation);
    const dx  = x - ox, dy = y - oy;
    return { lx: dx * cos - dy * sin, ly: dx * sin + dy * cos };
  }

  /**
   * Переводит локальные координаты рамки обратно в экранные.
   */
  #toWorld(lx, ly) {
    const { x: cx, y: cy, width, height } = this.cropArea;
    const ox  = cx + width / 2, oy = cy + height / 2;
    const cos = Math.cos(this.cropRotation), sin = Math.sin(this.cropRotation);
    return { x: ox + lx * cos - ly * sin, y: oy + lx * sin + ly * cos };
  }

  /**
   * Hit-test с учётом поворота рамки.
   * Возвращает имя ручки, 'rotate', 'inside' или null.
   */
  #hitTestRotated(x, y) {
    const { width, height } = this.cropArea;
    const { lx, ly } = this.#toLocal(x, y);
    const hw = width / 2, hh = height / 2;
    const s  = this.resizeHandleSize + 5;

    // Ручка вращения — кружок над центром верхней грани
    const rotHandleY = -hh - EditorConfig.crop.rotateHandleOffset;
    if (Math.hypot(lx, ly - rotHandleY) <= s) return 'rotate';

    // Угловые ручки
    const corners = [
      { name: 'topLeft',     lx: -hw, ly: -hh },
      { name: 'topRight',    lx: +hw, ly: -hh },
      { name: 'bottomLeft',  lx: -hw, ly: +hh },
      { name: 'bottomRight', lx: +hw, ly: +hh },
    ];
    for (const c of corners) {
      if (Math.hypot(lx - c.lx, ly - c.ly) <= s) return c.name;
    }

    // Боковые ручки
    const sides = [
      { name: 'top',    cond: Math.abs(ly - (-hh)) <= s && Math.abs(lx) < hw },
      { name: 'bottom', cond: Math.abs(ly - (+hh)) <= s && Math.abs(lx) < hw },
      { name: 'left',   cond: Math.abs(lx - (-hw)) <= s && Math.abs(ly) < hh },
      { name: 'right',  cond: Math.abs(lx - (+hw)) <= s && Math.abs(ly) < hh },
    ];
    for (const side of sides) {
      if (side.cond) return side.name;
    }

    // Внутри рамки
    if (Math.abs(lx) <= hw && Math.abs(ly) <= hh) return 'inside';

    return null;
  }


  // ── Приватные методы: обработчики мыши и тачей ──────────────────────────────

  #onMouseDown(e) {
    if (!this.overlayCanvas) return;
    const rect = this.overlayCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;

    const hit = this.#hitTestRotated(x, y);
    if (!hit) return;

    if (hit === 'rotate') {
      this.#rotating = true;
      const { x: cx, y: cy, width, height } = this.cropArea;
      const ox = cx + width / 2, oy = cy + height / 2;
      this.#rotateStartAngle = Math.atan2(y - oy, x - ox) - this.cropRotation;
      this.overlayCanvas.style.cursor = 'crosshair';
      return;
    }

    if (hit === 'inside') {
      this.dragging     = true;
      this.#dragStart   = { x, y, cx: this.cropArea.x, cy: this.cropArea.y };
    } else {
      this.resizing     = true;
      this.activeHandle = hit;
      // Фиксируем якорный угол (противоположный активной ручке) в мировых координатах
      const { width, height } = this.cropArea;
      const anchors = {
        topLeft:     { lx: +width/2, ly: +height/2 },
        topRight:    { lx: -width/2, ly: +height/2 },
        bottomLeft:  { lx: +width/2, ly: -height/2 },
        bottomRight: { lx: -width/2, ly: -height/2 },
        top:         { lx: 0, ly: +height/2 },
        bottom:      { lx: 0, ly: -height/2 },
        left:        { lx: +width/2, ly: 0 },
        right:       { lx: -width/2, ly: 0 },
      };
      this.#resizeAnchor = this.#toWorld(anchors[hit].lx, anchors[hit].ly);
    }
  }

  #onMouseMove(e) {
    if (!this.overlayCanvas) return;
    const rect = this.overlayCanvas.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;

    if (this.#rotating) {
      const { x: cx, y: cy, width, height } = this.cropArea;
      const ox = cx + width / 2, oy = cy + height / 2;
      this.cropRotation = Math.atan2(y - oy, x - ox) - this.#rotateStartAngle;
      this.drawCropArea();
      return;
    }

    this.updateCursor(x, y);

    if (this.dragging) {
      this.cropArea.x = this.#dragStart.cx + (x - this.#dragStart.x);
      this.cropArea.y = this.#dragStart.cy + (y - this.#dragStart.y);
      // Клэмп: держим центр рамки внутри canvas
      const cw = this.overlayCanvas.width, ch = this.overlayCanvas.height;
      this.cropArea.x = Math.max(-this.cropArea.width/2,  Math.min(cw - this.cropArea.width/2,  this.cropArea.x));
      this.cropArea.y = Math.max(-this.cropArea.height/2, Math.min(ch - this.cropArea.height/2, this.cropArea.y));
      this.drawCropArea();
    }

    if (this.resizing && this.activeHandle) {
      const { lx, ly } = this.#toLocal(x, y);
      this.resizeCropAreaLocal(lx, ly);
      this.drawCropArea();
      this.forceHandleCursor(this.activeHandle);
    }
  }

  #onMouseUp() {
    if (this.#rotating) {
      this.#rotating = false;
      this.#saveCropArea();
      this.overlayCanvas.style.cursor = 'default';
      return;
    }
    if (this.dragging) {
      this.dragging   = false;
      this.#dragStart = null;
      this.#saveCropArea();
    }
    if (this.resizing) {
      this.resizing      = false;
      this.activeHandle  = null;
      this.#resizeAnchor = null;
      this.#saveCropArea();
    }
  }

  #onTouchMove(e) {
    if (!this.overlayCanvas || !this.touchId || (!this.dragging && !this.resizing && !this.#rotating)) return;
    const touch = Array.from(e.touches).find(t => t.identifier === this.touchId);
    if (!touch) return;
    this.#onMouseMove({ clientX: touch.clientX, clientY: touch.clientY });
    e.preventDefault();
  }

  #onTouchStart(e) {
    e.preventDefault();
    if (!this.overlayCanvas || e.touches.length !== 1) return;
    this.touchId = e.touches[0].identifier;
    const touch  = e.touches[0];
    this.#onMouseDown({
      clientX: touch.clientX,
      clientY: touch.clientY,
    });
  }

  #onTouchEnd() { this.touchId = null; this.#onMouseUp(); }


  // ── Публичные методы: геометрия ─────────────────────────────────────────────

  /** Растягивает рамку на всё изображение (по двойному клику). */
  #expandCropArea() {
    const { width, height } = this.overlayCanvas;
    let nw = width, nh = height;
    if (this.aspectRatio) {
      if (width / height > this.aspectRatio) nw = height * this.aspectRatio;
      else                                   nh = width  / this.aspectRatio;
    }
    this.cropArea = { x: (width-nw)/2, y: (height-nh)/2, width: nw, height: nh };
    this.adjustCropToAspectRatio();
    this.drawCropArea();
  }

  /**
   * Устанавливает курсор для заданной ручки.
   * @param {string} h  Имя ручки ('topLeft' | 'top' | 'left' | ...).
   */
  forceHandleCursor(h) {
    const map = {
      topLeft:'nwse-resize', bottomRight:'nwse-resize',
      topRight:'nesw-resize', bottomLeft:'nesw-resize',
      top:'ns-resize', bottom:'ns-resize', left:'ew-resize', right:'ew-resize',
    };
    this.overlayCanvas.style.cursor = map[h] ?? 'default';
  }

  /** Корректирует cropArea под текущее соотношение сторон. */
  adjustCropToAspectRatio() {
    if (!this.fixedAspect) return;
    const cx = this.cropArea.x + this.cropArea.width  / 2;
    const cy = this.cropArea.y + this.cropArea.height / 2;
    const nw = this.cropArea.height * this.aspectRatio;
    const nh = this.cropArea.width  / this.aspectRatio;
    if (Math.abs(this.aspectRatio - this.cropArea.width / this.cropArea.height) > 0.01) {
      if (this.cropArea.width > nw) this.cropArea.width  = nw;
      else                          this.cropArea.height = nh;
    }
    this.cropArea.x = cx - this.cropArea.width  / 2;
    this.cropArea.y = cy - this.cropArea.height / 2;
  }

  /**
   * Масштабирует рамку по мировым координатам курсора.
   * Делегирует в resizeCropAreaLocal после перевода координат.
   */
  resizeCropArea(x, y) {
    const { lx, ly } = this.#toLocal(x, y);
    this.resizeCropAreaLocal(lx, ly);
  }

  /**
   * Масштабирует рамку по локальным координатам (с учётом поворота).
   * Якорная точка (противоположный угол/сторона) остаётся неподвижной.
   *
   * @param {number} lx  Локальная X-координата курсора.
   * @param {number} ly  Локальная Y-координата курсора.
   */
  resizeCropAreaLocal(lx, ly) {
    const ca  = this.cropArea;
    const min = 20;
    const mw  = this.fixedAspect ? Math.max(min, min * this.aspectRatio) : min;
    const mh  = this.fixedAspect ? Math.max(min, min / this.aspectRatio) : min;
    const hw  = ca.width / 2, hh = ca.height / 2;
    let newW = ca.width, newH = ca.height;

    switch (this.activeHandle) {
      case 'bottomRight':
        newW = Math.max(mw, hw + lx);
        newH = this.fixedAspect ? newW / this.aspectRatio : Math.max(mh, hh + ly);
        newH = Math.max(newH, mh);
        if (this.fixedAspect) newW = newH * this.aspectRatio;
        break;
      case 'topLeft':
        newW = Math.max(mw, hw - lx);
        newH = this.fixedAspect ? newW / this.aspectRatio : Math.max(mh, hh - ly);
        newH = Math.max(newH, mh);
        if (this.fixedAspect) newW = newH * this.aspectRatio;
        break;
      case 'topRight':
        newW = Math.max(mw, hw + lx);
        newH = this.fixedAspect ? newW / this.aspectRatio : Math.max(mh, hh - ly);
        newH = Math.max(newH, mh);
        if (this.fixedAspect) newW = newH * this.aspectRatio;
        break;
      case 'bottomLeft':
        newW = Math.max(mw, hw - lx);
        newH = this.fixedAspect ? newW / this.aspectRatio : Math.max(mh, hh + ly);
        newH = Math.max(newH, mh);
        if (this.fixedAspect) newW = newH * this.aspectRatio;
        break;
      case 'top':
        newH = Math.max(mh, hh - ly);
        if (this.fixedAspect) newW = newH * this.aspectRatio;
        break;
      case 'bottom':
        newH = Math.max(mh, hh + ly);
        if (this.fixedAspect) newW = newH * this.aspectRatio;
        break;
      case 'left':
        newW = Math.max(mw, hw - lx);
        if (this.fixedAspect) newH = newW / this.aspectRatio;
        break;
      case 'right':
        newW = Math.max(mw, hw + lx);
        if (this.fixedAspect) newH = newW / this.aspectRatio;
        break;
    }

    ca.width  = newW;
    ca.height = newH;

    if (this.#resizeAnchor) {
      // Пересчитываем центр рамки так, чтобы якорный угол остался на месте
      const anchorLocal = {
        topLeft:     { lx: +newW/2, ly: +newH/2 },
        topRight:    { lx: -newW/2, ly: +newH/2 },
        bottomLeft:  { lx: +newW/2, ly: -newH/2 },
        bottomRight: { lx: -newW/2, ly: -newH/2 },
        top:         { lx: 0,       ly: +newH/2 },
        bottom:      { lx: 0,       ly: -newH/2 },
        left:        { lx: +newW/2, ly: 0       },
        right:       { lx: -newW/2, ly: 0       },
      }[this.activeHandle];

      if (anchorLocal) {
        const cos = Math.cos(this.cropRotation), sin = Math.sin(this.cropRotation);
        const dax = anchorLocal.lx * cos - anchorLocal.ly * sin;
        const day = anchorLocal.lx * sin + anchorLocal.ly * cos;
        ca.x = this.#resizeAnchor.x - dax - newW / 2;
        ca.y = this.#resizeAnchor.y - day - newH / 2;
      }
    } else {
      // Fallback: сохраняем центр рамки
      const oldCX = ca.x + ca.width  / 2;
      const oldCY = ca.y + ca.height / 2;
      ca.x = oldCX - newW / 2;
      ca.y = oldCY - newH / 2;
    }
  }

  /** Обновляет курсор в зависимости от позиции указателя. */
  updateCursor(x, y) {
    if (this.dragging || this.resizing || this.#rotating) return;
    const hit = this.#hitTestRotated(x, y);
    if (!hit)              { this.overlayCanvas.style.cursor = 'default';    return; }
    if (hit === 'rotate')  { this.overlayCanvas.style.cursor = 'crosshair'; return; }
    if (hit === 'inside')  { this.overlayCanvas.style.cursor = 'move';      return; }
    this.forceHandleCursor(hit);
  }


  // ── Публичные методы: отрисовка ─────────────────────────────────────────────

  /** Перерисовывает canvas-оверлей с рамкой, сеткой и ручками. */
  drawCropArea() {
    if (!this.overlayCanvas) return;

    const clientW = this.overlayCanvas.clientWidth;
    const canvasW = this.overlayCanvas.width;
    const k = (clientW && canvasW) ? clientW / canvasW : 1;

    this.overlayCanvas.width  = this.photoEditor.imgElement.width;
    this.overlayCanvas.height = this.photoEditor.imgElement.height;

    // Масштабируем cropArea под новый display-размер
    if (Math.abs(k - 1) > 0.001) {
      this.cropArea = {
        x:      this.cropArea.x      * k,
        y:      this.cropArea.y      * k,
        width:  this.cropArea.width  * k,
        height: this.cropArea.height * k,
      };
      this.adjustCropToAspectRatio();
    }

    const ctx = this.overlayCtx;
    const { x, y, width, height } = this.cropArea;
    const cx  = x + width  / 2;
    const cy  = y + height / 2;
    const rot = this.cropRotation;

    ctx.clearRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);

    // ── Затемнение вне рамки через composition ───────────────────────────────
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, this.overlayCanvas.width, this.overlayCanvas.height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    ctx.fillStyle = 'rgba(0,0,0,1)';
    ctx.fillRect(-width / 2, -height / 2, width, height);
    ctx.restore();

    // ── Рамка, сетка и ручки ─────────────────────────────────────────────────
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);

    ctx.strokeStyle = this.cropColor;
    ctx.lineWidth   = 1;
    ctx.strokeRect(-width / 2, -height / 2, width, height);

    if (this.showGoldenRatio) {
      const crossSize = Math.max(4, Math.min(width, height) / 50);
      ctx.beginPath();
      [[0.382, 0.382],[0.382, 0.618],[0.618, 0.382],[0.618, 0.618]].forEach(([fx, fy]) => {
        const px = -width  / 2 + width  * fx;
        const py = -height / 2 + height * fy;
        ctx.moveTo(px - crossSize, py); ctx.lineTo(px + crossSize, py);
        ctx.moveTo(px, py - crossSize); ctx.lineTo(px, py + crossSize);
      });
      ctx.stroke();
    }

    this.drawResizeHandlesRotated(ctx, width, height);

    // Ручка вращения
    const rotHandleY = -height / 2 - EditorConfig.crop.rotateHandleOffset;
    ctx.strokeStyle = this.cropColor;
    ctx.lineWidth   = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, -height / 2);
    ctx.lineTo(0, rotHandleY);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle   = 'rgba(255,255,255,0.9)';
    ctx.strokeStyle = this.cropColor;
    ctx.lineWidth   = 1.5;
    ctx.beginPath();
    ctx.arc(0, rotHandleY, this.resizeHandleSize * 0.75, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.restore();
  }

  /**
   * Рисует угловые ручки масштабирования в локальной системе координат
   * (до ctx.restore() после ctx.rotate(rot)).
   */
  drawResizeHandlesRotated(ctx, width, height) {
    const s  = this.resizeHandleSize, t = 2.5;
    const hw = width / 2, hh = height / 2;
    ctx.strokeStyle = this.cropColor;
    ctx.lineWidth   = t;
    ctx.lineCap     = 'square';
    [
      [-hw, -hh, +1, +1],
      [+hw, -hh, -1, +1],
      [-hw, +hh, +1, -1],
      [+hw, +hh, -1, -1],
    ].forEach(([cx2, cy2, hd, vd]) => {
      ctx.beginPath();
      ctx.moveTo(cx2 + hd * s, cy2);
      ctx.lineTo(cx2, cy2);
      ctx.lineTo(cx2, cy2 + vd * s);
      ctx.stroke();
    });
  }

  /**
   * Рисует угловые ручки в экранных координатах (без поворота).
   * Используется как фоллбэк в режиме без вращения.
   */
  drawResizeHandles() {
    const { x, y, width, height } = this.cropArea;
    const s   = this.resizeHandleSize, t = 2.5;
    const ctx = this.overlayCtx;
    ctx.strokeStyle = this.cropColor; ctx.lineWidth = t; ctx.lineCap = 'square';
    [[x, y, +1, +1],[x+width, y, -1, +1],[x, y+height, +1, -1],[x+width, y+height, -1, -1]]
      .forEach(([cx, cy, hd, vd]) => {
        ctx.beginPath();
        ctx.moveTo(cx+hd*s, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy+vd*s);
        ctx.stroke();
      });
  }


  // ── Публичный метод: применение кропа ───────────────────────────────────────

  /**
   * Вырезает выбранную область из изображения и записывает результат
   * через commitImage() — history, dirty-флаг, обновление imgElement.
   *
   * Поддерживает повёрнутые рамки: обратный поворот через canvas-трансформации.
   * После применения canvas-оверлей и панель уничтожаются.
   */
  crop() {
    this.#saveCropArea();
    const na  = this.naturalCropArea;
    const img = this.photoEditor.img;
    const rot = this.cropRotation;
    const nw  = na.width, nh = na.height;

    const out = document.createElement('canvas');
    out.width  = nw;
    out.height = nh;
    const ctx  = out.getContext('2d');

    if (Math.abs(rot) < 0.001) {
      // Без поворота — простое извлечение прямоугольника
      ctx.drawImage(img, na.x, na.y, nw, nh, 0, 0, nw, nh);
    } else {
      // С поворотом: рисуем изображение с обратным поворотом,
      // центрируя на центре рамки, чтобы выровнять содержимое
      const ncx = na.x + nw / 2;
      const ncy = na.y + nh / 2;
      ctx.save();
      ctx.translate(nw / 2, nh / 2);
      ctx.rotate(-rot);
      ctx.drawImage(img, -ncx, -ncy, img.naturalWidth, img.naturalHeight);
      ctx.restore();
    }

    // Сохранение в источник (this.photoEditor.export) происходит только при
    // явном закрытии редактора через requestClose() — не здесь.

    const url    = out.toDataURL('image/png');
    const newImg = new Image();
    newImg.onload = () => {
      this.photoEditor.commitImage(newImg);
      // Уведомляем OverlayTool о смене изображения — он перерисует свои оверлеи
      const ov = this.photoEditor.tools?.overlay;
      // redraw() — публичный метод OverlayTool; прямой вызов #draw() невозможен
      // из-за ES2022 Private Fields (SyntaxError при доступе к # из другого класса).
      if (ov?.overlayCanvas) requestAnimationFrame(() => ov.redraw());
    };
    newImg.src = url;

    this.naturalCropArea = null;
    this.cropRotation    = 0;
    this.#destroy();
  }
}
