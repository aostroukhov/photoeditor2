/**
 * Запуск попиксельных операций вне главного потока.
 *
 *   processImage(op, source, params) → Promise<Blob>
 *
 * source:
 *   { blob, image? }            — закодированное изображение (см. PhotoEditor.getImageBlob):
 *                                 createImageBitmap(Blob) декодирует вне главного потока, дальше
 *                                 всё в Worker: пиксели, алгоритм, PNG-кодирование. Предпочтительно;
 *   { image }                   — HTMLImageElement/ImageBitmap/canvas: createImageBitmap(<img>)
 *                                 в Chrome декодирует синхронно (~300 мс на 24 Мп), поэтому
 *                                 используется только когда Blob недоступен;
 *   { imageData, onRetry? }     — готовые пиксели (буфер передаётся transferable и становится
 *                                 недоступен); onRetry() возвращает свежий ImageData, если
 *                                 Worker упал и операцию надо повторить на главном потоке.
 *
 * Если Worker недоступен (старый браузер, CSP без worker-src) или в нём нет
 * OffscreenCanvas — операция выполняется на главном потоке (как в 3.6).
 */
import { applyHealingBrush } from './healAlgorithm.js';
import { applyAdjustments }  from './adjustAlgorithm.js';
import { canvasToBlob, blobToImage } from './canvasUtils.js';

let worker       = null;
let workerBroken = false;
let seq          = 0;
const pending    = new Map();   // id → { resolve, reject }

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
    const { id, error } = e.data;
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (error) p.reject(new Error(error));
    else p.resolve(e.data);
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

/** Источник для рисования на canvas: image, а если его нет — декодированный blob. */
async function sourceImage(source) {
  if (source.image) return source.image;
  if (!(source.blob instanceof Blob)) return null;
  const { img, url } = await blobToImage(source.blob);
  URL.revokeObjectURL(url);          // img уже декодирован, URL больше не нужен
  return img;
}

function imageToImageData(image) {
  const w = image.naturalWidth ?? image.width, h = image.naturalHeight ?? image.height;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  return ctx.getImageData(0, 0, w, h);
}

async function imageDataToBlob(imageData, type = 'image/png') {
  const cv = document.createElement('canvas');
  cv.width = imageData.width; cv.height = imageData.height;
  cv.getContext('2d').putImageData(imageData, 0, 0);
  return canvasToBlob(cv, type);
}

/** Отправляет задание в Worker; resolve → ответ { blob } или { buffer, width, height }. */
function postToWorker(w, message, transfer) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    try { w.postMessage({ id, ...message }, transfer); }
    catch (err) { pending.delete(id); reject(err); }
  });
}

/**
 * @param {'heal'|'adjust'} op
 * @param {{ blob?: Blob, image?: CanvasImageSource, imageData?: ImageData, onRetry?: () => ImageData }} source
 * @param {object} params
 * @param {string} [type='image/png']  формат результата
 * @returns {Promise<Blob>}
 */
export async function processImage(op, source, params, type = 'image/png') {
  const safeParams = JSON.parse(JSON.stringify(params));   // без ссылок на DOM/функции
  const w = getWorker();

  if (w) {
    try {
      let reply;
      const bitmapSrc = source.blob instanceof Blob ? source.blob : source.image;
      if (bitmapSrc && typeof createImageBitmap !== 'undefined') {
        const bitmap = await createImageBitmap(bitmapSrc);
        reply = await postToWorker(w, { op, params: safeParams, bitmap, encode: type }, [bitmap]);
      } else {
        const imageData = source.imageData ?? imageToImageData(await sourceImage(source));
        const { width, height } = imageData;
        reply = await postToWorker(w, { op, params: safeParams, buffer: imageData.data.buffer, width, height, encode: type },
                                   [imageData.data.buffer]);
      }
      if (reply.blob) return reply.blob;
      // Worker без OffscreenCanvas вернул пиксели — кодируем здесь
      return imageDataToBlob(new ImageData(new Uint8ClampedArray(reply.buffer), reply.width, reply.height), type);
    } catch (err) {
      if (err?.message !== 'worker-failed') throw err;
      // падение Worker — ниже повторяем на главном потоке
    }
  }

  const img = await sourceImage(source);
  const imageData = img ? imageToImageData(img)
    : (source.onRetry ? source.onRetry() : source.imageData);
  if (!imageData) throw new Error('pixelOps: нет данных для повтора на главном потоке');
  return imageDataToBlob(runOnMainThread(op, imageData, safeParams), type);
}
