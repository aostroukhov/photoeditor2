/**
 * ExportPanel v3.6
 *
 * Изменения v3.6:
 *  • Все внутренние поля и методы переведены на ES2022 Private Fields (#).
 *  • _download() возвращает булев признак успешного сохранения —
 *    статус «✓ Сохранён» не показывается при отмене диалога пользователем.
 *  • showSaveDialog управляется через EditorConfig.export.showSaveDialog.
 *  • Имя файла: оригинальное (photoEditor.originalFileName) + смена расширения,
 *    или YYYY-MM-DD_HH-MM.ext если оригинального нет.
 *
 * ── Публичный API ────────────────────────────────────────────────────────────
 *   mount(container)   Вставить панель в DOM, зарегистрировать в DialogManager.
 *   unmount()          Удалить панель из DOM, отписаться от DialogManager.
 *   toggle()           Переключить видимость через DialogManager.
 *   show() / hide()    Показать / скрыть.
 *
 * ── Приватные поля (#) ───────────────────────────────────────────────────────
 *   #el               Корневой DOM-элемент панели.
 *   #quality          Текущее значение качества JPEG (1–100).
 *   static #loadQuality / static #saveQuality — работа с localStorage.
 *
 * Класс: pe-panel pe-panel--export
 * Регистрируется в DialogManager как group='utility', id='export'.
 */
import { EditorConfig } from './EditorConfig.js';

export class ExportPanel {

  // ── Приватные поля ──────────────────────────────────────────────────────────

  /** Корневой DOM-элемент панели. null до mount() и после unmount(). */
  #el = null;

  /** Текущее качество JPEG (1–100). Персистируется в localStorage. */
  #quality;


  // ── Конструктор ─────────────────────────────────────────────────────────────

  constructor(photoEditor) {
    this.photoEditor = photoEditor;
    this.#quality    = ExportPanel.#loadQuality();
  }


  // ── Приватные утилиты хранения качества ─────────────────────────────────────

  /**
   * Читает сохранённое качество из localStorage.
   * Если значение отсутствует или невалидно — возвращает дефолт из EditorConfig.
   */
  static #loadQuality()  { return EditorConfig.loadExportQuality(); }
  static #saveQuality(v) { EditorConfig.saveExportQuality(v); }


  // ── Публичный API ───────────────────────────────────────────────────────────

  /**
   * Монтирует панель в переданный контейнер и регистрирует её в DialogManager.
   * @param {HTMLElement} container  Корневой элемент PhotoEditor.
   */
  mount(container) {
    const el = document.createElement('div');
    el.className = 'pe-panel pe-panel--export';
    el.innerHTML = `
      <div class="pe-panel__header">
        <span class="pe-panel__title">Экспорт</span>
      </div>
      <div class="pe-panel__row">
        <button type="button" class="pe-panel__action-btn" data-action="copy"
                title="Скопировать в буфер обмена (PNG — единственный формат, который принимает Clipboard API)">
          <i class="pe-panel__action-btn-icon icon-paste" aria-hidden="true"></i>
          <span class="pe-panel__action-btn-text">Буфер</span>
        </button>
        <button type="button" class="pe-panel__action-btn" data-action="save-jpg"
                title="Скачать как JPG">
          <i class="pe-panel__action-btn-icon icon-download" aria-hidden="true"></i>
          <span class="pe-panel__action-btn-text">JPG</span>
        </button>
        <button type="button" class="pe-panel__action-btn" data-action="save-png"
                title="Скачать как PNG">
          <i class="pe-panel__action-btn-icon icon-download" aria-hidden="true"></i>
          <span class="pe-panel__action-btn-text">PNG</span>
        </button>
      </div>
      <label class="pe-panel__quality" title="Качество JPG (1–100)">
        Качество JPG
        <input type="range" class="pe-panel__quality-range" min="1" max="100" value="${this.#quality}">
        <span class="pe-panel__quality-val">${this.#quality}</span>%
      </label>
      <div class="pe-panel__status" aria-live="polite"></div>`;

    const range = el.querySelector('.pe-panel__quality-range');
    const val   = el.querySelector('.pe-panel__quality-val');
    range.addEventListener('input', () => {
      this.#quality   = Number(range.value);
      val.textContent = range.value;
      ExportPanel.#saveQuality(this.#quality);
    });

    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      this.#handleAction(btn.dataset.action, el);
    });

    container.appendChild(el);
    this.#el = el;

    this.photoEditor.dialogs?.register('export', el, {
      group:       'utility',
      btnSelector: '[data-action="toggle-export"]',
    });
  }

  /** Удаляет панель из DOM и отписывается от DialogManager. */
  unmount() {
    this.photoEditor.dialogs?.unregister('export');
    this.#el?.remove();
    this.#el = null;
  }

  toggle() { this.photoEditor.dialogs?.toggle('export'); }
  show()   { this.photoEditor.dialogs?.open('export');   }
  hide()   { this.photoEditor.dialogs?.close('export');  }


  // ── Приватная логика экспорта ───────────────────────────────────────────────

  /**
   * Строит имя файла для скачивания.
   * Приоритет: originalFileName редактора (с заменой расширения).
   * Фоллбэк: «YYYY-MM-DD_HH-MM.ext».
   *
   * @param {'jpeg'|'png'} format
   * @returns {string}
   */
  #buildFileName(format) {
    return EditorConfig.buildExportFileName(
      this.photoEditor.originalFileName,
      format,
    );
  }

  /**
   * Обрабатывает клик по кнопке экспорта.
   * Блокирует все кнопки на время операции, показывает статус-сообщение.
   *
   * @param {'copy'|'save-jpg'|'save-png'} action
   * @param {HTMLElement} el  Корневой элемент панели (содержит .pe-panel__status).
   */
  async #handleAction(action, el) {
    const status = el.querySelector('.pe-panel__status');

    const setStatus = (msg, isError = false) => {
      status.textContent = msg;
      status.className   = 'pe-panel__status'
                         + (isError ? ' pe-panel__status--error' : ' pe-panel__status--ok');
      setTimeout(() => {
        status.textContent = '';
        status.className   = 'pe-panel__status';
      }, 3500);
    };

    // Блокируем все кнопки на время операции, чтобы предотвратить двойной клик
    const btns  = el.querySelectorAll('[data-action]');
    const unlock = () => btns.forEach(b => { b.disabled = false; });
    btns.forEach(b => { b.disabled = true; });

    let canvas;
    try {
      canvas = this.photoEditor.getResultCanvas();
    } catch (e) {
      setStatus('Ошибка: ' + e.message, true);
      unlock();
      return;
    }

    const q = this.#quality / 100;
    try {
      switch (action) {
        case 'copy':
          await this.#copyToClipboard(canvas);
          setStatus('✓ Скопировано в буфер (PNG)');
          this.photoEditor.notifyExportDone();
          break;

        case 'save-jpg': {
          const saved = await this.#download(canvas, 'image/jpeg', q, this.#buildFileName('jpeg'));
          if (saved) {
            setStatus('✓ JPG сохранён');
            this.photoEditor.notifyExportDone();
          }
          break;
        }

        case 'save-png': {
          const saved = await this.#download(canvas, 'image/png', 1, this.#buildFileName('png'));
          if (saved) {
            setStatus('✓ PNG сохранён');
            this.photoEditor.notifyExportDone();
          }
          break;
        }
      }
    } catch (e) {
      setStatus('Ошибка: ' + e.message, true);
    } finally {
      unlock();
    }
  }

  /**
   * Копирует canvas в буфер обмена как PNG.
   *
   * Clipboard API принимает только PNG — JPEG не поддерживается, поэтому
   * в панели одна кнопка «Буфер» (раньше были «JPG» и «PNG», и обе копировали PNG).
   * Требует HTTPS и разрешения clipboard-write.
   *
   * @throws {Error} Если Clipboard API недоступен (HTTP / Safari без флагов).
   */
  async #copyToClipboard(canvas) {
    if (!navigator.clipboard?.write) {
      throw new Error('Clipboard API недоступен — нужен HTTPS');
    }
    const blob = await this.#toBlob(canvas, 'image/png', 1);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
  }

  /**
   * Скачивает canvas как файл.
   *
   * Если EditorConfig.export.showSaveDialog === true и браузер поддерживает
   * File System Access API — открывает нативный диалог «Сохранить как».
   * Фоллбэк на <a download> при: отсутствии API, ошибке, showSaveDialog:false.
   *
   * @returns {Promise<boolean>}  true — файл сохранён, false — отменено пользователем.
   */
  async #download(canvas, mime, quality, filename) {
    const blob = await this.#toBlob(canvas, mime, quality);
    if (!blob) throw new Error('toBlob вернул null');

    const canUseDialog = EditorConfig.export.showSaveDialog
      && typeof window.showSaveFilePicker === 'function';

    if (canUseDialog) {
      try {
        const types = mime === 'image/jpeg'
          ? [{ description: 'JPEG Image', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } }]
          : [{ description: 'PNG Image',  accept: { 'image/png':  ['.png'] } }];

        const handle   = await window.showSaveFilePicker({ suggestedName: filename, types });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true; // ← сохранено через нативный диалог

      } catch (err) {
        if (err.name === 'AbortError') return false; // ← пользователь отменил
        // Другая ошибка (SecurityError, NotAllowedError и т.п.) → фоллбэк на <a>
        console.warn('[ExportPanel] showSaveFilePicker failed, fallback:', err.message);
      }
    }

    // Классическое скачивание через <a download>
    const url = URL.createObjectURL(blob);
    const a   = document.createElement('a');
    a.href     = url;
    a.download = filename;
    a.click();
    // Revoke после задержки — браузеру нужно время начать скачивание
    setTimeout(() => URL.revokeObjectURL(url), 15_000);
    return true; // ← браузер начал скачивание
  }

  /**
   * Обёртка над canvas.toBlob() с Promise-интерфейсом.
   *
   * @param {HTMLCanvasElement} canvas
   * @param {string}            mime     'image/jpeg' | 'image/png'
   * @param {number}            quality  0.0–1.0 (игнорируется для PNG)
   * @returns {Promise<Blob>}
   */
  #toBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        blob => blob ? resolve(blob) : reject(new Error('toBlob вернул null')),
        mime,
        quality,
      );
    });
  }
}
