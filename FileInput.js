/**
 * FileInput v3.5 — связывает PhotoEditor с полем <input type="file">.
 *
 * Изменения v3.5:
 *  • export() строит имя через EditorConfig.buildExportFileName():
 *    - приоритет: оригинальное имя файла (со сменой расширения)
 *    - fallback: YYYY-MM-DD_HH-MM.ext
 *  • originalFileName/originalMimeType синхронизируются с photoEditor
 */
import { EditorConfig } from './EditorConfig.js';

export class FileInput {

	constructor(photoEditor) {
		this.photoEditor    = photoEditor;
		this.fileInput      = null;
		this.lock           = false;
		this.originalFile   = null;

		this.openBtn  = null;
		this.pasteBtn = null;

		/** Вызывается при ошибках */
		this.onError = (msg) => console.error('[FileInput]', msg);

		this.open      = this.open.bind(this);
		this._onChange = () => { if (!this.lock) this.import(); };
	}


	// ─── Импорт ───────────────────────────────────────────────────────────────

	import() {
		this.originalFile = this.fileInput.files[0];
		if (!this.originalFile) { this._toggleButtons(false); return; }

		// Сохраняем имя и тип в photoEditor
		this.photoEditor.originalFileName = this.originalFile.name;
		this.photoEditor.originalMimeType = this.originalFile.type || 'image/png';

		const reader    = new FileReader();
		reader.onload   = (e) => {
			const img   = new Image();
			img.onload  = () => {
				this.photoEditor.commitImage(img);
				this._toggleButtons(true);
			};
			img.src = e.target.result;
		};
		reader.onerror = () => this.onError('Ошибка чтения файла');
		reader.readAsDataURL(this.originalFile);
	}


	// ─── Экспорт ──────────────────────────────────────────────────────────────

	export(resultCanvas) {
		if (!this.originalFile) { this.onError('Нет исходного файла для экспорта'); return; }

		const mimeType = this.originalFile.type || 'image/png';
		const ext      = mimeType === 'image/jpeg' ? 'jpeg' : mimeType.split('/')[1];

		// Имя: сохраняем оригинальное, только меняем расширение
		const fileName = EditorConfig.buildExportFileName(this.originalFile.name, ext);

		resultCanvas.toBlob((blob) => {
			if (!blob) { this.onError('Не удалось создать Blob из canvas'); return; }

			const file = new File(
				[blob],
				fileName,
				{ type: mimeType, lastModified: Date.now() },
			);
			const dt = new DataTransfer();
			dt.items.add(file);

			this.lock = true;
			this.fileInput.files = dt.files;
			this.fileInput.dispatchEvent(new Event('change', { bubbles: true }));
			this.lock = false;
		}, mimeType, EditorConfig.loadExportQuality() / 100);   // то же качество, что в ExportPanel
	}


	// ─── Буфер обмена ─────────────────────────────────────────────────────────

	async importFromClipboard() {
		if (!navigator.clipboard?.read) {
			this.onError('Clipboard API не поддерживается (нужен HTTPS)');
			return;
		}
		try {
			const items = await navigator.clipboard.read();
			for (const item of items) {
				for (const type of item.types) {
					if (!type.startsWith('image/')) continue;
					const blob = await item.getType(type);
					if (!(blob instanceof Blob) || !blob.size) {
						this.onError('Данные из буфера не являются изображением'); return;
					}
					const ext  = type.split('/')[1] ?? 'png';
					const file = new File([blob], `clipboard.${ext}`, {
						type: blob.type, lastModified: Date.now(),
					});
					const dt = new DataTransfer();
					dt.items.add(file);
					this.lock = true;
					this.fileInput.files = dt.files;
					this.fileInput.dispatchEvent(new Event('change', { bubbles: true }));
					this.lock = false;
					return;
				}
			}
			this.onError('В буфере обмена не найдено изображений');
		} catch (err) {
			this.onError(`Ошибка доступа к буферу: ${err.message}`);
		}
	}


	// ─── Кнопки ───────────────────────────────────────────────────────────────

	insertButtons() {
		if (this.openBtn || this.pasteBtn) return;

		this.pasteBtn = document.createElement('button');
		this.pasteBtn.type      = 'button';
		this.pasteBtn.className = 'button image-input__btn-photo-editor icon-paste';
		this.pasteBtn.title     = 'Вставить изображение из буфера обмена';
		this.pasteBtn.addEventListener('click', async (e) => {
			e.preventDefault();
			await this.importFromClipboard();
		});
		this.fileInput.parentNode.insertBefore(this.pasteBtn, this.fileInput.nextSibling);

		this.openBtn = document.createElement('button');
		this.openBtn.type      = 'button';
		this.openBtn.className = 'button image-input__btn-photo-editor icon-crop';
		this.openBtn.title     = 'Открыть в редакторе';
		this.openBtn.style.display = 'none';
		this.openBtn.addEventListener('click', (e) => {
			e.preventDefault();
			this.open();
		});
		this.fileInput.parentNode.insertBefore(this.openBtn, this.fileInput.nextSibling);
	}


	/**
	 * Привязывает к <input type="file">. Идемпотентен: повторный вызов
	 * (в т.ч. с другим элементом) снимает слушатели с предыдущего.
	 */
	bind(fileInputElement) {
		this.unbind();
		this.fileInput = fileInputElement;
		this.fileInput.addEventListener('change',      this._onChange);
		this.fileInput.addEventListener('photoeditor', this.open);
	}

	/** Снимает слушатели с текущего <input>. */
	unbind() {
		if (!this.fileInput) return;
		this.fileInput.removeEventListener('change',      this._onChange);
		this.fileInput.removeEventListener('photoeditor', this.open);
		this.fileInput = null;
	}


	open() {
		if (this.photoEditor.img) this.photoEditor.open();
	}


	_toggleButtons(visible) {
		const d = visible ? '' : 'none';
		if (this.openBtn)  this.openBtn.style.display  = d;
		if (this.pasteBtn) this.pasteBtn.style.display = d;
	}
}
