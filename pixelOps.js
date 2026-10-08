/**
 * Запуск попиксельных операций вне главного потока.
 *
 * runPixelOp(op, imageData, params) → Promise<ImageData>
 *
 * Использует module-Worker (pixelWorker.js); если Worker недоступен или
 * падает при создании (старый браузер, CSP без worker-src, file://) —
 * выполняет операцию на главном потоке. Буфер передаётся transferable:
 * копирования пикселей нет, imageData после вызова использовать нельзя.
 */
import { applyHealingBrush } from './healAlgorithm.js';
import { applyAdjustments }  from './adjustAlgorithm.js';

let worker       = null;
let workerBroken = false;
let seq          = 0;
const pending    = new Map();   // id → { resolve, reject, width, height }

function getWorker() {
  if (worker || workerBroken) return worker;
  if (typeof Worker === 'undefined') { workerBroken = true; return null; }
  try {
    worker = new Worker(new URL('./pixelWorker.js', import.meta.url), { type: 'module' });
  } catch (err) {
    console.warn('[pixelOps] Worker недоступен, операции пойдут на главном потоке:', err?.message);
    workerBroken = true;
    return null;
  }
  worker.onmessage = (e) => {
    const { id, buffer, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(new ImageData(new Uint8ClampedArray(buffer), p.width, p.height));
  };
  worker.onerror = (ev) => {
    // Worker не поднялся (например, CSP) — все ожидающие уходят в фоллбэк
    console.warn('[pixelOps] ошибка Worker, переключаемся на главный поток:', ev?.message);
    workerBroken = true;
    const list = [...pending.values()];
    pending.clear();
    worker?.terminate(); worker = null;
    for (const p of list) p.reject(new Error('worker-failed'));
  };
  return worker;
}

function runOnMainThread(op, imageData, params) {
  if (op === 'heal')        applyHealingBrush(imageData.data, imageData.width, imageData.height, params.strokes, params.opts);
  else if (op === 'adjust') applyAdjustments(imageData, params);
  else throw new Error(`pixelOps: неизвестная операция ${op}`);
  return imageData;
}

/**
 * @param {'heal'|'adjust'} op
 * @param {ImageData} imageData  — буфер будет передан в Worker (станет недоступен)
 * @param {object} params
 * @returns {Promise<ImageData>}
 */
export function runPixelOp(op, imageData, params) {
  const w = getWorker();
  if (!w) return Promise.resolve(runOnMainThread(op, imageData, params));

  const { width, height } = imageData;
  // Копия параметров без ссылок на DOM/функции (structured clone)
  const safeParams = JSON.parse(JSON.stringify(params));
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, width, height });
    try {
      w.postMessage({ id, op, buffer: imageData.data.buffer, width, height, params: safeParams }, [imageData.data.buffer]);
    } catch (err) {
      pending.delete(id);
      reject(err);
    }
  }).catch((err) => {
    if (err?.message !== 'worker-failed') throw err;
    // Буфер уже передан — пересобрать нельзя; вызывающий код повторит на главном потоке
    throw new Error('worker-failed');
  });
}

/**
 * Удобная обёртка: выполняет операцию, при падении Worker повторяет на главном
 * потоке по копии исходных данных.
 * @param {'heal'|'adjust'} op
 * @param {ImageData} imageData  — не изменяется
 * @param {object} params
 */
export async function runPixelOpSafe(op, imageData, params) {
  const copy = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
  try {
    return await runPixelOp(op, copy, params);
  } catch (err) {
    if (err?.message !== 'worker-failed') throw err;
    const again = new ImageData(new Uint8ClampedArray(imageData.data), imageData.width, imageData.height);
    return runOnMainThread(op, again, params);
  }
}
