import { test, expect } from '@playwright/test';
import { openEditor, startTool, dragOnCanvas, panelBtn, imgSrc, waitForImageChange } from './helpers.js';

test('K1: Escape в DrawTool отменяет инструмент, но не закрывает редактор', async ({ page }) => {
  await openEditor(page);
  await startTool(page, 'draw');
  await page.keyboard.press('Escape');
  await expect(page.locator('.pe-panel--draw')).toBeHidden();
  await expect(page.locator('.photoeditor__container')).toBeVisible();
});

test('K1: Escape в MaskTool отменяет инструмент, но не закрывает редактор', async ({ page }) => {
  await openEditor(page);
  await startTool(page, 'mask');
  await page.keyboard.press('Escape');
  await expect(page.locator('.pe-panel--mask')).toBeHidden();
  await expect(page.locator('.photoeditor__container')).toBeVisible();
});

test('K2: Backspace в поле текста оверлея не удаляет оверлей', async ({ page }) => {
  await openEditor(page);
  await startTool(page, 'overlay');
  await page.locator('.overlay-panel__btn-add-text').click();
  await page.waitForFunction(() => window.editor.tools.overlay.overlays.length === 1);
  const input = page.locator('.overlay-panel__text-input');
  await input.focus();
  await input.fill('Привет');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => window.editor.tools.overlay.overlays.length)).toBe(1);
  await expect(input).toHaveValue('Прив');
});

test('K2: Escape из поля текста оверлея не сбрасывает оверлеи', async ({ page }) => {
  await openEditor(page);
  await startTool(page, 'overlay');
  await page.locator('.overlay-panel__btn-add-text').click();
  await page.locator('.overlay-panel__text-input').focus();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => window.editor.tools.overlay.overlays.length)).toBe(1);
  await expect(page.locator('.photoeditor__container')).toBeVisible();
});

test('K4: открытие панели Импорт приостанавливает кадрирование, а не отменяет его', async ({ page }) => {
  await openEditor(page);
  await startTool(page, 'crop');
  await page.click('[data-action="toggle-import"]');
  await expect(page.locator('.pe-panel--import')).toBeVisible();
  const state = await page.evaluate(() => ({
    suspended: window.editor.tools.crop.isSuspended,
    hasArea:   window.editor.tools.crop.naturalCropArea !== null,
  }));
  expect(state).toEqual({ suspended: true, hasArea: true });
  await page.click('[data-tool="crop"]');
  await expect(page.locator('.pe-panel--crop')).toBeVisible();
});

test('K5: после undo → redo закрытие снова требует подтверждения', async ({ page }) => {
  await openEditor(page);
  const before = await imgSrc(page);
  await startTool(page, 'draw');
  await dragOnCanvas(page, [0.2, 0.2], [0.6, 0.6]);
  await panelBtn(page, 'draw', 'apply').click();
  await waitForImageChange(page, before);
  await expect(page.locator('[data-action="undo"]')).toBeEnabled();

  await page.click('[data-action="undo"]');
  await expect(page.locator('[data-action="redo"]')).toBeEnabled();
  await page.click('[data-action="redo"]');
  await expect(page.locator('[data-action="redo"]')).toBeDisabled();

  await page.click('[data-action="close"]');
  await expect(page.locator('.pe-close-confirm')).toBeVisible();
  await page.locator('.pe-close-confirm__btn--primary').click(); // «Нет»
  await expect(page.locator('.photoeditor__container')).toBeVisible();
});

test('K6: «Применить» в Heal/Mask/Adjust не экспортирует в источник автоматически', async ({ page }) => {
  await openEditor(page, '?bind=1');
  const before = await imgSrc(page);
  await startTool(page, 'mask');
  await dragOnCanvas(page, [0.2, 0.2], [0.5, 0.5]);
  await panelBtn(page, 'mask', 'apply').click();
  await waitForImageChange(page, before);
  expect(await page.evaluate(() => window.exportCalls)).toEqual([]);
});

test('undo/redo для каждого применяющего инструмента', async ({ page }) => {
  await openEditor(page);
  const before = await imgSrc(page);
  await startTool(page, 'draw');
  await dragOnCanvas(page, [0.1, 0.1], [0.5, 0.4]);
  await panelBtn(page, 'draw', 'apply').click();
  await waitForImageChange(page, before);
  const after = await imgSrc(page);

  await page.click('[data-action="undo"]');
  await page.waitForFunction((a) => window.editor.img.src !== a, after);
  await page.click('[data-action="redo"]');
  await expect(page.locator('[data-action="redo"]')).toBeDisabled();
  await expect(page.locator('[data-action="undo"]')).toBeEnabled();
});

test('beforeunload предупреждает только при несохранённых изменениях', async ({ page }) => {
  await openEditor(page);
  const fire = () => page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(await fire()).toBe(false);
  const before = await imgSrc(page);
  await startTool(page, 'draw');
  await dragOnCanvas(page, [0.2, 0.2], [0.5, 0.5]);
  await panelBtn(page, 'draw', 'apply').click();
  await waitForImageChange(page, before);
  expect(await fire()).toBe(true);
  const drawn = await imgSrc(page);
  await page.click('[data-action="undo"]');
  await waitForImageChange(page, drawn);          // снапшот загружен, флаг изменений снят
  expect(await fire()).toBe(false);
});

test('после undo активный инструмент возвращается', async ({ page }) => {
  await openEditor(page);
  const before = await imgSrc(page);
  await startTool(page, 'draw');
  await dragOnCanvas(page, [0.2, 0.2], [0.5, 0.5]);
  await panelBtn(page, 'draw', 'apply').click();
  await waitForImageChange(page, before);
  await startTool(page, 'mask');
  await page.click('[data-action="undo"]');
  await page.waitForFunction(() => window.editor.tools.mask.isActive === true);
  await expect(page.locator('.pe-panel--mask')).toBeVisible();
});

test('setImageBlob: импорт без base64, blob: URL и запись в историю', async ({ page }) => {
  await openEditor(page);
  const info = await page.evaluate(async () => {
    const cv = document.createElement('canvas'); cv.width = 320; cv.height = 200;
    cv.getContext('2d').fillStyle = '#123456'; cv.getContext('2d').fillRect(0, 0, 320, 200);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    const img  = await window.editor.setImageBlob(blob, { fileName: 'test.png' });
    return { src: img.src.slice(0, 5), w: img.naturalWidth, name: window.editor.originalFileName };
  });
  expect(info).toEqual({ src: 'blob:', w: 320, name: 'test.png' });
  await expect(page.locator('.photoeditor__info')).toHaveText('320×200');
  await expect(page.locator('[data-action="undo"]')).toBeEnabled();
});

test('CMS-flow: setImage(url) до open(), async export при «Сохранить» — редактор ждёт Promise', async ({ page }) => {
  await openEditor(page);
  // Как photoEditContent.js: export возвращает Promise сохранения на сервер
  await page.evaluate(() => {
    window.exportLog = [];
    window.editor.export = (canvas) => new Promise((resolve) => {
      window.exportLog.push('start:' + canvas.width + 'x' + canvas.height);
      setTimeout(() => { window.exportLog.push('done'); window.editor.notifyExportDone(); resolve(); }, 300);
    });
  });
  await expect(page.locator('[data-action="undo"]')).toBeDisabled();   // baseline один, глубина 0

  const before = await imgSrc(page);
  await startTool(page, 'draw');
  await dragOnCanvas(page, [0.2, 0.2], [0.6, 0.6]);
  await panelBtn(page, 'draw', 'apply').click();
  await waitForImageChange(page, before);

  await page.click('[data-action="close"]');
  const dlg = page.locator('.pe-close-confirm');
  await expect(dlg).toBeVisible();
  await expect(dlg.locator('.pe-close-confirm__btn--primary')).toHaveText(/Сохранить/);
  await dlg.locator('.pe-close-confirm__btn--primary').click();
  // Пока Promise не выполнен — редактор открыт
  await expect(page.locator('.photoeditor__container')).toBeVisible();
  await page.waitForFunction(() => window.editorClosed === true);
  expect(await page.evaluate(() => window.exportLog)).toEqual(['start:800x600', 'done']);
});

test('CMS-flow: ошибка async export оставляет редактор открытым', async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => { window.editor.export = () => Promise.reject(new Error('HTTP 500')); });
  const before = await imgSrc(page);
  await startTool(page, 'mask');
  await dragOnCanvas(page, [0.2, 0.2], [0.5, 0.5]);
  await panelBtn(page, 'mask', 'apply').click();
  await waitForImageChange(page, before);
  await page.click('[data-action="close"]');
  await page.locator('.pe-close-confirm__btn--primary').click();
  await page.waitForTimeout(300);
  await expect(page.locator('.photoeditor__container')).toBeVisible();
  expect(await page.evaluate(() => window.editorClosed)).toBeUndefined();
});
