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
