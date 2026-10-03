# PhotoEditor v3.6

Модульный фоторедактор — Mobile First, vanilla JS (ES Modules), без runtime-зависимостей.
Работает как виджет внутри страницы **и** как самостоятельное приложение (`index.html`).

```
🩹 Ретушь · ✂ Кадр · ⊕ Оверлеи · ✎ Рисунок · ▦ Маска · ☀ Свет · ⬆ Импорт · ⬇ Экспорт · Undo/Redo · Touch-ready
```

> Идёт рефакторинг: см. `CHANGELOG.md`. Аудит и план — в описании PR.

---

## Файловая структура

```
photoeditor/
├── PhotoEditor.js        Главный класс: DOM, тулбар, lifecycle, undo/redo, диалог закрытия
├── EditorConfig.js       Централизованная конфигурация и реестр инструментов
├── HistoryManager.js     Undo/redo на IndexedDB (WebP-снапшоты)
├── DialogManager.js      Панели инструментов и утилит: группы, позиционирование
├── utils.js              Общие хелперы (isEditableTarget, escapeHtml, safeCssColor)
│
├── HealTool.js           Ретушь — восстанавливающая кисть
├── CropTool.js           Кадрирование с поворотом рамки и изображения
├── OverlayTool.js        Оверлеи (TextOverlay, ImageOverlay), история, пресеты
├── DrawTool.js           Рисунок: свободные мазки, распознавание фигур
├── MaskTool.js           Пикселизация областей
├── AdjustTool.js         Экспозиция / контраст / тени / свет / насыщенность / тон
│
├── ExportPanel.js        JPG/PNG → файл или буфер обмена
├── ImportPanel.js        Загрузка из буфера обмена / диска / Ctrl+V
├── FileInput.js          Связь с <input type="file"> (режим src/target)
│
├── index.html            Самостоятельное приложение (пустой холст 1600×900)
├── demo.html             Демо-страница с загрузкой файла
│
├── scss/                 Исходники стилей → layout.css (npm run css)
├── layout.css            Скомпилированные стили (коммитятся; CI проверяет актуальность)
│
├── tests/unit/           Vitest (jsdom + fake-indexeddb)
├── tests/e2e/            Playwright: smoke- и регрессионные тесты
└── .github/workflows/    CI: lint → css:check → unit → e2e
```

## Разработка

```bash
npm install
npm run dev          # Vite dev-сервер → http://localhost:5173/index.html
npm run css          # scss/ → layout.css   (npm run css:watch — в режиме слежения)
npm run lint         # ESLint
npm test             # unit-тесты (Vitest)
npm run test:e2e     # e2e (Playwright; первый раз: npx playwright install chromium)
npm run check        # всё вместе
```

Файлы подключаются без сборки — достаточно скопировать `*.js` и `layout.css` на сервер.

---

## Быстрый старт

### Самостоятельное приложение

`index.html` — редактор занимает весь экран сразу при загрузке.
Изображение по умолчанию — пустой белый холст 1600×900.
Загрузить своё — через кнопку **«Импорт»** на тулбаре (файл или буфер обмена).
Кнопка «Закрыть» / `Escape` перезагружает страницу, возвращая чистый холст.

```bash
npm run dev          # или любой статический сервер: npx serve .
# открыть http://localhost:5173/index.html
```

**Минимальный код — открыть редактор с конкретным изображением:**

```html
<link rel="stylesheet" href="layout.css">
<script type="module">
  import { PhotoEditor } from './PhotoEditor.js';

  const editor = new PhotoEditor({
    tools:      ['crop', 'overlay'],
    showImport: true,
    showExport: true,
  });

  editor.afterClose = () => location.reload();

  await editor.setImage('/path/to/photo.jpg');
  editor.open();
</script>
```

> **Важно:** `editor.open()` требует, чтобы `editor.img` был загружен.
> Всегда вызывайте `await editor.setImage(src)` перед `editor.open()`.

---

### Виджет внутри страницы

```html
<link rel="stylesheet" href="layout.css">
<input type="file" id="photo" accept="image/*">

<script type="module">
  import { PhotoEditor } from './PhotoEditor.js';

  const editor = new PhotoEditor({
    tools:       ['crop', 'overlay'],
    toolOnOpen:  'crop',
    showImport:  true,
    showExport:  true,
    cropOptions: { aspectRatio: '16:9' },
  });
  editor.bindToFileInput(document.getElementById('photo'));
</script>
```

### jQuery-плагин

> `fileInput.plugin.js` живёт в CMS-проекте, а не в этом репозитории.

```html
<div class="image-input">
  <input type="file" accept="image/*"
         data-photoeditor='{"tool":"crop","aspectRatio":"4:3"}'>
</div>

<script src="jquery.js"></script>
<script src="fileInput.plugin.js"></script>
<script>
  $('.image-input').fileInput({
    photoeditorPath: '/jscript/photoeditor/',
    tools:           ['crop', 'overlay'],
    tool:            'overlay',
    showImport:      true,
    showExport:      true,
    historySize:     5,
  });

  $('.image-input')
    .on('fileinput:ready',  (e, editor) => console.log('готов', editor))
    .on('fileinput:change', (e, file)   => console.log('файл', file?.name));
</script>
```

---

## Архитектура

### Тулбар (Mobile First)

Тулбар расположен **внизу экрана** (`position: fixed; bottom: 0`) — в зоне большого пальца. Ключевые решения:

- Минимальная касательная зона кнопок **48 × 48 px** (WCAG 2.5.5)
- Иконки — иконочный шрифт oinfo (`EditorConfig.editor.oinfoFontUrl`), классы `icon-*`; подключается автоматически при `open()`
- Активная кнопка: синяя подсветка + полоска-индикатор сверху
- Повторный клик по активной кнопке → открывает/скрывает её панель настроек
- Кнопки Import / Export открывают float-панели, всплывающие над тулбаром
- На экранах < 360 px — подписи скрываются, остаются только иконки
- `safe-area-inset-bottom` для iPhone X+

### Защита от null imgElement

Ключевое исправление v3.1: `tool.start()` выполняется **только** после `imgElement.onload`:

```
PhotoEditor.open()
  imgElement.addEventListener('load', { once: true }, () =>
    tool.start()    ← вызывается только когда img загружен
  )
  imgElement.src = img.src
```

`OverlayTool.start()` имеет собственную защиту: если `naturalWidth === 0`, ставит `addEventListener('load', retry)` и выходит без краша.

### Цепочка экспорта (кроп + оверлеи)

```
CropTool.crop()
  → рендерит результат в canvas
  → photoEditor.img = new Image(dataURL)   ← обновляет источник!
  → photoEditor.export(canvas)             ← FileInput / кастомный

ExportPanel._getResultCanvas()
  → pe.img                                 ← уже обрезанное изображение
  → OverlayTool.renderToCanvas()           ← рисует оверлеи поверх
```

Таким образом **кроп + оверлеи** всегда попадают в итоговый экспорт независимо от того, какой путь используется.

### Реестр инструментов

Реестр живёт в `EditorConfig.tools` (`TOOL_REGISTRY` — его реэкспорт):

```js
tools: {
  heal:    { id:'heal',    label:'Ретушь',  icon:'icon-heal',     ready:true },
  crop:    { id:'crop',    label:'Кадр',    icon:'icon-crop',     ready:true },
  overlay: { id:'overlay', label:'Оверлей', icon:'icon-layers',   ready:true },
  draw:    { id:'draw',    label:'Рисунок', icon:'icon-pencil',   ready:true },
  mask:    { id:'mask',    label:'Маска',   icon:'icon-pixelate', ready:true },
  adjust:  { id:'adjust',  label:'Свет',    icon:'icon-filter',   ready:true },
}
```

Порядок кнопок задаёт опция `tools` (по умолчанию `EditorConfig.editor.defaultTools`).

---

## PhotoEditor — опции

| Опция | Тип | По умолчанию | Описание |
|---|---|---|---|
| `tools` | `string[]` | все шесть | Видимые инструменты, порядок = порядок кнопок |
| `toolOnOpen` | `string\|null` | `null` | Авто-старт инструмента при открытии |
| `showImport` | `boolean` | `true` | Показать кнопку / панель импорта |
| `showExport` | `boolean` | `true` | Показать кнопку / панель экспорта |
| `cropOptions` | `object` | `{}` | `{ aspectRatio: '16:9' }` |
| `overlayOptions` | `object` | `{}` | `{ historySize: 5 }` |
| `blankCanvas` | `object` | `{ width:800, height:600, color:'#fff' }` | Пустой холст, если `open()` вызван без изображения |

### Методы

```js
editor.bindToFileInput(el)  // привязать к <input type="file">
editor.setImage(src)        // загрузить изображение (string|HTMLImageElement) → Promise
editor.open()               // открыть редактор
editor.requestClose()       // закрыть с диалогом, если есть несохранённые изменения
editor.close()              // закрыть немедленно (системные сценарии)
editor.commitImage(img)     // зафиксировать новое изображение (история, dirty-флаг)
editor.notifyExportDone()   // сообщить, что пользователь экспортировал результат
editor.syncToolButtons()    // обновить is-active на кнопках тулбара

// Кастомный экспорт:
editor.export = (canvas) => {
  document.getElementById('result').src = canvas.toDataURL('image/jpeg', 0.9);
};
```

### Callbacks

```js
editor.beforeOpen  = (ed) => {};
editor.afterOpen   = (ed) => {};
editor.beforeClose = (ed) => {};
editor.afterClose  = (ed) => {};
```

---

## Инструменты

### CropTool

```js
const crop = editor.tools.crop;
crop.setAspectRatio('16:9'); // зафиксировать пропорции
crop.resetAspectRatio();     // снять фиксацию
crop.showGoldenRatio = false; // скрыть крестики золотого сечения
crop.cropColor = '#00ff88';  // цвет рамки кадра
```

| Действие | Мышь/тач | Клавиатура |
|---|---|---|
| Переместить | drag внутри | `←↑↓→` (Shift ×10) |
| Изменить размер | drag по ручкам | — |
| Весь кадр | двойной клик | — |
| Применить | кнопка ✂ (или Enter активной кнопки) | `Enter` |
| Отменить | — | `Escape` |

После применения кропа `photoEditor.img` обновляется — все последующие операции (оверлеи, экспорт) работают с обрезанным изображением.

---

### OverlayTool

#### Программное добавление

```js
const ot = editor.tools.overlay;

// Текст (начальный размер ≤ 30% холста, центрирован)
ot.addTextOverlay({
  text:        'Hello',
  font:        'bold 64px sans-serif',
  color:       '#ffffff',
  strokeColor: '#000000',
  strokeWidth: 3,          // 0 = без обводки
  opacity:     0.9,
  rotation:    0,          // радианы
  lockAspect:  true,       // сохранять пропорции при resize
});

// Изображение (масштабируется до ≤ 30% холста)
ot.addImageOverlay(imgElement, { opacity: 0.8 });

// Экспорт в натуральном разрешении (поверх текущего pe.img)
const canvas = ot.renderToCanvas();
```

#### Параметры TextOverlay

| Параметр | Тип | Умолчание | Описание |
|---|---|---|---|
| `text` | string | `'Текст'` | Содержимое |
| `font` | string | `'bold 48px sans-serif'` | CSS font |
| `color` | string | `'#ffffff'` | Цвет заливки текста |
| `strokeColor` | string | `'#000000'` | Цвет обводки |
| `strokeWidth` | number | `2` | Толщина обводки (0 = нет) |
| `opacity` | number | `1` | Прозрачность 0–1 |
| `rotation` | number | `0` | Угол в радианах |
| `lockAspect` | boolean | `true` | Блокировать пропорции при resize |

#### Управление

| Действие | Как |
|---|---|
| Выбрать | клик |
| Переместить | drag по телу |
| Масштаб | drag по синим угловым ручкам |
| Поворот | drag по жёлтой ручке |
| Удалить | `Delete`/`Backspace` или кнопка панели |
| Применить | «✓ Применить» → вызывает `editor.export` |

#### История оверлеев

Последние N наборов сохраняются в `localStorage['pe_overlay_history']` при нажатии «Применить». Карточки появляются внизу панели — один клик «Применить» восстанавливает набор на новое фото.

```js
// Размер истории:
new PhotoEditor({ overlayOptions: { historySize: 10 } });
```

---

### ExportPanel

Открывается кнопкой «⬇ Экспорт» в тулбаре, всплывает над ним справа.

| Кнопка | Действие |
|---|---|
| 📋 Буфер | Скопировать итог в системный буфер (всегда PNG — Clipboard API не принимает JPEG) |
| ⬇ JPG | Скачать JPG-файл |
| ⬇ PNG | Скачать PNG-24 |

Ползунок **Качество JPG** (1–100, по умолчанию 85).

Итоговый canvas включает: обрезку (если был кроп) + все оверлеи (если есть).

> Clipboard API требует HTTPS или localhost.

---

### ImportPanel

Открывается кнопкой «⬆ Импорт» в тулбаре, всплывает слева.

| Кнопка | Действие |
|---|---|
| 📋 Буфер | Clipboard API → загрузить изображение |
| 📂 Файл | File picker |

Также: **Ctrl+V** прямо в открытом редакторе.

---

## jQuery-плагин — опции

| Опция | Тип | Умолчание | Описание |
|---|---|---|---|
| `photoeditorPath` | string | `'/jscript/photoeditor/'` | Путь к модулям |
| `tools` | string[] | `['crop','overlay']` | Инструменты |
| `tool` | string | `null` | Авто-старт инструмента |
| `aspectRatio` | string | `null` | Пропорции кропа |
| `showImport` | boolean | `true` | Панель импорта |
| `showExport` | boolean | `true` | Панель экспорта |
| `historySize` | number | `5` | Размер истории оверлеев |

```html
<!-- data-атрибут переопределяет JS-опции: -->
<input type="file" data-photoeditor='{"tool":"overlay","aspectRatio":"1:1"}'>
```

---

## Стили (SCSS)

```bash
npm install -g sass
sass layout.scss layout.css                     # разработка
sass layout.scss layout.css --style=compressed  # production
sass --watch layout.scss:layout.css             # watch
```

### Структура SCSS

| Файл | Содержимое |
|---|---|
| `layout.scss` | Точка входа — собирает все части |
| `_variables.scss` | Токены: цвета, размеры, отступы |
| `_mixins.scss` | Вспомогательные миксины |
| `_workspace.scss` | `.photoeditor__container`, img-область, анимации |
| `_toolbar.scss` | Нижний тулбар `.pe-toolbar` |
| `_buttons.scss` | Кнопки `.photoeditor__button` |
| `_panels.scss` | Панели инструментов: export, import, crop, overlay |
| `_plugins.scss` | Позиционирование панелей плагинов (Plugin API) |

### CSS-переменные

```css
.photoeditor__container {
  --pe-text:       #fff;
  --pe-bg:         rgba(0,0,0,.92);
  --pe-border:     rgba(255,255,255,.15);
  --pe-btn:        #3a3a52;
  --pe-btn-hover:  #4e4e6e;
  --pe-btn-active: #2563b8;
  --pe-accent:     #4a9eff;
}
```

---

## Тесты

```bash
npm test                          # unit (Vitest + jsdom + fake-indexeddb)
npm run test:watch
npm run test:e2e                  # Playwright (Chromium)
```

- **unit** — `EditorConfig` (имена файлов, очистка localStorage), `AdjustTool` (цветовая математика), `HistoryManager` (очередь push, лимит, destroy), `utils`.
- **e2e** (`tests/e2e/fixture.html` экспортирует `window.editor`) — открытие, старт/отмена каждого инструмента, переключение, undo/redo, диалог закрытия, регрессионные сценарии из аудита (Escape в инструментах, клавиши в текстовом поле, suspend кропа при открытии панелей, авто-экспорт).

---

## Plugin API — добавление инструментов

### Концепция

Каждый инструмент — **обычный ES-модуль** с фиксированным контрактом.
Редактор не знает о конкретных инструментах ничего, кроме имён методов.
Плагин получает ссылку на `PhotoEditor` и может использовать весь его публичный API.

Регистрация в `PhotoEditor.js` сводится к **3 строкам** — импорт, запись в `TOOL_REGISTRY`,
создание экземпляра в `_allTools`. Кнопка на тулбаре и маршрутизация кликов —
автоматически.

---

### Контракт плагина

```js
export class MyTool {
  // ── Флаги состояния (обязательны — читаются редактором) ──────────────────
  isActive    = false;   // инструмент сейчас активен
  isSuspended = false;   // инструмент приостановлен (открыта другая панель)

  constructor(photoEditor) {
    this.pe = photoEditor; // ссылка на редактор
  }

  // ── Обязательные методы ──────────────────────────────────────────────────

  /** Вызывается при нажатии кнопки инструмента. */
  start() {
    this.isActive = true;
    this.pe.activeTool = this;
    this.pe.syncToolButtons?.();
    // Монтируем canvas, панель и т.д.
  }

  /** Отмена без записи результата (Escape, кнопка «Отмена»). */
  cancel() {
    // Демонтируем canvas, панель; this.pe.activeTool = null; syncToolButtons()
  }

  /** Cleanup при закрытии редактора (вызывается всегда, даже если не активен). */
  destroy() {
    this.cancel();
  }

  // ── Необязательные методы ────────────────────────────────────────────────

  /** Кнопка «Применить». Результат фиксируется ТОЛЬКО через this.pe.commitImage(img). */
  apply() {}

  /**
   * Обработка клавиш пока инструмент активен. Редактор сам пропускает события
   * из текстовых полей и уже обработанные (e.defaultPrevented).
   * @returns {boolean} true = событие перехвачено (preventDefault вызовет редактор)
   */
  onKeyDown(e) { return false; }

  /** Повторный клик по уже активной кнопке → показать/скрыть настройки. */
  openSettings() {}

  /** Инструмент уходит в фон (открылась панель импорт/экспорт, выбран другой инструмент). */
  suspend() {
    this.isSuspended = true;
    this.isActive    = false;
    this.pe.syncToolButtons?.();
  }
  // Возврат из фона — повторный start(): редактор вызывает его, если isSuspended === true.
}
```

---

### Регистрация в PhotoEditor.js (3 строки)

```js
// 1. Импорт (вверху файла)
import { MyTool } from './MyTool.js';

// 2. EditorConfig.js → tools — иконки из шрифта oinfo (icon-*)
tools: {
  // ...
  myTool:  { id:'myTool',  label:'Мой',     icon:'icon-pencil',  ready:true  }, // ← добавить
},

// 3. В конструкторе PhotoEditor, в _allTools:
this._allTools = {
  crop:    new CropTool(this),
  overlay: new OverlayTool(this, ...),
  myTool:  new MyTool(this),   // ← добавить; кнопка появится автоматически
};
```

**Активация через опции:**
```js
new PhotoEditor({ tools: ['crop', 'overlay', 'myTool'] });
```

---

### Пример плагина

Самый компактный реальный пример контракта — `AdjustTool.js` (~550 строк):
панель со слайдерами, превью на canvas, `apply()` через `commitImage`, полный lifecycle.

### SCSS для плагинов (_plugins.scss)

Если плагин управляет позицией своей панели через CSS (а не через JS),
объявите её в `_plugins.scss` (файл уже подключён в `layout.scss`):

```scss
// _plugins.scss

// Панель по центру над тулбаром:
.pe-panel--watermark {
  @include plugin-panel-center(22em);
}

// Панель справа:
.pe-panel--my-sidebar {
  @include plugin-panel-right(14em);
}
```

Доступные миксины позиционирования:

| Миксин | Позиция |
|---|---|
| `plugin-panel-center($width)` | По центру над тулбаром (как CropPanel) |
| `plugin-panel-right($min-width)` | Справа над тулбаром (как ExportPanel) |
| `plugin-panel-left($min-width)` | Слева над тулбаром (как ImportPanel) |
| `plugin-panel-fullwidth` | Полоса на всю ширину (как OverlayPanel) |

> Если плагин инжектирует стили через `<style>` тег в JS — правки SCSS не нужны.

---

## Дорожная карта

Фазы рефакторинга (см. `CHANGELOG.md`):

1. ✅ Инфраструктура: npm, ESLint, Vitest, Playwright, CI
2. ✅ Исправления дефектов, теряющих данные пользователя
3. Базовый класс инструмента (`ToolBase`) и общие утилиты canvas/pointer — убрать 6 копий lifecycle
4. Модель изображения на `ImageBitmap`/blob вместо PNG dataURL; Worker для Heal/Adjust
5. Разделение конфига библиотеки и проекта, i18n, доступность, единые префиксы SCSS

## Совместимость

| Браузер | Минимальная версия |
|---|---|
| Chrome / Edge | 88+ |
| Firefox | 90+ |
| Safari | 15+ |
| iOS Safari | 15.4+ |

Clipboard API (импорт/экспорт через буфер) — только HTTPS или `localhost`.

---

## Лицензия

MIT
