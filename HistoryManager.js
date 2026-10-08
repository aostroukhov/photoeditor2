/**
 * HistoryManager — Undo/Redo для PhotoEditor
 *
 * ──────────────────────────────────────────────────────────────────────────────
 * Хранилище: IndexedDB (база pe_history, объект states)
 *
 *  Запись: { sessionId, pos, blob (PNG — без потерь), size, ts }
 *
 *  Снапшоты хранятся без потерь: undo возвращает ровно те пиксели, что были.
 *  Раньше использовался lossy WebP — каждый undo подменял изображение
 *  пережатой копией, и дальнейшие правки шли поверх неё.
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
 *  await hm.push(blobOrCanvas)    — сохранить снапшот (после apply)
 *  await hm.undo()  → Blob|null   — вернуться назад
 *  await hm.redo()  → Blob|null   — вернуться вперёд
 *  hm.canUndo / hm.canRedo        — boolean
 *  hm.depth                       — число доступных шагов назад
 *  hm.total                       — всего снапшотов в истории
 *  hm.onUpdate(cb)                — подписка на изменение состояния
 *  await hm.clear()               — очистить сессию
 *  await hm.destroy()             — очистить + закрыть соединение
 */

import { EditorConfig } from './EditorConfig.js';
import { canvasToBlob } from './canvasUtils.js';

const CFG       = EditorConfig.history;
const DB_NAME   = 'pe_history';
const DB_VER    = 1;
const STORE     = 'states';
const SNAPSHOT_TYPE = 'image/png';

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
/**
 * Удаляет записи ДРУГИХ сессий старше maxAgeMs — хвосты от вкладок, закрытых
 * аварийно (destroy() не успел выполниться). Иначе база растёт бесконечно.
 */
function purgeStaleSessions(db, currentSessionId, maxAgeMs) {
  return new Promise((resolve) => {
    const threshold = Date.now() - maxAgeMs;
    const t     = db.transaction(STORE, 'readwrite');
    const store = t.objectStore(STORE);
    const req   = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) return;
      const r = cursor.value;
      if (r.sessionId !== currentSessionId && (r.ts ?? 0) < threshold) cursor.delete();
      cursor.continue();
    };
    t.oncomplete = () => resolve();
    t.onerror    = () => resolve();   // чистка best-effort: ошибка не должна ломать историю
    t.onabort    = () => resolve();
  });
}

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
    this._queue      = Promise.resolve(); // последовательная очередь push()
    this._destroyed  = false;      // флаг уничтожения — блокирует любые операции
    this._dbPromise  = this._init();
  }

  // ─── Инициализация ──────────────────────────────────────────────────────

  async _init() {
    try {
      this._db      = await openDB();
      this._dbReady = true;
      await purgeStaleSessions(this._db, this._sessionId, CFG.staleSessionMaxAgeMs);
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
  _notify()      { for (const l of this._listeners) { try { l(this.snapshot()); } catch {} } }

  /** Текущее состояние истории для UI (кнопки undo/redo, бейдж). */
  snapshot() {
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
   *
   * Вызовы выполняются строго последовательно через очередь промисов:
   * два быстрых commitImage() дают два состояния. Раньше стоял мьютекс,
   * который молча отбрасывал конкурентный push — состояние терялось.
   *
   * @param {Blob|Promise<Blob>|HTMLCanvasElement|OffscreenCanvas} source  Готовый blob
   *        (предпочтительно — без повторного кодирования), промис blob'а (кодирование уже
   *        запущено вызывающей стороной) или canvas, который будет закодирован в PNG.
   * @returns {Promise<void>}
   */
  push(source) {
    if (this._destroyed) return Promise.resolve();  // быстрый выход до await
    const run = async () => {
      await this._ready();
      if (this._destroyed || !this._dbReady || !this._db) return; // уничтожен, пока ждали
      const src  = await source;   // Blob | canvas (await не-промиса — no-op)
      const blob = src instanceof Blob ? src : await canvasToBlob(src, SNAPSHOT_TYPE);
      await this._pushInternal(blob);
    };
    const p = this._queue.then(run, run);
    this._queue = p.catch(() => {});
    return p;
  }

  async _pushInternal(blob, retryOnQuota = true) {
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
        await this._pushInternal(blob, false);
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
   * Шаг назад. Возвращает Blob снапшота или null.
   */
  async undo() {
    await this._ready();
    if (!this.canUndo) return null;
    this._cursor--;
    this._notify();
    return this._loadCurrent();
  }

  /**
   * Шаг вперёд. Возвращает Blob снапшота или null.
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
    return row?.blob ?? null;
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

  /**
   * Очищает сессию и закрывает соединение с БД.
   *
   * Порядок важен: сначала дождаться очереди push и очистить записи,
   * и только потом снять _dbReady. Раньше флаг снимался первым, clear()
   * выходил по guard, и записи сессии оставались в IndexedDB навсегда.
   */
  async destroy() {
    if (this._destroyed) return;
    this._destroyed = true;  // блокирует новые push до любого await
    await this._queue.catch(() => {});
    await this._ready();
    if (this._dbReady && this._db) {
      try { await clearSession(this._db, this._sessionId); }
      catch (err) { console.warn('[HistoryManager] destroy: не удалось очистить сессию', err); }
    }
    this._index     = [];
    this._cursor    = -1;
    this._totalSize = 0;
    this._dbReady   = false;
    this._db?.close();
    this._db = null;
  }
}
