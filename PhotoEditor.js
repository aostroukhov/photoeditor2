import { CropTool }       from './CropTool.js';
import { FileInput }      from './FileInput.js';
import { OverlayTool }    from './OverlayTool.js';
import { DrawTool }       from './DrawTool.js';
import { MaskTool }       from './MaskTool.js';
import { AdjustTool }     from './AdjustTool.js';
import { HealTool }       from './HealTool.js';
import { ExportPanel }    from './ExportPanel.js';
import { ImportPanel }    from './ImportPanel.js';
import { DialogManager }  from './DialogManager.js';
import { EditorConfig }   from './EditorConfig.js';
import { HistoryManager } from './HistoryManager.js';
import { isEditableTarget, escapeHtml } from './utils.js';

/**
 * PhotoEditor v3.6
 *
 * Изменения v3.6:
 *  • Все внутренние поля и методы переведены на ES2022 Private Fields (#).
 *    Доступ к ним извне вызывает SyntaxError на этапе парсинга — это
 *    синтаксическая защита движка JS, а не конвенция именования.
 *  • requestClose() — переименован из _requestClose(); теперь честный
 *    публичный метод. Плагины и внешний код должны вызывать именно его,
 *    а не close() напрямую.
 *  • _handleToolStop() удалён: метод был no-op после v3.6; инструменты
 *    обращались к нему через ?. — они молча получат undefined.
 *  • toolOnOpen по умолчанию: null вместо 'heal'. Инструмент запускается
 *    автоматически только при явной передаче opts.toolOnOpen.
 *  • Применение инструмента больше не закрывает редактор и не экспортирует
 *    изображение в источник автоматически.
 *
 * ── Разделение публичного и приватного API ──────────────────────────────────
 *
 * Публичные поля (доступны инструментам, панелям, плагинам):
 *   img, container, imgElement, fileInput, export
 *   originalFileName, originalMimeType, originalFileSize
 *   beforeOpen, afterOpen, beforeClose, afterClose
 *   activeTool, toolOnOpen, tools, dialogs
 *
 * Публичные методы (внешний API):
 *   open(), close(), requestClose()
 *   setImage(), clearImage()
 *   bindToFileInput()
 *   syncToolButtons()
 *   commitImage()
 *   notifyExportDone()
 *
 * Приватные поля (#):
 *   #opts, #isDirty, #exportDone, #history, #pendingHistoryRic,
 *   #historyUnsub, #allTools, #exportPanel, #importPanel, #onKeyDownBound
 *
 * Приватные методы (#):
 *   #ensureOinfoFont, #icon, #buildDOM
 *   #bindEvents, #unbindEvents, #onKeyDown
 *   #handleToolClick, #handleActionClick
 *   #showCloseConfirmDialog, #exportToTarget
 *   #showInfoDialog, #guessFormat, #formatFileSize
 *   #pushHistory, #undo, #redo, #updateHistoryUI, #updateInfo
 *   static #afterRender, static #ensureCSS
 */

export { EditorConfig };

export const TOOL_REGISTRY = EditorConfig.tools;

export class PhotoEditor {

  // ── Объявление приватных полей ─────────────────────────────────────────────
  //
  // ES2022 Private Fields (#) — не конвенция, а синтаксическая защита движка:
  // обращение к #-полю снаружи класса вызывает SyntaxError при парсинге,
  // до выполнения кода. Это принципиально сильнее, чем _underscore,
  // который никак не ограничивает доступ.
  //
  // Все поля объявлены в начале класса — это обязательно для приватных полей
  // в ES2022: попытка использовать #поле без объявления — SyntaxError.

  /** Опции, переданные в конструктор (не изменяются после создания). */
  #opts;

  /**
   * true — инструмент зафиксировал хотя бы одно изменение с момента open().
   * Сбрасывается в false при каждом open().
   * Используется в requestClose() для решения о показе диалога.
   */
  #isDirty = false;

  /**
   * true — пользователь выполнил экспорт после последнего commitImage().
   * Актуально только в автономном режиме (this.export === null).
   * Сбрасывается в false при каждом commitImage().
   */
  #exportDone = false;

  /** Менеджер истории undo/redo. Создаётся в конструкторе, уничтожается в close(). */
  #history;

  /**
   * Handle от requestIdleCallback / setTimeout для отложенного снапшота.
   * Хранится чтобы иметь возможность отменить его в close() — без этого
   * doCapture может сработать уже после уничтожения контекста редактора.
   */
  #pendingHistoryRic = null;

  /** Функция отписки от HistoryManager.onUpdate(). Вызывается в close(). */
  #historyUnsub = null;

  /**
   * Полный реестр всех инструментов редактора, созданных в конструкторе.
   * this.tools — его публичное отфильтрованное подмножество по opts.tools.
   * #allTools нужен в close() для вызова destroy() у каждого инструмента,
   * включая те, что не вошли в this.tools.
   */
  #allTools;

  /** Экземпляр ExportPanel — создаётся в open(), уничтожается в close(). */
  #exportPanel = null;

  /** Экземпляр ImportPanel — создаётся в open(), уничтожается в close(). */
  #importPanel = null;

  /**
   * Связанный (bound) обработчик keydown.
   *
   * Хранится как приватное поле (а не создаётся через .bind() в #bindEvents)
   * чтобы removeEventListener в #unbindEvents получил тот же объект функции.
   * Без этого removeEventListener молча ничего не делает — слушатель остаётся
   * навсегда, и при каждом open() вешается ещё один.
   *
   * Инициализируется стрелочным полем — доступен с первого такта конструктора,
   * не требует явного вызова .bind(this).
   */
  #onKeyDownBound = (e) => this.#onKeyDown(e);


  // ── Публичные поля ─────────────────────────────────────────────────────────
  //
  // Намеренно оставлены публичными: к ним обращаются инструменты, панели
  // и плагины — это часть контракта API редактора.

  /** Текущее изображение редактора. Обновляется только через commitImage(). */
  img        = null;
  /** Корневой DOM-элемент редактора. null когда редактор закрыт. */
  container  = null;
  /** Элемент <img> внутри холста редактора. null когда редактор закрыт. */
  imgElement = null;
  /** Экземпляр FileInput (если редактор привязан к файловому полю). */
  fileInput  = null;

  /**
   * Колбэк экспорта: (canvas: HTMLCanvasElement) => void.
   *
   * null — редактор работает автономно (без источника/цели).
   * Задаётся через bindToFileInput() или вручную снаружи.
   * Наличие этого колбэка определяет режим диалога в requestClose():
   *   • задан     → «Сохранить / Не сохранять»
   *   • null      → «Уверены, что хотите закрыть?»
   */
  export     = null;

  /** Оригинальное имя файла — устанавливается при импорте через ImportPanel. */
  originalFileName = null;
  /** Оригинальный MIME-тип — устанавливается при импорте. */
  originalMimeType = null;
  /** Оригинальный размер файла в байтах — устанавливается при импорте. */
  originalFileSize = null;

  /** Вызывается перед монтированием DOM редактора. */
  beforeOpen  = null;
  /** Вызывается после полного рендера редактора (после двух rAF). */
  afterOpen   = null;
  /** Вызывается перед размонтированием DOM редактора. */
  beforeClose = null;
  /** Вызывается после размонтирования и очистки всех ресурсов. */
  afterClose  = null;

  /** Ссылка на активный в данный момент инструмент (или null). */
  activeTool = null;

  /**
   * Имя инструмента, который будет запущен автоматически при open().
   *
   * null — ни один инструмент не запускается (поведение по умолчанию).
   *
   * Значение null выбрано намеренно (EditorConfig задаёт 'heal' по умолчанию,
   * но мы его перекрываем). Причины:
   *   1. Автозапуск инструмента сразу после open() создаёт плохой UX —
   *      пользователь не успевает сориентироваться в интерфейсе.
   *   2. В режиме src/target автозапуск приводил к немедленному сохранению
   *      и закрытию редактора после нажатия «Применить» (bug v3.5).
   *
   * Для включения передайте явно: new PhotoEditor({ toolOnOpen: 'crop' })
   */
  toolOnOpen = null;

  /**
   * Отфильтрованный реестр доступных инструментов (согласно opts.tools).
   * Ключи: 'heal' | 'crop' | 'overlay' | 'draw' | 'mask' | 'adjust'.
   */
  tools = {};

  /** Менеджер диалоговых панелей. null когда редактор закрыт. */
  dialogs = null;


  // ── Конструктор ───────────────────────────────────────────────────────────

  constructor(opts = {}) {
    this.#opts = {
      tools:          EditorConfig.editor.defaultTools,
      toolOnOpen:     null,
      showImport:     true,
      showExport:     true,
      cropOptions:    {},
      overlayOptions: {},
      /**
       * Параметры пустого холста — используются когда open() вызывается
       * без предварительно загруженного изображения.
       *   width  {number}  ширина в пикселях  (default: 800)
       *   height {number}  высота в пикселях  (default: 600)
       *   color  {string}  CSS-цвет заливки   (default: '#ffffff')
       */
      blankCanvas: { width: 800, height: 600, color: '#ffffff' },
      ...opts,
    };

    this.toolOnOpen = this.#opts.toolOnOpen;

    this.#history = new HistoryManager();

    this.#allTools = {
      heal:    new HealTool(this),
      crop:    new CropTool(this),
      overlay: new OverlayTool(this, this.#opts.overlayOptions),
      draw:    new DrawTool(this),
      mask:    new MaskTool(this),
      adjust:  new AdjustTool(this),
    };

    if (this.#opts.cropOptions.aspectRatio) {
      this.#allTools.crop.setAspectRatio(this.#opts.cropOptions.aspectRatio);
    }

    this.#opts.tools.forEach(n => {
      if (this.#allTools[n]) this.tools[n] = this.#allTools[n];
    });

    // Привязываем open/close к экземпляру — чтобы их можно было передавать
    // как колбэки без потери контекста (например, в addEventListener).
    this.close = this.close.bind(this);
    this.open  = this.open.bind(this);
  }


  // ── Публичный API ──────────────────────────────────────────────────────────

  /**
   * Привязывает редактор к файловому полю <input type="file">.
   * После привязки this.export указывает на FileInput.export() —
   * редактор работает в режиме src/target.
   *
   * @param {HTMLInputElement} el
   */
  bindToFileInput(el) {
    if (!this.fileInput) this.fileInput = new FileInput(this);
    this.fileInput.bind(el);
    this.export = (canvas) => this.fileInput.export(canvas);
  }

  /**
   * Загружает изображение в редактор.
   *
   * Допустимые значения src:
   *   • data:image/…   — dataURL
   *   • blob:…         — blob URL (немедленно конвертируется в dataURL,
   *                      пока blob не был отозван вызывающим кодом)
   *   • https?://…     — абсолютный URL
   *   • //…            — protocol-relative URL
   *   • /…             — относительный путь от корня сайта
   *   • HTMLImageElement — берётся .src элемента
   *
   * Небезопасные значения (null, undefined, '', 'null', 'undefined')
   * автоматически перенаправляются в clearImage() — это предотвращает
   * появление <img src="null"> и лишних сетевых запросов в консоли.
   *
   * @param {string|HTMLImageElement} src
   * @param {{ fileName?: string, mimeType?: string, fileSize?: number }} [meta]
   * @returns {Promise<HTMLImageElement|null>}
   */
  setImage(src, { fileName = null, mimeType = null, fileSize = null } = {}) {
    if (src instanceof HTMLImageElement) src = src.src;

    const isEmptySrc = src == null
                    || src === ''
                    || src === 'null'
                    || src === 'undefined';
    if (isEmptySrc) {
      this.clearImage();
      return Promise.resolve(null);
    }

    // Белый список допустимых схем — всё остальное отклоняем
    const isValidSrc = typeof src === 'string'
                    && (  src.startsWith('data:')
                       || src.startsWith('blob:')
                       || src.startsWith('http:')
                       || src.startsWith('https:')
                       || src.startsWith('//')
                       || src.startsWith('/')
                       );
    if (!isValidSrc) {
      console.warn('[PhotoEditor] setImage(): недопустимый src, вызов игнорирован:', src);
      return Promise.reject(new Error('Invalid src'));
    }

    return new Promise((resolve, reject) => {
      const img  = new Image();
      img.onload = () => {
        // Если src — blob URL: конвертируем в dataURL сразу после загрузки,
        // пока blob не был отозван вызывающим кодом после resolve Promise.
        if (src.startsWith('blob:')) {
          const cv = document.createElement('canvas');
          cv.width  = img.naturalWidth;
          cv.height = img.naturalHeight;
          cv.getContext('2d').drawImage(img, 0, 0);
          const dataUrl = cv.toDataURL('image/png');
          const img2 = new Image();
          img2.onload = () => {
            this.img = img2;
            if (fileName !== null) this.originalFileName = fileName;
            if (mimeType !== null) this.originalMimeType = mimeType;
            if (fileSize !== null) this.originalFileSize = fileSize;
            if (this.imgElement) { this.imgElement.src = img2.src; this.#updateInfo(); }
            this.#pushHistory();
            resolve(img2);
          };
          img2.onerror = reject;
          img2.src = dataUrl;
        } else {
          this.img = img;
          if (fileName !== null) this.originalFileName = fileName;
          if (mimeType !== null) this.originalMimeType = mimeType;
          if (fileSize !== null) this.originalFileSize = fileSize;
          if (this.imgElement) { this.imgElement.src = img.src; this.#updateInfo(); }
          this.#pushHistory();
          resolve(img);
        }
      };
      img.onerror = reject;
      img.src     = src;
    });
  }

  /**
   * Сбрасывает текущее изображение без присвоения imgElement.src пустого значения.
   *
   * Использует removeAttribute('src') вместо src = '' или src = null —
   * это предотвращает лишние сетевые запросы и ошибки в консоли.
   *
   * Если редактор открыт — imgElement скрывается через display:none.
   * Если закрыт — только сбрасывается внутреннее состояние.
   */
  clearImage() {
    this.img              = null;
    this.originalFileName = null;
    this.originalMimeType = null;
    this.originalFileSize = null;

    if (this.imgElement) {
      this.imgElement.removeAttribute('src');
      this.imgElement.style.display = 'none';
      this.#updateInfo();
    }
  }

  /**
   * Открывает редактор.
   *
   * Если this.img задан — загружает изображение в холст.
   * Если this.img не задан — создаёт пустой холст по параметрам
   * opts.blankCanvas через setImage(), чтобы инструменты получили
   * корректный img.naturalWidth/Height до своего старта.
   *
   * Идемпотентен: повторный вызов при уже открытом редакторе игнорируется.
   */
  open() {
    if (this.container) return;
    if (this.beforeOpen) this.beforeOpen(this);

    this.#ensureOinfoFont();
    this.container = this.#buildDOM();
    document.body.appendChild(this.container);
    document.body.classList.add(EditorConfig.editor.bodyClass);

    // Сбрасываем флаги изменений для новой сессии редактора
    this.#isDirty    = false;
    this.#exportDone = false;

    PhotoEditor.#ensureCSS('.photoeditor__container', 'z-index',
      EditorConfig.editor.zIndex,
      new URL('./layout.css', import.meta.url).href);

    this.imgElement = this.container.querySelector('.photoeditor__img');

    // Пересоздаём историю для новой сессии редактирования.
    //
    // Проблема, которую это решает:
    //   setImage() до open() (например, в fileInput._openEditor) и/или
    //   setImage() при предзагрузке (_importFile) пушат снапшоты в историю.
    //   Без сброса эти снапшоты накапливаются: undo-кнопка показывает
    //   глубину > 0 сразу после открытия, хотя пользователь ещё ничего не делал.
    //
    // Правило: baseline для undo — изображение, загруженное непосредственно
    // перед open(). setImage() вызывается до open(), пушит снапшот через
    // setTimeout(0). Этот push выполняется ПОСЛЕ того как мы создали новую
    // историю, поэтому он корректно становится первой (baseline) записью.
    this.#historyUnsub?.();
    this.#history.destroy();
    this.#history = new HistoryManager();
    this.#historyUnsub = this.#history.onUpdate(() => this.#updateHistoryUI());
    this.#updateHistoryUI();

    this.dialogs = new DialogManager(this);

    this.#unbindEvents();
    this.#bindEvents();

    if (this.#opts.showImport) {
      this.#importPanel = new ImportPanel(this);
      this.#importPanel.mount(this.container);
    }
    if (this.#opts.showExport) {
      this.#exportPanel = new ExportPanel(this);
      this.#exportPanel.mount(this.container);
    }

    // Общий финализатор: вызывается после полного рендера imgElement.
    // Двойной rAF гарантирует что браузер завершил layout и paint.
    const finalizeOpen = () => {
      PhotoEditor.#afterRender(() => {
        this.#updateInfo();
        if (this.toolOnOpen && this.tools[this.toolOnOpen]) {
          this.tools[this.toolOnOpen].start();
        }
        if (this.afterOpen) this.afterOpen(this);
      });
    };

    if (this.img) {
      // Обычный режим: восстанавливаем display на случай если clearImage() его скрыл
      this.imgElement.style.display = '';
      this.imgElement.addEventListener('load', finalizeOpen, { once: true });
      this.imgElement.src = this.img.src;
    } else {
      // Пустой холст: создаём через setImage() и только после загрузки финализируем.
      const bc  = { width: 800, height: 600, color: '#ffffff', ...this.#opts.blankCanvas };
      const cv  = document.createElement('canvas');
      cv.width  = bc.width;
      cv.height = bc.height;
      const ctx = cv.getContext('2d');
      ctx.fillStyle = bc.color;
      ctx.fillRect(0, 0, bc.width, bc.height);

      this.setImage(cv.toDataURL('image/png')).then(() => {
        this.imgElement.style.display = '';
        this.imgElement.addEventListener('load', finalizeOpen, { once: true });
        this.imgElement.src = this.img.src;
      }).catch(err => {
        console.error('[PhotoEditor] open(): не удалось создать пустой холст', err);
      });
    }
  }

  /**
   * Немедленно закрывает редактор без диалогов подтверждения.
   *
   * Использовать напрямую только в системных сценариях:
   * таймаут сессии, навигация со страницы, аварийное завершение.
   *
   * В остальных случаях — requestClose(): он покажет диалог если нужно.
   */
  close() {
    if (!this.container) return;
    if (this.beforeClose) this.beforeClose(this);

    this.dialogs?.closeAll();

    Object.values(this.#allTools).forEach(t => t.destroy?.());

    this.#exportPanel?.unmount(); this.#exportPanel = null;
    this.#importPanel?.unmount(); this.#importPanel = null;
    this.#unbindEvents();

    // Отменяем отложенный снапшот — без этого doCapture может сработать
    // после уничтожения контекста редактора и записать в историю мусор
    if (this.#pendingHistoryRic != null) {
      if (typeof cancelIdleCallback !== 'undefined') cancelIdleCallback(this.#pendingHistoryRic);
      else clearTimeout(this.#pendingHistoryRic);
      this.#pendingHistoryRic = null;
    }
    this.#historyUnsub?.();
    this.#history.destroy();

    document.body.classList.remove(EditorConfig.editor.bodyClass);
    this.container.remove();
    this.container  = null;
    this.imgElement = null;
    this.dialogs    = null;

    if (this.afterClose) this.afterClose(this);
  }

  /**
   * Безопасное закрытие редактора с проверкой несохранённых изменений.
   *
   * Должен вызываться вместо close() из любого внешнего кода:
   * кнопка «Закрыть» в тулбаре, клавиша Escape, плагины, window.photoEditorCms.
   *
   * Логика выбора диалога:
   *
   *   #isDirty = false → закрываем сразу, без диалога.
   *
   *   this.export задан (режим src/target):
   *     → диалог «Сохранить / Не сохранять».
   *       «Сохранить» — primary (выделен визуально как основной путь).
   *
   *   this.export = null (автономный режим):
   *     #exportDone = true  → закрываем без диалога (экспорт уже выполнен).
   *     #exportDone = false → диалог «Уверены, что хотите закрыть?».
   *       «Нет» — primary (выделен как основной путь).
   */
  requestClose() {
    if (!this.container) return;

    if (!this.#isDirty) {
      this.close();
      return;
    }

    if (this.export) {
      // Режим src/target: есть куда сохранять — предлагаем сохранить
      this.#showCloseConfirmDialog('save-or-discard').then(result => {
        if (result === 'save') {
          // Ждём завершения async-экспорта (например, save-to-server в photoEditContent)
          // перед закрытием. Если экспорт упадёт — редактор останется открытым,
          // сам export-колбэк обязан показать ошибку пользователю.
          this.#exportToTarget()
            .then(() => this.close())
            .catch(err => {
              console.error('[PhotoEditor] requestClose: export failed, editor stays open', err);
            });
        } else if (result === 'discard') {
          this.close();
        }
        // 'cancel' → редактор остаётся открытым
      });
    } else {
      // Автономный режим: если экспорт уже сделан — закрываем молча
      if (this.#exportDone) {
        this.close();
        return;
      }
      this.#showCloseConfirmDialog('confirm-close').then(result => {
        if (result === 'yes') this.close();
        // 'no' / 'cancel' → редактор остаётся открытым
      });
    }
  }

  /** Синхронизирует CSS-классы кнопок инструментов с их текущим состоянием. */
  syncToolButtons() {
    if (!this.container) return;
    this.container.querySelectorAll('[data-tool]').forEach(btn => {
      const t = this.tools[btn.dataset.tool];
      btn.classList.toggle('is-active',    Boolean(t?.isActive));
      btn.classList.toggle('is-suspended', Boolean(t?.isSuspended));
    });
  }

  /**
   * Устанавливает новое изображение, обновляет отображение и пушит снапшот в историю.
   *
   * Все инструменты обязаны вызывать этот метод вместо прямого pe.img = newImg.
   * Прямое присваивание обходит: отслеживание изменений (#isDirty), сброс
   * флага экспорта (#exportDone) и запись в историю.
   *
   * @param {HTMLImageElement} img
   */
  commitImage(img) {
    this.img = img;
    if (this.imgElement) { this.imgElement.src = img.src; this.#updateInfo(); }
    this.#isDirty    = true;
    this.#exportDone = false;
    this.#pushHistory();
  }

  /**
   * Вызывается ExportPanel и плагинами после успешного экспорта/сохранения.
   *
   * Устанавливает #exportDone = true. Благодаря этому requestClose() в
   * автономном режиме закроет редактор без диалога подтверждения —
   * пользователь уже явно сохранил результат.
   *
   * Сбрасывается в false при следующем commitImage() — новое применение
   * инструмента «аннулирует» предыдущий экспорт.
   */
  notifyExportDone() {
    this.#exportDone = true;
  }


  // ── Диалог «О редакторе / параметры изображения» ──────────────────────────

  #showInfoDialog() {
    if (!this.container) return;

    const img  = this.img;
    const w    = img?.naturalWidth  || 0;
    const h    = img?.naturalHeight || 0;
    const fmt  = this.#guessFormat();
    const name = this.originalFileName || '—';

    const rows = [
      ['Версия редактора', `PhotoEditor v${EditorConfig.VERSION}`],
      ['Оригинальное имя',  name],
      ['Исходный формат',   fmt],
      ['Ширина',            w ? `${w} px` : '—'],
      ['Высота',            h ? `${h} px` : '—'],
      ['Глубина цвета',     '32 бит (8 бит/канал, RGBA)'],
      ['Размер файла',      this.#formatFileSize(this.originalFileSize)],
    ];

    const tableRows = rows.map(([k, v]) =>
      `<tr><td class="pe-info-dialog__key">${k}</td>` +
      `<td class="pe-info-dialog__val">${v}</td></tr>`
    ).join('');

    let dlg = this.container.querySelector('.pe-info-dialog');
    if (!dlg) {
      dlg = document.createElement('div');
      dlg.className = 'pe-panel pe-info-dialog';
      dlg.innerHTML = `
        <div class="pe-panel__header">
          <span class="pe-panel__title">О редакторе</span>
        </div>
        <table class="pe-info-dialog__table">
          <tbody>${tableRows}</tbody>
        </table>
        <button type="button" class="photoeditor__button photoeditor__button--compact pe-info-dialog__reset-btn"
                title="Очистить историю оверлеев, сохранённый цвет и другие данные редактора в браузере">
          <i class="icon-bin" aria-hidden="true"></i> Сбросить настройки
        </button>
        <div class="pe-info-dialog__reset-status" aria-live="polite"></div>`;
      this.container.appendChild(dlg);
      this.dialogs?.register('info', dlg, {
        group:       'utility',
        btnSelector: '[data-action="toggle-info"]',
      });
      dlg.querySelector('.pe-info-dialog__reset-btn').addEventListener('click', () => {
        const n      = EditorConfig.clearStoredData();
        const status = dlg.querySelector('.pe-info-dialog__reset-status');
        status.textContent = n > 0
          ? `✓ Очищено ${n} запис${n === 1 ? 'ь' : n < 5 ? 'и' : 'ей'}`
          : '✓ Нечего очищать';
        status.className = 'pe-info-dialog__reset-status pe-info-dialog__reset-status--ok';
        setTimeout(() => {
          status.textContent = '';
          status.className   = 'pe-info-dialog__reset-status';
        }, 3000);
      });
    } else {
      const tbody = dlg.querySelector('tbody');
      if (tbody) tbody.innerHTML = tableRows;
    }

    this.dialogs?.toggle('info');
  }

  #guessFormat() {
    if (this.originalMimeType) {
      const m = this.originalMimeType.split('/')[1]?.toUpperCase();
      if (m) return m;
    }
    if (this.originalFileName) {
      const ext = this.originalFileName.split('.').pop()?.toUpperCase();
      if (ext) return ext;
    }
    const src = this.img?.src || '';
    if (src.startsWith('data:image/')) {
      const m = src.slice(11, src.indexOf(';')).toUpperCase();
      if (m) return m;
    }
    return '—';
  }

  #formatFileSize(bytes) {
    if (bytes == null || bytes === 0) return '—';
    if (bytes < 1024)        return `${bytes} Б`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} МБ`;
  }


  // ── Приватные методы ───────────────────────────────────────────────────────

  #ensureOinfoFont() {
    const url = EditorConfig.editor.oinfoFontUrl;
    if (document.querySelector(`link[href="${url}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = url;
    document.head.appendChild(l);
  }

  #icon(cls, extraCls = '') {
    return `<i class="pe-icon ${cls}${extraCls ? ' ' + extraCls : ''}" aria-hidden="true"></i>`;
  }

  #buildDOM() {
    const toolBtns = Object.keys(this.tools).map(name => {
      const m = TOOL_REGISTRY[name] ?? { label: name, icon: 'icon-crop' };
      return `<button type="button"
                      class="pe-toolbar__btn pe-toolbar__btn--tool"
                      data-tool="${name}"
                      aria-label="${m.label}">
               ${this.#icon(m.icon)}
               <span class="pe-toolbar__label">${m.label}</span>
              </button>`;
    }).join('');

    const impBtn = this.#opts.showImport
      ? `<button type="button" class="pe-toolbar__btn pe-toolbar__btn--action"
                 data-action="toggle-import" aria-label="Импорт">
          ${this.#icon('icon-upload')}
          <span class="pe-toolbar__label">Импорт</span>
         </button>` : '';

    const expBtn = this.#opts.showExport
      ? `<button type="button" class="pe-toolbar__btn pe-toolbar__btn--action"
                 data-action="toggle-export" aria-label="Экспорт">
          ${this.#icon('icon-download')}
          <span class="pe-toolbar__label">Экспорт</span>
         </button>` : '';

    const undoBtn = `<button type="button"
               class="pe-toolbar__btn pe-toolbar__btn--action pe-toolbar__btn--undo"
               data-action="undo" aria-label="Отменить" disabled>
          ${this.#icon('icon-undo')}
          <span class="pe-toolbar__label">Отменить</span>
          <span class="pe-history-badge" aria-hidden="true"></span>
         </button>`;

    const redoBtn = `<button type="button"
               class="pe-toolbar__btn pe-toolbar__btn--action pe-toolbar__btn--redo"
               data-action="redo" aria-label="Повторить" disabled>
          ${this.#icon('icon-redo')}
          <span class="pe-toolbar__label">Повторить</span>
         </button>`;

    const infoBtn = `<button type="button"
               class="pe-toolbar__btn pe-toolbar__btn--action"
               data-action="toggle-info" aria-label="О редакторе">
          ${this.#icon('icon-question')}
          <span class="pe-toolbar__label">&nbsp;</span>
         </button>`;

    const w = document.createElement('div');
    w.className = 'photoeditor__container';
    w.innerHTML = `
      <div class="pe-workspace">
        <div class="photoeditor__img-container">
          <div class="photoeditor__info"></div>
          <img class="photoeditor__img" alt="">
        </div>
      </div>
      <nav class="pe-toolbar" role="toolbar" aria-label="Инструменты редактора">
        <div class="pe-toolbar__group pe-toolbar__group--tools">${toolBtns}</div>
        <div class="pe-toolbar__group pe-toolbar__group--actions">
          ${undoBtn}${redoBtn}${impBtn}${expBtn}${infoBtn}
          <button type="button" class="pe-toolbar__btn pe-toolbar__btn--close"
                  data-action="close" aria-label="Закрыть">
            ${this.#icon('icon-close')}
            <span class="pe-toolbar__label">Закрыть</span>
          </button>
        </div>
      </nav>`;
    return w;
  }

  #bindEvents() {
    document.addEventListener('keydown', this.#onKeyDownBound);

    this.container.querySelector('.pe-toolbar')
      ?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-tool],[data-action]');
        if (!btn) return;
        if (btn.dataset.tool)   this.#handleToolClick(btn.dataset.tool);
        if (btn.dataset.action) this.#handleActionClick(btn.dataset.action);
      });
  }

  #unbindEvents() {
    document.removeEventListener('keydown', this.#onKeyDownBound);
  }

  #handleToolClick(name) {
    const tool = this.tools[name];
    if (!tool) return;

    // Повторный клик по активному инструменту — открываем его настройки
    if (tool.isActive) {
      tool.openSettings?.();
      return;
    }

    // Клик по приостановленному инструменту — возобновляем его
    if (tool.isSuspended) {
      this.activeTool?.suspend?.();
      this.dialogs?.closeGroup('utility');
      tool.start();
      this.syncToolButtons();
      return;
    }

    // Новый инструмент: приостанавливаем текущий и запускаем выбранный.
    // Ждём готовности imgElement — если изображение ещё грузится,
    // start() вызовется по событию load, а не немедленно.
    this.activeTool?.suspend?.();
    this.dialogs?.closeGroup('utility');

    const doStart = () => {
      tool.start();
      this.syncToolButtons();
    };

    if (this.imgElement?.complete && this.imgElement.naturalWidth) {
      doStart();
    } else if (this.imgElement) {
      this.imgElement.addEventListener('load', doStart, { once: true });
    }
  }

  #handleActionClick(action) {
    if (action === 'close')       { this.requestClose(); return; }
    if (action === 'toggle-info') { this.#showInfoDialog(); return; }
    if (action === 'undo')        { this.#undo(); return; }
    if (action === 'redo')        { this.#redo(); return; }

    if (action === 'toggle-import') {
      if (!this.dialogs?.isOpen('import')) this.dialogs?.closeGroup('tool');
      this.dialogs?.toggle('import');
    }
    if (action === 'toggle-export') {
      if (!this.dialogs?.isOpen('export')) this.dialogs?.closeGroup('tool');
      this.dialogs?.toggle('export');
    }
  }

  #onKeyDown(e) {
    // Инструмент с собственным capture-слушателем уже обработал клавишу
    if (e.defaultPrevented) return;

    // Клавиши внутри текстовых полей панелей принадлежат полю, а не редактору:
    // Backspace не должен удалять оверлей, стрелки — двигать его, Escape — закрывать редактор.
    if (isEditableTarget(e)) {
      if (e.key === 'Escape') { e.preventDefault(); e.target.blur(); }
      return;
    }

    // Сначала предлагаем событие активному инструменту
    if (this.activeTool?.onKeyDown?.(e)) { e.preventDefault(); return; }

    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && !e.shiftKey && e.code === 'KeyZ') { e.preventDefault(); this.#undo(); return; }
    if (ctrl && (e.shiftKey && e.code === 'KeyZ' || e.code === 'KeyY')) { e.preventDefault(); this.#redo(); return; }

    if (e.key === 'Escape') {
      // Если открыты диалоги инструментов — закрываем только их, не редактор
      if (this.dialogs && this.dialogs._active.size > 0) {
        this.dialogs.closeAll();
        e.preventDefault();
        return;
      }
      e.preventDefault();
      this.requestClose();
    }
  }

  /**
   * Экспортирует текущее изображение (с незакоммиченными оверлеями)
   * в this.export() — используется при закрытии с сохранением в режиме src/target.
   *
   * Возвращает Promise: requestClose() должен дождаться его завершения, прежде чем
   * закрыть редактор. Это критично для async-колбэков export (например, save-to-server
   * в photoEditContent) — без await редактор закроется до окончания загрузки.
   *
   * @returns {Promise<void>}
   */
  async #exportToTarget() {
    if (!this.export || !this.img) return;
    const ovTool = this.tools?.overlay;
    let canvas;
    if (ovTool && ovTool.overlays?.length > 0) {
      canvas = ovTool.renderToCanvas();
    } else {
      canvas = document.createElement('canvas');
      canvas.width  = this.img.naturalWidth;
      canvas.height = this.img.naturalHeight;
      canvas.getContext('2d').drawImage(this.img, 0, 0);
    }
    // Вызываем export(canvas) и ждём Promise если он возвращается.
    // Для синхронных export-колбэков (например, fileInput._exportToInput)
    // это эквивалентно немедленному resolve.
    const result = this.export(canvas);
    if (result instanceof Promise) await result;
  }

  /**
   * Показывает встроенный диалог подтверждения закрытия.
   *
   * @param {'save-or-discard'|'confirm-close'} mode
   *   'save-or-discard' — режим src/target: «Сохранить» (primary) / «Не сохранять»
   *   'confirm-close'   — автономный режим: «Нет» (primary) / «Да»
   *
   * @returns {Promise<'save'|'discard'|'yes'|'no'|'cancel'>}
   *   'cancel' — пользователь закрыл диалог без выбора (Escape / клик на оверлей)
   */
  #showCloseConfirmDialog(mode) {
    return new Promise(resolve => {
      this.dialogs?.closeAll();

      const overlay = document.createElement('div');
      overlay.className = 'pe-close-confirm-overlay';

      const box = document.createElement('div');
      box.className = 'pe-close-confirm';
      box.setAttribute('role', 'dialog');
      box.setAttribute('aria-modal', 'true');

      let message, primaryBtn, secondaryBtn;

      if (mode === 'save-or-discard') {
        message      = 'Редактор содержит изменённое изображение';
        primaryBtn   = { label: 'Сохранить',    value: 'save'    };
        secondaryBtn = { label: 'Не сохранять', value: 'discard' };
      } else {
        message      = 'Редактор содержит изменённое изображение. Уверены, что хотите закрыть?';
        primaryBtn   = { label: 'Нет', value: 'no'  };
        secondaryBtn = { label: 'Да',  value: 'yes' };
      }

      box.innerHTML = `
        <p class="pe-close-confirm__message">${message}</p>
        <div class="pe-close-confirm__actions">
          <button type="button" class="pe-close-confirm__btn pe-close-confirm__btn--secondary"
                  data-result="${secondaryBtn.value}">${secondaryBtn.label}</button>
          <button type="button" class="pe-close-confirm__btn pe-close-confirm__btn--primary"
                  data-result="${primaryBtn.value}">${primaryBtn.label}</button>
        </div>`;

      overlay.appendChild(box);
      this.container.appendChild(overlay);

      // Фокус на primary-кнопку — для работы с клавиатуры и доступности
      requestAnimationFrame(() => {
        box.querySelector('.pe-close-confirm__btn--primary')?.focus();
      });

      const finish = (value) => {
        // Снимаем Escape-перехватчик до удаления оверлея, чтобы избежать
        // двойного вызова finish() если удаление DOM вызовет события
        document.removeEventListener('keydown', onKey, true);
        overlay.remove();
        resolve(value);
      };

      box.addEventListener('click', e => {
        const btn = e.target.closest('[data-result]');
        if (btn) finish(btn.dataset.result);
      });

      // Клик на фоновый оверлей (вне диалога) = отмена
      overlay.addEventListener('click', e => {
        if (e.target === overlay) finish('cancel');
      });

      // Escape внутри диалога отменяет диалог, но не закрывает редактор.
      // capture: true + stopPropagation гарантирует, что внешний #onKeyDown
      // не получит это событие и не вызовет requestClose() повторно.
      const onKey = e => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          finish('cancel');
        }
      };
      document.addEventListener('keydown', onKey, true);
    });
  }


  // ── История undo/redo ─────────────────────────────────────────────────────

  /**
   * Делает снапшот текущего this.img в историю.
   *
   * Откладывается через requestIdleCallback (или setTimeout как fallback) —
   * это предотвращает конкуренцию с рендером сразу после apply() инструмента.
   * Использует OffscreenCanvas где поддерживается — перенос drawImage вне
   * main thread не блокирует UI при больших изображениях.
   *
   * Порядок выполнения гарантирован:
   *   setImage() → setTimeout(doCapture) → open() [microtask] → DOM рендер [rAF×2]
   *   → инструмент стартует → пользователь взаимодействует
   * setTimeout(0) всегда выполняется в следующей макро-задаче, поэтому снапшот
   * исходника гарантированно попадёт в историю до запуска любого инструмента.
   */
  #pushHistory() {
    if (!this.img) return;
    const img = this.img; // фиксируем ссылку — изображение может смениться до doCapture

    const doCapture = () => {
      // Если this.img сменился (новый commitImage), снапшот устарел — пропускаем.
      // Новый вызов #pushHistory уже запланировал свой doCapture.
      if (this.img !== img) return;

      if (typeof OffscreenCanvas !== 'undefined') {
        const osc = new OffscreenCanvas(img.naturalWidth, img.naturalHeight);
        osc.getContext('2d').drawImage(img, 0, 0);
        this.#history.push(osc).then(() => this.#updateHistoryUI());
      } else {
        const cv = document.createElement('canvas');
        cv.width  = img.naturalWidth;
        cv.height = img.naturalHeight;
        cv.getContext('2d').drawImage(img, 0, 0);
        this.#history.push(cv).then(() => this.#updateHistoryUI());
      }
    };

    // Используем setTimeout(0) вместо requestIdleCallback для первичного снапшота:
    // браузер может откладывать idle-callback надолго при активном рендере,
    // что приводило к гонке с toolOnOpen. setTimeout(0) — следующая макро-задача.
    if (typeof requestIdleCallback !== 'undefined') {
      this.#pendingHistoryRic = requestIdleCallback(doCapture, { timeout: 2000 });
    } else {
      this.#pendingHistoryRic = setTimeout(doCapture, 0);
    }
  }

  async #undo() {
    if (!this.#history.canUndo) return;
    // Приостанавливаем активный инструмент — он мог держать canvas-оверлей
    this.activeTool?.suspend?.();
    const img = await this.#history.undo();
    if (img) {
      this.img = img;
      if (this.imgElement) { this.imgElement.src = img.src; this.#updateInfo(); }
      // Если откатились до самого начала истории — изображение вернулось к исходному.
      // Снимаем флаг «несохранённые изменения»: диалог при закрытии больше не нужен.
      if (!this.#history.canUndo) {
        this.#isDirty = false;
      }
    }
    this.#updateHistoryUI();
  }

  async #redo() {
    if (!this.#history.canRedo) return;
    this.activeTool?.suspend?.();
    const img = await this.#history.redo();
    if (img) {
      this.img = img;
      if (this.imgElement) { this.imgElement.src = img.src; this.#updateInfo(); }
      // Вернулись к изменённому состоянию — при закрытии снова нужен диалог
      this.#isDirty = true;
    }
    this.#updateHistoryUI();
  }

  /** Синхронизирует состояние кнопок undo/redo и бейдж с глубиной истории. */
  #updateHistoryUI() {
    if (!this.container) return;
    const s       = this.#history._snapshot();
    const undoBtn = this.container.querySelector('[data-action="undo"]');
    const redoBtn = this.container.querySelector('[data-action="redo"]');
    const badge   = this.container.querySelector('.pe-history-badge');

    if (undoBtn) undoBtn.disabled = !s.canUndo;
    if (redoBtn) redoBtn.disabled = !s.canRedo;

    if (badge) {
      badge.textContent  = s.depth > 0 ? `${s.depth}/${s.maxStates}` : '';
      badge.title        = s.depth > 0
        ? `История: ${s.depth} из ${s.total} состояний · ${s.totalSizeMb} МБ`
        : '';
      badge.dataset.warn = s.total >= s.maxStates ? '1' : '';
    }
  }

  #updateInfo() {
    const info = this.container?.querySelector('.photoeditor__info');
    if (!info) return;
    const w = this.imgElement?.naturalWidth  || this.img?.naturalWidth  || 0;
    const h = this.imgElement?.naturalHeight || this.img?.naturalHeight || 0;
    info.textContent = (w && h) ? `${w}×${h}` : '';
  }


  // ── Статические приватные утилиты ─────────────────────────────────────────

  /**
   * Откладывает колбэк на два кадра анимации.
   * Гарантирует что браузер завершил layout и paint до запуска логики
   * (измерения размеров, старт инструментов, вызов afterOpen).
   */
  static #afterRender(cb) {
    requestAnimationFrame(() => requestAnimationFrame(cb));
  }

  /**
   * Подключает CSS-файл если нужный стиль ещё не применён.
   * Проверяет фактическое computed-значение свойства — если CSS уже применён
   * другим способом (inline, другой файл), повторная загрузка не происходит.
   *
   * @param {string} sel   CSS-селектор элемента для проверки
   * @param {string} prop  CSS-свойство для проверки
   * @param {string} val   Ожидаемое значение
   * @param {string} url   URL файла стилей для подключения
   */
  static #ensureCSS(sel, prop, val, url) {
    const el = document.querySelector(sel);
    if (!el) return;
    if (window.getComputedStyle(el).getPropertyValue(prop).trim() === val) return;
    if (document.querySelector(`link[href="${url}"]`)) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = url;
    document.head.appendChild(l);
  }
}
