/**
 * Web Worker для тяжёлых попиксельных операций (ретушь, коррекция).
 *
 * Вход (transferable):
 *   { id, op: 'heal'|'adjust', params, width, height,
 *     bitmap?: ImageBitmap        — исходник как битмап (декодирован вне главного потока), либо
 *     buffer?: ArrayBuffer        — RGBA-пиксели,
 *     encode?: 'image/png' }      — вернуть готовый Blob (OffscreenCanvas.convertToBlob)
 * Выход:
 *   { id, blob }   — если encode задан и OffscreenCanvas доступен,
 *   { id, buffer } — иначе (transferable),
 *   { id, error }.
 *
 * Таким образом на главном потоке не остаётся ни getImageData/putImageData,
 * ни PNG-кодирования полного кадра (issue #11).
 */
import { applyHealingBrush } from './healAlgorithm.js';
import { applyAdjustments }  from './adjustAlgorithm.js';

const hasOffscreen = typeof OffscreenCanvas !== 'undefined';

self.onmessage = async (e) => {
  const { id, op, params, encode, bitmap, buffer } = e.data;
  let { width, height } = e.data;
  try {
    let oc = null, ctx = null, data;

    if (bitmap) {
      if (!hasOffscreen) throw new Error('pixelWorker: OffscreenCanvas недоступен для ImageBitmap');
      width = bitmap.width; height = bitmap.height;
      oc  = new OffscreenCanvas(width, height);
      ctx = oc.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      data = ctx.getImageData(0, 0, width, height).data;
    } else {
      data = new Uint8ClampedArray(buffer);
    }

    if (op === 'heal')        applyHealingBrush(data, width, height, params.strokes, params.opts);
    else if (op === 'adjust') applyAdjustments({ data, width, height }, params);
    else throw new Error(`pixelWorker: неизвестная операция ${op}`);

    if (encode && hasOffscreen) {
      if (!oc) { oc = new OffscreenCanvas(width, height); ctx = oc.getContext('2d'); }
      ctx.putImageData(new ImageData(data, width, height), 0, 0);
      const blob = await oc.convertToBlob({ type: encode });
      self.postMessage({ id, blob });
    } else {
      self.postMessage({ id, buffer: data.buffer, width, height }, [data.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
