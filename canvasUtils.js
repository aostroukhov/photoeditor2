/**
 * Утилиты для работы с canvas / изображениями.
 * Без зависимостей от PhotoEditor.
 */

/**
 * canvas → Blob. Поддерживает HTMLCanvasElement и OffscreenCanvas.
 * @param {HTMLCanvasElement|OffscreenCanvas} canvas
 * @param {string} [type='image/png']
 * @param {number} [quality]  0..1, только для lossy-форматов
 * @returns {Promise<Blob>}
 */
export async function canvasToBlob(canvas, type = 'image/png', quality) {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    const b = await canvas.convertToBlob({ type, quality });
    if (!b || !b.size) throw new Error('canvasToBlob: пустой blob');
    return b;
  }
  const blob = await new Promise(res => canvas.toBlob(res, type, quality));
  if (!blob || !blob.size) throw new Error('canvasToBlob: браузер вернул пустой blob');
  return blob;
}

/**
 * Загружает изображение по src.
 * @param {string} src
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img   = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error('loadImage: не удалось декодировать изображение'));
    img.src     = src;
  });
}

/**
 * Blob → HTMLImageElement через blob: URL.
 * URL НЕ отзывается — им владеет вызывающий код (PhotoEditor отзывает его,
 * когда изображение перестаёт быть текущим). Chrome не кеширует декодированные
 * пиксели после revokeObjectURL, поэтому отзывать нужно только когда src
 * больше никуда не присваивается.
 *
 * @param {Blob} blob
 * @returns {Promise<{ img: HTMLImageElement, url: string }>}
 */
export async function blobToImage(blob) {
  if (!blob || !blob.size) throw new Error('blobToImage: пустой blob');
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    return { img, url };
  } catch (err) {
    URL.revokeObjectURL(url);
    throw err;
  }
}

/**
 * Рисует изображение на новый canvas натурального размера.
 * @param {HTMLImageElement|ImageBitmap|HTMLCanvasElement} img
 * @returns {HTMLCanvasElement}
 */
export function imageToCanvas(img) {
  const cv  = document.createElement('canvas');
  cv.width  = img.naturalWidth  ?? img.width;
  cv.height = img.naturalHeight ?? img.height;
  cv.getContext('2d').drawImage(img, 0, 0);
  return cv;
}

/**
 * Ждёт, пока <img> будет декодирован (naturalWidth > 0).
 * @param {HTMLImageElement} imgEl
 * @returns {Promise<HTMLImageElement>}
 */
export function waitForImage(imgEl) {
  if (!imgEl) return Promise.reject(new Error('waitForImage: нет элемента'));
  if (imgEl.complete && imgEl.naturalWidth) return Promise.resolve(imgEl);
  return new Promise((resolve, reject) => {
    const done = () => { cleanup(); resolve(imgEl); };
    const fail = () => { cleanup(); reject(new Error('waitForImage: ошибка загрузки')); };
    const cleanup = () => {
      imgEl.removeEventListener('load', done);
      imgEl.removeEventListener('error', fail);
    };
    imgEl.addEventListener('load', done);
    imgEl.addEventListener('error', fail);
  });
}

/**
 * Координаты события → логические координаты canvas (CSS-пиксели области canvas,
 * независимо от devicePixelRatio и CSS-масштаба).
 * @param {HTMLCanvasElement} canvas
 * @param {number} clientX
 * @param {number} clientY
 * @param {number} [logicalW=canvas.clientWidth]
 * @param {number} [logicalH=canvas.clientHeight]
 */
export function clientToLogical(canvas, clientX, clientY, logicalW, logicalH) {
  const r = canvas.getBoundingClientRect();
  const w = logicalW ?? r.width;
  const h = logicalH ?? r.height;
  return {
    x: (clientX - r.left) * (w / (r.width  || 1)),
    y: (clientY - r.top)  * (h / (r.height || 1)),
  };
}

/**
 * Откладывает колбэк на два кадра анимации (браузер завершил layout и paint).
 * @returns {() => void} функция отмены
 */
export function afterRender(cb) {
  let id = requestAnimationFrame(() => { id = requestAnimationFrame(cb); });
  return () => cancelAnimationFrame(id);
}
