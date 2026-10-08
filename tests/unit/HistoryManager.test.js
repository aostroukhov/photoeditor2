import { describe, it, expect, beforeEach } from 'vitest';
import { HistoryManager } from '../../HistoryManager.js';

/** Минимальный «canvas» для push(): HistoryManager нужен только toBlob(). */
let seq = 0;
function fakeCanvas() {
  const n = ++seq;
  return {
    toBlob(cb, type) { cb(new Blob([new Uint8Array(100 + n)], { type })); },
  };
}

const tick = () => new Promise(r => setTimeout(r, 0));

describe('HistoryManager', () => {
  let hm;
  beforeEach(async () => {
    hm = new HistoryManager();
    await hm._ready();
  });

  it('пустая история: нечего отменять и повторять', () => {
    expect(hm.canUndo).toBe(false);
    expect(hm.canRedo).toBe(false);
    expect(hm.depth).toBe(0);
  });

  it('push добавляет состояния, курсор на последнем', async () => {
    await hm.push(fakeCanvas());
    await hm.push(fakeCanvas());
    expect(hm.total).toBe(2);
    expect(hm.depth).toBe(1);
    expect(hm.canUndo).toBe(true);
    expect(hm.canRedo).toBe(false);
  });

  it('push принимает Promise<Blob> и сохраняет порядок записей', async () => {
    const slow = new Promise(r => setTimeout(() => r(new Blob([new Uint8Array(10)], { type: 'image/png' })), 20));
    const p1 = hm.push(slow);
    const p2 = hm.push(fakeCanvas());
    await Promise.all([p1, p2]);
    expect(hm.total).toBe(2);
    expect(hm._index[0].size).toBe(10);        // первой лежит запись из промиса
    expect(hm._index[1].size).toBeGreaterThan(100);
  });

  it('параллельные push не теряются', async () => {
    await Promise.all([hm.push(fakeCanvas()), hm.push(fakeCanvas()), hm.push(fakeCanvas())]);
    expect(hm.total).toBe(3);
  });

  it('push после undo отрезает ветку redo', async () => {
    await hm.push(fakeCanvas());
    await hm.push(fakeCanvas());
    await hm.push(fakeCanvas());
    hm._cursor = 0; // эмулируем два undo без декодирования картинок
    hm._notify();
    expect(hm.canRedo).toBe(true);
    await hm.push(fakeCanvas());
    expect(hm.total).toBe(2);
    expect(hm.canRedo).toBe(false);
  });

  it('не превышает maxStates', async () => {
    for (let i = 0; i < hm.maxStates + 3; i++) await hm.push(fakeCanvas());
    expect(hm.total).toBe(hm.maxStates);
  });

  it('onUpdate уведомляет и отписывается', async () => {
    const calls = [];
    const off = hm.onUpdate(s => calls.push(s.total));
    await hm.push(fakeCanvas());
    off();
    await hm.push(fakeCanvas());
    expect(calls).toEqual([1]);
  });

  it('destroy очищает сессию и блокирует push', async () => {
    await hm.push(fakeCanvas());
    await hm.destroy();
    await hm.push(fakeCanvas());
    await tick();
    expect(hm.total).toBe(0);
  });
});
