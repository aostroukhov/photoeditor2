import { test, expect } from '@playwright/test';
import { openEditor, startTool, dragOnCanvas, panelBtn, imgSrc, waitForImageChange, overlayCanvas } from './helpers.js';

/** Пиксель результата в натуральных координатах (через canvas из editor.img). */
async function pixelAt(page, x, y) {
  return page.evaluate(([x, y]) => {
    const img = window.editor.img;
    const cv = document.createElement('canvas');
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d');
    ctx.drawImage(img, 0, 0);
    return Array.from(ctx.getImageData(x, y, 1, 1).data);
  }, [x, y]);
}

const naturalSize = (page) => page.evaluate(() => [window.editor.img.naturalWidth, window.editor.img.naturalHeight]);

test('Crop: перетаскивание рамки и применение уменьшают изображение', async ({ page }) => {
  await openEditor(page);
  const before = await imgSrc(page);
  await startTool(page, 'crop');
  // Рамка по умолчанию — центральные 4/6; тянем за внутренность, чтобы сдвинуть
  await dragOnCanvas(page, [0.5, 0.5], [0.45, 0.45]);
  await page.locator('.pe-panel--crop [data-action="apply"]').click();
  await waitForImageChange(page, before);
  const [w, h] = await naturalSize(page);
  expect(w).toBeLessThan(800);
  expect(h).toBeLessThan(600);
  expect(w).toBeGreaterThan(400);
  await expect(page.locator('[data-action="undo"]')).toBeEnabled();
});

test('Crop: Enter применяет, рамка сохраняется при переключении инструмента', async ({ page }) => {
  await openEditor(page);
  await startTool(page, 'crop');
  await startTool(page, 'draw');
  expect(await page.evaluate(() => window.editor.tools.crop.naturalCropArea !== null)).toBe(true);
  await startTool(page, 'crop');
  const before = await imgSrc(page);
  await page.keyboard.press('Enter');
  await waitForImageChange(page, before);
  const [w] = await naturalSize(page);
  expect(w).toBeLessThan(800);
});

test('Overlay: добавить текст и применить — изображение меняется, размер прежний', async ({ page }) => {
  await openEditor(page);
  const before = await imgSrc(page);
  await startTool(page, 'overlay');
  await page.locator('.overlay-panel__btn-add-text').click();
  await page.locator('.overlay-panel__text-input').fill('ТЕСТ');
  await panelBtn(page, 'overlay', 'apply').click();
  await waitForImageChange(page, before);
  expect(await naturalSize(page)).toEqual([800, 600]);
  expect(await page.evaluate(() => window.editor.tools.overlay.overlays.length)).toBe(0);
});

test('Overlay: экспорт содержит незакоммиченные оверлеи', async ({ page }) => {
  await openEditor(page);
  await startTool(page, 'overlay');
  await page.locator('.overlay-panel__btn-add-text').click();
  const hasOverlayPixels = await page.evaluate(() => {
    const cv = window.editor.tools.overlay.renderToCanvas();
    const d  = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    // В фикстуре нет чёрного; обводка текста чёрная
    for (let i = 0; i < d.length; i += 4) if (d[i] < 30 && d[i + 1] < 30 && d[i + 2] < 30 && d[i + 3] > 200) return true;
    return false;
  });
  expect(hasOverlayPixels).toBe(true);
});

test('Draw: мазок попадает в результат', async ({ page }) => {
  await openEditor(page);
  const before = await imgSrc(page);
  await startTool(page, 'draw');
  // Горизонтальная линия по белой области (y = 0.9 → натуральный 540)
  await dragOnCanvas(page, [0.1, 0.9], [0.9, 0.9], 20);
  await panelBtn(page, 'draw', 'apply').click();
  await waitForImageChange(page, before);
  const [r, g, b] = await pixelAt(page, 400, 540);
  expect(r).toBeGreaterThan(150);          // цвет по умолчанию #e53935 — красный
  expect(g).toBeLessThan(120);
  expect(b).toBeLessThan(120);
});

test('Mask: область пикселизируется (однородный блок на границе цветов)', async ({ page }) => {
  await openEditor(page);
  const before = await imgSrc(page);
  await startTool(page, 'mask');
  // Область поверх границы синего прямоугольника (x 100..400, y 100..300) и белого фона
  await dragOnCanvas(page, [0.3, 0.1], [0.7, 0.4]);
  await page.evaluate(() => {
    const el = document.querySelector('.mask-panel__block-size');
    el.value = '64'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await panelBtn(page, 'mask', 'apply').click();
  await waitForImageChange(page, before);
  // Внутри блока 64px, накрывающего границу x=400, пиксели по обе стороны одинаковы
  const a = await pixelAt(page, 390, 200);
  const b = await pixelAt(page, 410, 200);
  expect(a).toEqual(b);
});

test('Heal: закрашенная область меняется, остальное — нет', async ({ page }) => {
  await openEditor(page);
  const before = await imgSrc(page);
  await startTool(page, 'heal');
  // Мазок по краю красного круга (центр 600,400 r=120 → край x≈480): берём белый донор
  await dragOnCanvas(page, [0.62, 0.66], [0.66, 0.66], 6);
  await expect(page.locator('.heal-panel__btn-apply')).toBeEnabled();
  await panelBtn(page, 'heal', 'apply').click();
  await waitForImageChange(page, before);
  const untouched = await pixelAt(page, 700, 400);
  expect(untouched.slice(0, 3)).toEqual([229, 57, 53]);   // #e53935 нетронут
});

test('Adjust: экспозиция −100 затемняет весь кадр', async ({ page }) => {
  await openEditor(page);
  const before = await imgSrc(page);
  await startTool(page, 'adjust');
  await page.evaluate(() => {
    const el = document.querySelector('.adj-panel__range[data-param="exposure"]');
    el.value = '-100'; el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  // Превью скрывает оригинал
  await expect(page.locator('.photoeditor__img')).toHaveCSS('opacity', '0');
  await panelBtn(page, 'adjust', 'apply').click();
  await waitForImageChange(page, before);
  await expect(page.locator('.photoeditor__img')).toHaveCSS('opacity', '1');
  const [r] = await pixelAt(page, 50, 50);          // белый фон стал серым
  expect(r).toBeLessThan(200);
  expect(r).toBeGreaterThan(60);
});

test('Adjust: без изменений «Применить» не создаёт состояния истории', async ({ page }) => {
  await openEditor(page);
  await startTool(page, 'adjust');
  await panelBtn(page, 'adjust', 'apply').click();
  await expect(page.locator('.pe-panel--adjust')).toBeHidden();
  await expect(page.locator('[data-action="undo"]')).toBeDisabled();
});

test('overlay-canvas активного инструмента покрывает изображение', async ({ page }) => {
  await openEditor(page);
  await startTool(page, 'draw');
  const img = await page.locator('.photoeditor__img').boundingBox();
  const cv  = await overlayCanvas(page).boundingBox();
  expect(Math.abs(cv.width - img.width)).toBeLessThan(2);
  expect(Math.abs(cv.height - img.height)).toBeLessThan(2);
});
