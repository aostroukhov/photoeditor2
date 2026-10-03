/**
 * Web Worker для тяжёлых попиксельных операций (ретушь, коррекция).
 * Принимает буфер RGBA (transferable), возвращает его же обработанным.
 *
 *   postMessage({ id, op: 'heal'|'adjust', buffer, width, height, params }, [buffer])
 *   → { id, buffer } | { id, error }
 */
import { applyHealingBrush } from './healAlgorithm.js';
import { applyAdjustments }  from './adjustAlgorithm.js';

self.onmessage = (e) => {
  const { id, op, buffer, width, height, params } = e.data;
  try {
    const data = new Uint8ClampedArray(buffer);
    if (op === 'heal') {
      applyHealingBrush(data, width, height, params.strokes, params.opts);
    } else if (op === 'adjust') {
      applyAdjustments({ data, width, height }, params);
    } else {
      throw new Error(`pixelWorker: неизвестная операция ${op}`);
    }
    self.postMessage({ id, buffer: data.buffer }, [data.buffer]);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
