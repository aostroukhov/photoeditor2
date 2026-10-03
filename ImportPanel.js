/**
 * ImportPanel v3.5
 *
 * Изменения v3.5:
 *  • При загрузке файла сохраняет originalFileName и originalMimeType
 *    в photoEditor для последующего использования при экспорте.
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
            this._buildClipboardFileName(blob).then((name) => {
              this._loadBlob(blob, el, null, name, blob.type);
            });
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
          const name = await this._buildClipboardFileName(blob);
          await this._loadBlob(blob, el, null, name, type);
          return;
        }
      }
      this._setStatus(el, 'В буфере нет изображения', true);
    } catch (e) {
      this._setStatus(el, 'Ошибка: ' + e.message, true);
    }
  }

  _loadFile(file, el) {
    const reader = new FileReader();
    reader.onload = (ev) => this._applyDataURL(ev.target.result, el, null, file.name, file.type, file.size);
    reader.readAsDataURL(file);
  }

  /**
   * Строит содержательное имя файла для вставки из буфера обмена.
   * Формат: clipboard-WxH-YYYY-MM-DD.ext
   * Размеры читаются из blob через временный Image (без blob URL в DOM).
   * Возвращает Promise<string>.
   */
  _buildClipboardFileName(blob) {
    return new Promise((resolve) => {
      const mime = blob.type || 'image/png';
      const ext  = mime.split('/')[1] || 'png';
      const d    = new Date();
      const date = d.getFullYear()
                 + '-' + String(d.getMonth() + 1).padStart(2, '0')
                 + '-' + String(d.getDate()).padStart(2, '0');

      // Читаем размеры через FileReader → dataURL → Image
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload  = () => resolve('clipboard-' + img.naturalWidth + 'x' + img.naturalHeight + '-' + date + '.' + ext);
        img.onerror = ()  => resolve('clipboard-' + date + '.' + ext);
        img.src = ev.target.result;
      };
      reader.onerror = () => resolve('clipboard-' + date + '.' + ext);
      reader.readAsDataURL(blob);
    });
  }

  _loadBlob(blob, el, onDone, fileName, mimeType) {
    const reader = new FileReader();
    reader.onload  = (ev) => this._applyDataURL(ev.target.result, el, onDone, fileName, mimeType ?? blob.type, blob.size);
    reader.onerror = ()   => { if (el) this._setStatus(el, 'Ошибка чтения', true); onDone?.(); };
    reader.readAsDataURL(blob);
  }

  _applyDataURL(src, el, onDone, fileName, mimeType, fileSize) {
    const pe  = this.photoEditor;
    const img = new Image();
    img.onload = () => {
      if (typeof pe.setImage === 'function') {
        pe.setImage(img, { fileName: fileName ?? null, mimeType: mimeType ?? null, fileSize: fileSize ?? null }).then(() => {
          onDone?.();
          if (el) this._setStatus(el, '✓ Изображение загружено');
        });
      } else {
        pe.originalFileName = fileName ?? null;
        pe.originalMimeType = mimeType ?? null;
        pe.originalFileSize = fileSize ?? null;
        pe.commitImage(img);
        pe.activeTool?.onContainerResize?.();
        onDone?.();
        if (el) this._setStatus(el, '✓ Изображение загружено');
      }
    };
    img.onerror = () => { if (el) this._setStatus(el, 'Ошибка загрузки', true); onDone?.(); };
    img.src = src;
  }
}
