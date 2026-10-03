/**
 * HistoryManager — Undo/Redo для PhotoEditor
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Хранилище: IndexedDB (база pe_history, объект states)
 *
 *  Запись: { sessionId, pos, blob (WebP), size, ts }
 *
 *  • Сессия — уникальный ID при каждом открытии редактора.
 *    При закрытии все записи сессии удаляются.
 *  • Позиция (pos) — целое число, монотонно растёт.
 *    cursor указывает на текущую позицию.
 *    Undo: cursor--, Redo: cursor++.
 *    Push: удаляем всё после cursor, добавляем новую запись.
 *  • Лимит: maxStates записей на сессию (из EditorConfig).
 *    При превышении удаляем самую старую.
 *  • Квота: при QuotaExceededError автоматически удаляем половину
 *    истории и повторяем запись.
 *
 * Публичный API:
 *  await hm.push(canvas)          — сохранить снапшот (после apply)
 *  await hm.undo()  → ImageData   — вернуться назад
 *  await hm.redo()  → ImageData   — вернуться вперёд
 *  hm.canUndo / hm.canRedo        — boolean
 *  hm.depth                       — число доступных шагов назад
 *  hm.total                       — всего снапшотов в истории
 *  hm.onUpdate(cb)                — подписка на изменение состояния
 *  await hm.clear()               — очистить сессию
 *  await hm.destroy()             — очистить + закрыть соединение
 */

import { EditorConfig } from './EditorConfig.js';

const CFG       = EditorConfig.history;
const DB_NAME   = 'pe_history';
const DB_VER    = 1;
const STORE     = 'states';

// ─── IndexedDB helpers ────────────────────────────────────────────────────────

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const db    = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        store.createIndex('session', 'sessionId', { unique: false });
        store.createIndex('session_pos', ['sessionId', 'pos'], { unique: true });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

function tx(db, mode) {
  return db.transaction(STORE, mode).objectStore(STORE);
}

function dbGet(store, key) {
  return new Promise((res, rej) => {
    const r = store.get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

function dbPut(store, rec) {
  return new Promise((res, rej) => {
    const r = store.put(rec); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}

function dbDel(store, key) {
  return new Promise((res, rej) => {
    const r = store.delete(key); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
  });
}

function dbGetAll(store, query) {
  return new Promise((res, rej) => {
    const r = query ? store.index('session').getAll(query) : store.getAll();
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}


/**
 * Удаляет все записи с данным sessionId в одной транзакции через курсор.
 * Cursor-подход обязателен: несколько await в одной транзакции вызывают
 * её автозавершение между запросами, после чего store становится недоступен.
 */
function clearSession(db, sessionId) {
  return new Promise((resolve, reject) => {
    const t     = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    const req   = store.index('session').openCursor(IDBKeyRange.only(sessionId));
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    t.oncomplete = () => resolve();
    t.onerror    = () => reject(t.error);
    t.onabort    = () => reject(t.error);
  });
}

/**
 * Конвертирует canvas → Blob.
 *
 * Пробует WebP (компактный), fallback на PNG (универсальный).
 * Использует OffscreenCanvas если доступен — не блокирует main thread.
 */
async function canvasToBlob(canvas, quality = CFG.snapshotQuality) {
  // OffscreenCanvas.convertToBlob — async, не блокирует главный поток
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    const b = await canvas.convertToBlob({ type: 'image/webp', quality });
    if (b && b.size > 0) return b;
    return canvas.convertToBlob({ type: 'image/png' });
  }

  // Обычный canvas.toBlob — async callback
  const tryBlob = (type, q) => new Promise(res => canvas.toBlob(b => res(b), type, q));

  const webp = await tryBlob('image/webp', quality);
  if (webp && webp.size > 0 && webp.type === 'image/webp') return webp;

  const png = await tryBlob('image/png');
  if (png && png.size > 0) return png;

  throw new Error('canvasToBlob: browser returned null/empty blob');
}

/**
 * Blob → HTMLImageElement с data URL в src.
 *
 * Алгоритм:
 *   1. createObjectURL → временный blob URL для быстрой декодировки.
 *   2. После onload — URL отзывается, изображение переносится на canvas.
 *   3. canvas.toDataURL → data URL.
 *   4. Новый Image загружается из data URL и возвращается из промиса.
 *
 * Почему data URL, а не blob URL в img.src:
 *   Chrome не кеширует декодированные пиксели после revokeObjectURL и при
 *   следующем обращении к img.src пытается перечитать blob — который уже
 *   уничтожен → ERR_FILE_NOT_FOUND. Firefox более толерантен, поэтому баг
 *   проявлялся только в Chrome. Data URL не требует сетевого запроса и
 *   безопасен после любого GC.
 *
 * Требования к CSP: img-src blob: data: (blob: нужен только временно,
 * в DOM элементе никогда не оседает).
 */
async function blobToImage(blob) {
  if (!blob || blob.size === 0)
    throw new Error(`blobToImage: invalid blob (size=${blob?.size}, type=${blob?.type})`);

  // Аппаратное декодирование вне main thread — прогрев декодера
  const bitmapPromise = typeof createImageBitmap !== 'undefined'
    ? createImageBitmap(blob).catch(() => null)
    : Promise.resolve(null);

  const url    = URL.createObjectURL(blob);
  const bitmap = await bitmapPromise;

  // Шаг 1: декодируем blob в HTMLImageElement через временный blob URL
  const decoded = await new Promise((res, rej) => {
    const img   = new Image();
    img.onload  = () => res(img);
    img.onerror = () => rej(new Error(`blobToImage: decode failed (type=${blob.type}, size=${blob.size})`));
    img.src = url;
  });

  // Blob URL больше не нужен — отзываем немедленно после декодировки
  URL.revokeObjectURL(url);

  // Шаг 2: переносим пиксели на canvas.
  // Используем ImageBitmap если он готов — рисование без блокировки main thread.
  const w  = decoded.naturalWidth;
  const h  = decoded.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  if (bitmap) {
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
  } else {
    ctx.drawImage(decoded, 0, 0);
  }

  // Шаг 3: canvas → data URL (WebP где поддерживается, иначе PNG)
  const tryDataUrl = (type, q) => {
    const u = cv.toDataURL(type, q);
    // Некоторые браузеры возвращают image/png при неподдерживаемом типе
    return u.startsWith(`data:${type}`) ? u : null;
  };
  const dataUrl = tryDataUrl('image/webp', CFG.snapshotQuality) ?? cv.toDataURL('image/png');

  // Шаг 4: возвращаем Image с data URL — стабильный src без blob-зависимостей
  return new Promise((res, rej) => {
    const img2   = new Image();
    img2.onload  = () => res(img2);
    img2.onerror = () => rej(new Error('blobToImage: data URL re-encode failed'));
    img2.src = dataUrl;
  });
}

// ─── HistoryManager ───────────────────────────────────────────────────────────

export class HistoryManager {
  constructor() {
    this._sessionId  = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this._db         = null;       // Promise<IDBDatabase>
    this._dbReady    = false;
    this._cursor     = -1;         // индекс текущего состояния в this._index
    this._index      = [];         // [{id, pos, size}] — загруженный индекс сессии
    this._totalSize  = 0;          // суммарный размер в байтах
    this._listeners  = [];
    this._pushing    = false;      // мьютекс для push
    this._destroyed  = false;      // флаг уничтожения — блокирует любые операции
    this._dbPromise  = this._init();
  }

  // ─── Инициализация ──────────────────────────────────────────────────────

  async _init() {
    try {
      this._db      = await openDB();
      this._dbReady = true;
      await this._loadIndex();
    } catch (err) {
      console.warn('[HistoryManager] IndexedDB недоступен, история отключена:', err);
      this._dbReady = false;
    }
  }

  async _ready() { return this._dbPromise; }

  /** Загружает индекс (id, pos, size) для текущей сессии из БД. */
  async _loadIndex() {
    if (!this._dbReady) return;
    const rows  = await dbGetAll(tx(this._db, 'readonly'), this._sessionId);
    this._index = rows
      .map(r => ({ id: r.id, pos: r.pos, size: r.size || 0 }))
      .sort((a, b) => a.pos - b.pos);
    this._totalSize = this._index.reduce((s, r) => s + r.size, 0);
    this._cursor    = this._index.length - 1;
  }

  // ─── Публичный API ──────────────────────────────────────────────────────

  get canUndo()  { return this._cursor > 0; }
  get canRedo()  { return this._cursor < this._index.length - 1; }
  get depth()    { return Math.max(0, this._cursor); }        // шагов назад
  get total()    { return this._index.length; }
  get maxStates(){ return CFG.maxStates; }

  onUpdate(cb)   { this._listeners.push(cb); return () => { this._listeners = this._listeners.filter(l => l !== cb); }; }
  _notify()      { for (const l of this._listeners) { try { l(this._snapshot()); } catch {} } }

  _snapshot() {
    return {
      canUndo:    this.canUndo,
      canRedo:    this.canRedo,
      depth:      this.depth,
      total:      this.total,
      maxStates:  this.maxStates,
      totalSizeMb: (this._totalSize / 1024 / 1024).toFixed(1),
      cursor:     this._cursor,
    };
  }

  /**
   * Сохраняет снапшот после apply().
   * @param {HTMLCanvasElement} canvas
   */
  async push(canvas) {
    if (this._destroyed) return;  // быстрый выход до await
    await this._ready();
    if (!this._dbReady || !this._db) return; // уже уничтожен
    if (this._pushing) return;
    this._pushing = true;
    try {
      await this._pushInternal(canvas);
    } finally {
      this._pushing = false;
    }
  }

  async _pushInternal(canvas, retryOnQuota = true) {
    if (!this._db || !this._dbReady) return; // уничтожен между await-ами
    // Удаляем все состояния после курсора (ветка будущего отрезана)
    const future = this._index.slice(this._cursor + 1);
    if (future.length) {
      // Все удаления — в одной транзакции, без await между запросами
      await new Promise((resolve, reject) => {
        const t     = this._db.transaction(STORE, 'readwrite');
        const store = t.objectStore(STORE);
        for (const r of future) store.delete(r.id);
        t.oncomplete = () => resolve();
        t.onerror    = () => reject(t.error);
        t.onabort    = () => reject(t.error);
      });
      for (const r of future) this._totalSize -= r.size;
      this._index = this._index.slice(0, this._cursor + 1);
    }

    // Если история заполнена — удаляем самую старую запись
    while (this._index.length >= CFG.maxStates) {
      await this._dropOldest();
    }

    const blob    = await canvasToBlob(canvas);
    const pos     = (this._index.at(-1)?.pos ?? -1) + 1;
    const size    = blob.size;
    const record  = { sessionId: this._sessionId, pos, blob, size, ts: Date.now() };

    try {
      const id = await dbPut(tx(this._db, 'readwrite'), record);
      this._index.push({ id, pos, size });
      this._totalSize += size;
      this._cursor     = this._index.length - 1;
      this._notify();
    } catch (err) {
      if (retryOnQuota && (err?.name === 'QuotaExceededError' || err?.code === 22)) {
        // Освобождаем ~половину истории и пробуем снова
        const half = Math.max(1, Math.ceil(this._index.length / 2));
        for (let i = 0; i < half; i++) await this._dropOldest();
        await this._pushInternal(canvas, false);
      } else {
        console.warn('[HistoryManager] push failed:', err);
      }
    }
  }

  /** Удаляет самую старую запись сессии. */
  async _dropOldest() {
    if (!this._index.length) return;
    const oldest = this._index.shift();
    await dbDel(tx(this._db, 'readwrite'), oldest.id);
    this._totalSize -= oldest.size;
    this._cursor = Math.max(0, this._cursor - 1);
    this._notify();
  }

  /**
   * Шаг назад. Возвращает Image или null.
   */
  async undo() {
    await this._ready();
    if (!this.canUndo) return null;
    this._cursor--;
    this._notify();
    return this._loadCurrent();
  }

  /**
   * Шаг вперёд. Возвращает Image или null.
   */
  async redo() {
    await this._ready();
    if (!this.canRedo) return null;
    this._cursor++;
    this._notify();
    return this._loadCurrent();
  }

  async _loadCurrent() {
    if (this._cursor < 0 || this._cursor >= this._index.length) return null;
    const { id } = this._index[this._cursor];
    const row = await dbGet(tx(this._db, 'readonly'), id);
    if (!row?.blob) return null;
    return blobToImage(row.blob);
  }

  /** Очищает историю текущей сессии. */
  async clear() {
    await this._ready();
    if (!this._dbReady) return;
    await clearSession(this._db, this._sessionId);
    this._index     = [];
    this._cursor    = -1;
    this._totalSize = 0;
    this._notify();
  }

  /** Очищает и закрывает соединение с БД. */
  async destroy() {
    this._destroyed = true;  // быстрый флаг — проверяется до любого await
    this._dbReady   = false;
    await this.clear();
    this._db?.close();
    this._db = null;
  }
}
