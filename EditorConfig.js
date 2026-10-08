/**
 * EditorConfig v1.0
 *
 * Централизованная конфигурация редактора и инструментов.
 * Все настройки по умолчанию хранятся здесь и могут быть
 * переопределены через конструктор PhotoEditor(opts).
 */

export const EditorConfig = {

  // ── Версия редактора ───────────────────────────────────────────────────────
  VERSION: '3.7.1',

  // ── Настройки редактора ───────────────────────────────────────────────────
  editor: {
    /** Путь к папке с файлами PhotoEditor на сервере */
    photoeditorPath: '/jscript/photoeditor2/',
    /** CSS-класс добавляемый на body при открытом редакторе */
    bodyClass: 'photoeditor__body',
    /** z-index контейнера редактора */
    zIndex: '117',
    /** URL иконочного шрифта */
    oinfoFontUrl: '/main/css/fonts/oinfo/style.css',
    /** Инструменты включённые по умолчанию */
    defaultTools: ['heal', 'crop', 'overlay', 'draw', 'mask', 'adjust'],
  },

  // ── Инструменты (реестр) ──────────────────────────────────────────────────
  tools: {
    heal: {
      id: 'heal',
      label: 'Ретушь',
      icon: 'icon-heal',
      ready: true,
    },
    crop: {
      id: 'crop',
      label: 'Кадр',
      icon: 'icon-crop',
      ready: true,
    },
    overlay: {
      id: 'overlay',
      label: 'Оверлей',
      icon: 'icon-layers',
      ready: true,
    },
    draw: {
      id: 'draw',
      label: 'Рисунок',
      icon: 'icon-pencil',
      ready: true,
    },
    mask: {
      id: 'mask',
      label: 'Маска',
      icon: 'icon-pixelate',
      ready: true,
    },
    adjust: {
      id: 'adjust',
      label: 'Свет',
      icon: 'icon-filter',
      ready: true,
    },
    filters: {
      id: 'filters',
      label: 'Фильтры',
      icon: 'icon-equalizer',
      ready: false,
    },
    retouch: {
      id: 'retouch',
      label: 'Ретушь',
      icon: 'icon-wand',
      ready: false,
    },
  },

  // ── Настройки HealTool ────────────────────────────────────────────────────
  heal: {
    /** Радиус кисти по умолчанию (px в координатах display) */
    defaultBrushSize: 20,
    /** Минимальный радиус */
    minBrushSize: 2,
    /** Максимальный радиус */
    maxBrushSize: 150,
    /** Шаг изменения через [ / ] */
    brushSizeStep: 2,

    /**
     * Доля глубины маски (BFS-расстояния от края), на которой
     * действует плавная цветокоррекция.
     * 0.4 → поправка убывает к нулю после 40% глубины; центр — чистая текстура.
     */
    featherFraction: 0.4,

    /**
     * Множитель для расчёта радиуса поиска донорского патча.
     * searchRadius = estimatedComponentRadius × defaultSearchMult
     * Больше → ищет дальше; полезно когда рядом с дефектом нет чистого участка.
     */
    defaultSearchMult: 4,
    minSearchMult: 1.5,
    maxSearchMult: 12,

    /**
     * Задержка перед запуском предпросмотра после последнего мазка (мс).
     * Preview не вычисляется пока пользователь рисует — только после паузы.
     */
    previewDebounceMs: 400,

    /** Ключ localStorage */
    storageKey: 'pe_heal_settings',
  },

  // ── HistoryManager ─────────────────────────────────────────────────────────
  history: {
    /** Максимум снапшотов на сессию. При превышении — удаляется самый старый. */
    maxStates: 20,
    /**
     * Через сколько мс записи чужих сессий считаются брошенными и удаляются
     * при следующем открытии редактора (вкладка закрылась без destroy()).
     */
    staleSessionMaxAgeMs: 24 * 60 * 60 * 1000,
  },

  // ── Настройки CropTool ────────────────────────────────────────────────────
  crop: {
    cropColor: 'red',
    resizeHandleSize: 12,
    showGoldenRatio: true,
    /** Смещение ручки вращения над верхней гранью рамки */
    rotateHandleOffset: 30,
    /** Соотношения сторон доступные в панели */
    ratios: [
      { label: 'Своб.',  value: null },
      { label: '16 : 9', value: 16 / 9 },
      { label: '4 : 3',  value: 4 / 3 },
      { label: '1 : 1',  value: 1 },
      { label: '3 : 4',  value: 3 / 4 },
      { label: '9 : 16', value: 9 / 16 },
    ],
  },

  // ── Настройки OverlayTool ─────────────────────────────────────────────────
  overlay: {
    handleRadius: 8,
    minSize: 24,
    rotateOffset: 36,
    maxOverlayFrac: 0.30,
    historySize: 5,
    historyKey: 'pe_overlay_history',
    textSettingsKey: 'pe_overlay_text_settings',
    /**
     * Пресеты оверлеев — предустановленные наборы для маркировки изображений.
     * Задаются при настройке редактора под конкретный проект.
     *
     * Каждый пресет: { id, label, items[] }
     * Каждый item:
     *   type:        'text' | 'image'
     *   --- для text ---
     *   text, fontFamily, fontSize, fontWeight, color, strokeColor, strokeWidth
     *   --- для image ---
     *   src:         URL изображения (абсолютный или относительный)
     *   --- позиция (все в долях 0..1 от размеров canvas) ---
     *   xPct:        центр по X (0 = левый край, 1 = правый)
     *   yPct:        центр по Y (0 = верх, 1 = низ)
     *   wPct:        ширина как доля ширины canvas
     *   hPct:        высота (опционально; по умолчанию — из пропорций изображения)
     *   opacity:     0..1
     *
     * Пример настройки для конкретного проекта:
     *
     *   EditorConfig.overlay.presets = [
     *     {
     *       id: 'logo-br', label: 'Логотип',
     *       items: [{ type:'image', src:'/img/logo.png', xPct:0.85, yPct:0.9, wPct:0.18, opacity:0.85 }]
     *     },
     *     {
     *       id: 'watermark', label: 'Водяной знак',
     *       items: [{ type:'text', text:'© Компания', fontFamily:'serif', fontSize:48,
     *                 fontWeight:'bold', color:'#ffffff', strokeColor:'#000', strokeWidth:2,
     *                 xPct:0.5, yPct:0.5, wPct:0.4, opacity:0.3 }]
     *     },
     *   ];
     */
    /**
     * Пресеты ниже — проектные (oinfo.ru). Для других проектов передавайте свои через
     * new PhotoEditor({ overlayOptions: { presets: [...] } }) — опция имеет приоритет.
     * Пустой список ([]) отключает блок «Пресеты».
     */
		presets: [
				{id: 'oinfo', label: 'ОИНФО', items: [{ type:'image', src:'/images/overlay/ОИНФО-shadow.png', xPct:0.5, yPct:0.7, wPct:0.25, opacity:0.7 }]},
				{id: 'oinfo.ru', label: 'oinfo.ru', items: [{ type:'image', src:'/images/overlay/oinfo.ru-shadow.png', xPct:0.5, yPct:0.7, wPct:0.25, opacity:0.7 }]},
				{id: 'max', label: 'MAX', items: [{ type:'image', src:'/images/overlay/max.ru-oinfo_news-shadow.png', xPct:0.5, yPct:0.7, wPct:0.25, opacity:0.7 }]},
				{id: 'odinmam', label: 'odinmam', items: [{ type:'image', src:'/images/overlay/t.me-odinmam-shadow.png', xPct:0.5, yPct:0.7, wPct:0.25, opacity:0.7 }]},
				//{id: 'odintsovoBot', label: 'odintsovoBot', items: [{ type:'image', src:'/images/overlay/t.me-odintsovoBot-shadow.png', xPct:0.5, yPct:0.7, wPct:0.25, opacity:0.7 }]},
				{id: 't.me-oinfo_news', label: 't.me-oinfo_news', items: [{ type:'image', src:'/images/overlay/t.me-oinfo_news-shadow.png', xPct:0.5, yPct:0.7, wPct:0.25, opacity:0.7 }]},
				{id: 't.me-oinfo_chat', label: 't.me-oinfo_chat', items: [{ type:'image', src:'/images/overlay/t.me-oinfo_chat-shadow.png', xPct:0.5, yPct:0.7, wPct:0.25, opacity:0.7 }]},
				{id: 'oib', label: 'ОИ чёрный', items: [{ type:'image', src:'/images/overlay/08_oi-black.png', xPct:0.5, yPct:0.7, wPct:0.1, opacity:0.7 }]},
				{id: 'oiw', label: 'ОИ белый', items: [{ type:'image', src:'/images/overlay/08_oi-white.png', xPct:0.5, yPct:0.7, wPct:0.1, opacity:0.7 }]},
				{id: 'oic', label: 'ОИ цветной', items: [{ type:'image', src:'/images/overlay/08_oi-color.png', xPct:0.5, yPct:0.7, wPct:0.1, opacity:0.7 }]},
				{id: 't.me-odiauto-shadow.png', label: 't.me-odiauto', items: [{ type:'image', src:'/images/overlay/t.me-odiauto-shadow.png', xPct:0.5, yPct:0.7, wPct:0.18, opacity:0.75 }]},
				{id: 'autow', label: 'Авто белый', items: [{ type:'image', src:'/images/overlay/03_Автогруппа-белый.png', xPct:0.5, yPct:0.7, wPct:0.12, opacity:0.7 }]},
				{id: 'autob', label: 'Авто чёрный', items: [{ type:'image', src:'/images/overlay/03_Автогруппа-черный.png', xPct:0.5, yPct:0.7, wPct:0.12, opacity:0.7 }]}
			]

  },

  // ── Настройки DrawTool ────────────────────────────────────────────────────
  draw: {
    /** Цвет линии по умолчанию */
    defaultColor: '#e53935',
    /** Толщина линии по умолчанию */
    defaultWidth: 3,
    /** Минимальная толщина */
    minWidth: 1,
    /** Максимальная толщина */
    maxWidth: 50,
    /** Прозрачность по умолчанию (0–1) */
    defaultOpacity: 1,
    /** Радиус ручек управления наброском */
    handleRadius: 8,
    /** Минимальный размер наброска */
    minSize: 20,
    /** Отступ ручки вращения */
    rotateOffset: 36,
    /** Ключ localStorage для сохранения последнего цвета */
    colorStorageKey: 'pe_draw_color',
    /** Ключ localStorage для сохранения последней толщины */
    widthStorageKey: 'pe_draw_width',
    shapeRecognitionHoldMs: 2000,
    closedShapeThreshold: 0.25,
    minPointsForRecognition: 8,
  },

  // ── Настройки AdjustTool ─────────────────────────────────────────────────
  adjust: {
    /** Размер превью по большей стороне (px) — баланс скорость/качество */
    previewMaxSize: 600,
    /** Значения параметров по умолчанию (все нули = без изменений) */
    defaults: {
      exposure:    0,
      contrast:    0,
      shadows:     0,
      highlights:  0,
      saturation:  0,
      vibrance:    0,
      temperature: 0,
      hue:         0,
    },
    /** Описание ползунков — порядок, метки, диапазоны */
    sliders: [
      { param: 'exposure',    label: 'Выдержка',     hint: 'Общее осветление / затемнение',               min: -100, max: 100, step: 1 },
      { param: 'contrast',    label: 'Контраст',     hint: 'Усиление или ослабление контраста',            min: -100, max: 100, step: 1 },
      { param: 'shadows',     label: 'Тени',          hint: 'Поднять или опустить тёмные области',          min: -100, max: 100, step: 1 },
      { param: 'highlights',  label: 'Свет',          hint: 'Поднять или опустить светлые области',         min: -100, max: 100, step: 1 },
      { param: 'saturation',  label: 'Насыщенность',  hint: 'Насыщенность всех цветов',                     min: -100, max: 100, step: 1 },
      { param: 'vibrance',    label: 'Сочность',      hint: 'Мягкое усиление ненасыщенных цветов',          min: -100, max: 100, step: 1 },
      { param: 'temperature', label: 'Теплота',       hint: 'Тёплый (+) / холодный (−) оттенок',           min: -100, max: 100, step: 1 },
      { param: 'hue',         label: 'Тон',           hint: 'Сдвиг цветового тона по кругу (−180..+180)',   min: -180, max: 180, step: 1 },
    ],
  },

  // ── Настройки MaskTool ────────────────────────────────────────────────────
  mask: {
    /** Размер квадратика пикселизации по умолчанию (px в координатах canvas) */
    defaultBlockSize: 12,
    /** Минимальный размер блока */
    minBlockSize: 4,
    /** Максимальный размер блока */
    maxBlockSize: 64,
    /** Цвет рамки при создании новой области */
    selectionColor: 'rgba(60,143,224,0.9)',
  },

  // ── Настройки ExportPanel ─────────────────────────────────────────────────
  export: {
    defaultJpegQuality: 85,
    fileNameSuffix: '-edited',
    showSaveDialog: true,
    /** Ключ localStorage для сохранения последнего выбранного качества JPEG */
    qualityStorageKey: 'pe_export_quality',
  },

  // ── Вспомогательные методы ────────────────────────────────────────────────

  /**
   * Читает сохранённое пользователем качество JPEG (1–100) из localStorage.
   * Используется ExportPanel и FileInput, чтобы оба пути экспорта давали
   * одинаковый результат. Невалидное значение → дефолт.
   * @returns {number}
   */
  loadExportQuality() {
    try {
      const v = Number(localStorage.getItem(this.export.qualityStorageKey));
      if (Number.isFinite(v) && v >= 1 && v <= 100) return Math.round(v);
    } catch { /* localStorage недоступен */ }
    return this.export.defaultJpegQuality;
  },

  /** Сохраняет качество JPEG (1–100). Ошибки localStorage игнорируются. */
  saveExportQuality(v) {
    try { localStorage.setItem(this.export.qualityStorageKey, String(v)); } catch { /* ignore */ }
  },

  /**
   * Очищает все сохранённые данные фоторедактора из localStorage.
   * Вызывается из диалога «О редакторе» → кнопка «Сбросить настройки».
   */
  clearStoredData() {
    const keys = [
      this.overlay.historyKey,
      this.overlay.textSettingsKey,
      this.draw.colorStorageKey,
      this.draw.widthStorageKey,
      this.export.qualityStorageKey,
      this.heal.storageKey,
    ];
    let cleared = 0;
    for (const k of keys) {
      if (localStorage.getItem(k) !== null) { localStorage.removeItem(k); cleared++; }
    }
    return cleared;
  },

  /**
   * Формирует имя файла для сохранения.
   * Приоритет: оригинальное имя → дата/время.
   *
   * @param {string|null} originalName  — исходное имя файла (из File.name или
   *                                      сохранённое в photoEditor.originalFileName)
   * @param {'jpeg'|'png'|'webp'} format
   * @returns {string}
   */
  buildExportFileName(originalName, format) {
    const extMap = { jpeg: 'jpg', jpg: 'jpg', png: 'png', webp: 'webp' };
    const ext = extMap[format] ?? format;

    if (originalName) {
      // Заменяем расширение на новый формат
      return originalName.replace(/\.[^/.]+$/, '') + '.' + ext;
    }

    // Генерируем имя по дате/времени: YYYY-MM-DD_HH-MM
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const datePart = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
    const timePart = `${pad(now.getHours())}-${pad(now.getMinutes())}`;
    return `${datePart}_${timePart}.${ext}`;
  },
};
