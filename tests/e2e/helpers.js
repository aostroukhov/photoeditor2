import { expect } from '@playwright/test';

export const TOOLS = ['heal', 'crop', 'overlay', 'draw', 'mask', 'adjust'];

/** Открывает фикстуру и ждёт полного рендера редактора. */
export async function openEditor(page, query = '') {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const t = m.text();
    // 404 иконочного шрифта oinfo и пресетов ожидаемы в тестовой среде
    if (/Failed to load resource/.test(t)) return;
    errors.push(t);
  });
  await page.goto(`/tests/e2e/fixture.html${query}`);
  await page.waitForFunction(() => window.editorReady === true);
  await expect(page.locator('.photoeditor__container')).toBeVisible();
  return errors;
}

/** Запускает инструмент кнопкой тулбара и ждёт его панель. */
export async function startTool(page, name) {
  await page.click(`[data-tool="${name}"]`);
  await expect(page.locator(`.pe-panel--${name}`)).toBeVisible();
  await page.waitForFunction((n) => window.editor.tools[n].isActive === true, name);
}

/** Overlay-canvas активного инструмента (последний canvas в контейнере изображения). */
export function overlayCanvas(page) {
  return page.locator('.photoeditor__img-container canvas').last();
}

/** Рисует мазок/линию по overlay-canvas в относительных координатах (0..1). */
export async function dragOnCanvas(page, from, to, steps = 12) {
  const box = await overlayCanvas(page).boundingBox();
  const x1 = box.x + box.width * from[0], y1 = box.y + box.height * from[1];
  const x2 = box.x + box.width * to[0],   y2 = box.y + box.height * to[1];
  await page.mouse.move(x1, y1);
  await page.mouse.down();
  await page.mouse.move(x2, y2, { steps });
  await page.mouse.up();
}

export function panelBtn(page, tool, kind) {
  const prefix = tool === 'adjust' ? 'adj' : tool;
  return page.locator(`.${prefix}-panel__btn-${kind}`);
}

export const imgSrc = (page) => page.evaluate(() => window.editor.img?.src ?? null);

export async function waitForImageChange(page, prevSrc) {
  await page.waitForFunction((prev) => window.editor.img && window.editor.img.src !== prev, prevSrc);
}
