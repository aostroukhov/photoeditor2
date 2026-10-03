/**
 * ImportPanel — загрузка изображения из файла или буфера обмена (кнопка / Ctrl+V).
 *
 * Изображение передаётся редактору как Blob (PhotoEditor.setImageBlob): одно
 * декодирование через blob: URL, без FileReader и base64 в памяти.
 *
 * Класс: pe-panel pe-panel--import
 * Регистрируется в DialogManager как group='utility', id='import'
 */
export class ImportPanel {

  constructor(photoEditor) {
    this.photoEditor = photoEditor;
    this._el         = null;
    this._fileInput  = null;
    this._onPaste    = null;
  }

  mount(container) {
    const el = document.createElement('div');
    el.className = 'pe-panel pe-panel--import';
    el.innerHTML = `
      <div class="pe-panel__header">
        <span class="pe-panel__title">Импорт</span>
      </div>
      <div class="pe-panel__row">
        <button type="button" class="pe-panel__action-btn" data-action="paste"
                title="Вставить изображение из буфера обмена (Ctrl+V)">
          <i class="pe-panel__action-btn-icon icon-paste" aria-hidden="true"></i>
          <span class="pe-panel__action-btn-text">Буфер</span>
        </button>
        <button type="button" class="pe-panel__action-btn" data-action="open-file"
                title="Открыть файл с диска">
          <i class="pe-panel__action-btn-icon icon-folder-open" aria-hidden="true"></i>
          <span class="pe-panel__action-btn-text">Файл</span>
        </button>
      </div>
      <div class="pe-panel__hint">Или нажмите Ctrl+V прямо в редакторе</div>
      <div class="pe-panel__status" aria-live="polite"></div>`;

    // Скрытый file input
    this._fileInput = document.createElement('input');
    this._fileInput.type = 'file';
    this._fileInput.accept = 'image/*';
    this._fileInput.style.display = 'none';
    this._fileInput.addEventListener('change', () => {
      const file = this._fileInput.files?.[0];
      if (file) this._loadFile(file, el);
    });
    container.appendChild(this._fileInput);

    el.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      if (btn.dataset.action === 'paste')     this._pasteFromClipboard(el);
      if (btn.dataset.action === 'open-file') this._fileInput.click();
    });

    // Ctrl+V
    this._onPaste = (e) => {
      for (const item of e.clipboardData?.items ?? []) {
        if (item.type.startsWith('image/')) {
          const blob = item.getAsFile();
          if (blob) {
            e.preventDefault();
            this._loadBlob(blob, el, null, null, blob.type);
            return;
          }
        }
      }
    };
    document.addEventListener('paste', this._onPaste);

    container.appendChild(el);
    this._el = el;

    this.photoEditor.dialogs?.register('import', el, {
      group:       'utility',
      btnSelector: '[data-action="toggle-import"]',
    });
  }

  unmount() {
    document.removeEventListener('paste', this._onPaste);
    this.photoEditor.dialogs?.unregister('import');
    this._fileInput?.remove();
    this._el?.remove();
    this._el = null;
  }

  toggle() { this.photoEditor.dialogs?.toggle('import'); }
  show()   { this.photoEditor.dialogs?.open('import');   }
  hide()   { this.photoEditor.dialogs?.close('import');  }


  // ── Приватные ──────────────────────────────────────────────────────────────

  _setStatus(el, msg, err = false) {
    const s = el.querySelector('.pe-panel__status');
    if (!s) return;
    s.textContent = msg;
    s.className = 'pe-panel__status' + (err ? ' pe-panel__status--error' : ' pe-panel__status--ok');
    setTimeout(() => { s.textContent = ''; s.className = 'pe-panel__status'; }, 3000);
  }

  async _pasteFromClipboard(el) {
    if (!navigator.clipboard?.read) {
      this._setStatus(el, '⚠ Clipboard API недоступен (нужен HTTPS)', true); return;
    }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of item.types) {
          if (!type.startsWith('image/')) continue;
          const blob = await item.getType(type);
          await this._loadBlob(blob, el, null, null, type);
          return;
        }
      }
      this._setStatus(el, 'В буфере нет изображения', true);
    } catch (e) {
      this._setStatus(el, 'Ошибка: ' + e.message, true);
    }
  }

  _loadFile(file, el) {
    if (!file.type.startsWith('image/')) { this._setStatus(el, 'Это не изображение', true); return; }
    this._loadBlob(file, el, null, file.name, file.type);
  }

  /**
   * Имя для вставки из буфера: clipboard-WxH-YYYY-MM-DD.ext
   * (размеры — из уже загруженного изображения, без повторного декодирования).
   */
  _clipboardFileName(img, mime) {
    const ext  = (mime || 'image/png').split('/')[1] || 'png';
    const d    = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const size = img?.naturalWidth ? `${img.naturalWidth}x${img.naturalHeight}-` : '';
    return `clipboard-${size}${date}.${ext}`;
  }

  /**
   * Загружает Blob в редактор одним декодированием (blob: URL), без base64.
   * fileName === null → имя для буфера обмена строится по размерам изображения.
   */
  async _loadBlob(blob, el, onDone, fileName, mimeType) {
    const pe = this.photoEditor;
    try {
      const mime = mimeType ?? blob.type;
      const img  = await pe.setImageBlob(blob, { fileName: fileName ?? null, mimeType: mime, fileSize: blob.size });
      if (fileName == null) pe.originalFileName = this._clipboardFileName(img, mime);
      if (el) this._setStatus(el, '✓ Изображение загружено');
    } catch {
      if (el) this._setStatus(el, 'Ошибка загрузки', true);
    } finally {
      onDone?.();
    }
  }
}
