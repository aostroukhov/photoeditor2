import { test, expect } from '@playwright/test';
import { openEditor, startTool, panelBtn, TOOLS } from './helpers.js';

test('редактор открывается со всеми кнопками тулбара и без ошибок', async ({ page }) => {
  const errors = await openEditor(page);
  for (const t of TOOLS) await expect(page.locator(`[data-tool="${t}"]`)).toBeVisible();
  await expect(page.locator('[data-action="undo"]')).toBeDisabled();
  await expect(page.locator('[data-action="redo"]')).toBeDisabled();
  await expect(page.locator('.photoeditor__info')).toHaveText('800×600');
  expect(errors).toEqual([]);
});

for (const tool of TOOLS) {
  test(`инструмент ${tool}: старт → отмена без ошибок`, async ({ page }) => {
    const errors = await openEditor(page);
    await startTool(page, tool);
    if (tool === 'crop') {
      await page.keyboard.press('Escape');
    } else {
      await panelBtn(page, tool, 'cancel').click();
    }
    await expect(page.locator(`.pe-panel--${tool}`)).toBeHidden();
    await expect(page.locator('.photoeditor__container')).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test('переключение между инструментами приостанавливает предыдущий', async ({ page }) => {
  await openEditor(page);
  await startTool(page, 'draw');
  await startTool(page, 'mask');
  const state = await page.evaluate(() => ({
    draw: window.editor.tools.draw.isSuspended,
    mask: window.editor.tools.mask.isActive,
    active: window.editor.activeTool === window.editor.tools.mask,
  }));
  expect(state).toEqual({ draw: true, mask: true, active: true });
});

test('закрытие без изменений не спрашивает подтверждения', async ({ page }) => {
  await openEditor(page);
  await page.click('[data-action="close"]');
  await page.waitForFunction(() => window.editorClosed === true);
  await expect(page.locator('.photoeditor__container')).toHaveCount(0);
});
