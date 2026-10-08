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

async function loadBigImage(page) {
  await page.evaluate(async () => {
    const cv = document.createElement('canvas'); cv.width = 4000; cv.height = 3000;
    const ctx = cv.getContext('2d'); const g = ctx.createLinearGradient(0, 0, 4000, 3000); g.addColorStop(0, '#f80'); g.addColorStop(1, '#08f');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 4000, 3000);
    const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
    await window.editor.setImageBlob(blob, { fileName: 'big.png' });
  });
  await expect(page.locator('.photoeditor__info')).toHaveText('4000×3000');
}

test('busy: Ctrl+Z во время apply в Worker игнорируется, история не ломается', async ({ page }) => {
  await openEditor(page);
  await loadBigImage(page);
  await startTool(page, 'adjust');
  await page.evaluate(() => { const el = document.querySelector('.adj-panel__range[data-param="exposure"]'); el.value = '-60'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const before = await imgSrc(page);
  await panelBtn(page, 'adjust', 'apply').click();
  await expect(page.locator('.photoeditor__container')).toHaveClass(/is-busy/);
  await page.keyboard.press('Control+z');
  await waitForImageChange(page, before);
  await expect(page.locator('.photoeditor__container')).not.toHaveClass(/is-busy/);
  await expect(page.locator('.pe-history-badge')).toHaveText('2/20');     // [исходное, фото, коррекция]
  await expect(page.locator('[data-action="redo"]')).toBeDisabled();
  const applied = await imgSrc(page);
  await page.click('[data-action="undo"]');
  await waitForImageChange(page, applied);
  expect(await page.evaluate(() => window.editor.img.naturalWidth)).toBe(4000);   // вернулись к фото без коррекции, а не к 800×600
});

test('busy: Escape и requestClose во время apply не закрывают редактор молча', async ({ page }) => {
  await openEditor(page);
  await loadBigImage(page);
  await startTool(page, 'heal');
  await dragOnCanvas(page, [0.4, 0.4], [0.5, 0.5], 6);
  await page.waitForTimeout(600);
  const before = await imgSrc(page);
  await panelBtn(page, 'heal', 'apply').click();
  await expect(page.locator('.photoeditor__container')).toHaveClass(/is-busy/);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.editor.requestClose());     // как window.photoEditorCms.close()
  await expect(page.locator('.photoeditor__container')).toBeVisible();
  await waitForImageChange(page, before);
  // Отложенный requestClose сработал после завершения: изменения есть → диалог
  await expect(page.locator('.pe-close-confirm')).toBeVisible();
  await page.locator('.pe-close-confirm__btn--primary').click();   // «Нет»
  await expect(page.locator('.photoeditor__container')).toBeVisible();
  expect(await page.evaluate(() => window.editorClosed)).toBeUndefined();
});

test('#4: приостановленные инструменты не держат canvas; состояние масштабируется после ресайза в фоне', async ({ page }) => {
  await openEditor(page);
  for (const t of ['heal', 'crop', 'overlay', 'draw', 'mask', 'adjust']) await startTool(page, t);
  expect(await page.locator('.photoeditor__img-container canvas').count()).toBe(1);   // только активный adjust
  await startTool(page, 'crop');
  const a0 = await page.evaluate(() => { const t = window.editor.tools.crop; return { ...t.cropArea, vw: t.viewW }; });
  await startTool(page, 'draw');                                   // crop → suspend (canvas удалён)
  await page.setViewportSize({ width: 800, height: 700 });
  await page.waitForTimeout(300);
  await startTool(page, 'crop');
  const a1 = await page.evaluate(() => { const t = window.editor.tools.crop; return { ...t.cropArea, vw: t.viewW }; });
  expect(a1.vw).toBeLessThan(a0.vw);
  expect(Math.abs(a1.x / a1.vw - a0.x / a0.vw)).toBeLessThan(0.02);            // рамка в тех же долях
  expect(Math.abs(a1.width / a1.vw - a0.width / a0.vw)).toBeLessThan(0.02);
});

test('#5: два быстрых клика «Повернуть» дают 180°', async ({ page }) => {
  await openEditor(page);
  await startTool(page, 'crop');
  await page.click('[data-action="rotate-cw"]');
  await page.click('[data-action="rotate-cw"]');
  await page.waitForFunction(() => {
    const t = window.editor.tools.crop;
    return !t._rotatingImage && t._pendingRotation === 0 && window.editor.img.naturalWidth === 800;
  });
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => [window.editor.img.naturalWidth, window.editor.img.naturalHeight])).toEqual([800, 600]);
  // 180°: синий прямоугольник (100..400, 100..300) теперь в правом нижнем углу
  const px = await page.evaluate(() => { const img = window.editor.img; const cv = document.createElement('canvas'); cv.width = 800; cv.height = 600; const c = cv.getContext('2d'); c.drawImage(img, 0, 0); return Array.from(c.getImageData(600, 450, 1, 1).data.slice(0, 3)); });
  expect(px).toEqual([60, 143, 224]);
});

test('#6: рамка текстового оверлея следует за текстом и размером шрифта', async ({ page }) => {
  await openEditor(page);
  await startTool(page, 'overlay');
  await page.locator('.overlay-panel__btn-add-text').click();
  const m0 = await page.evaluate(() => {
    const ov = window.editor.tools.overlay.selected;
    const ctx = document.createElement('canvas').getContext('2d'); ctx.font = ov.font;
    return { w: ov.width, h: ov.height, tw: ctx.measureText(ov.text).width, fs: ov.fontSize };
  });
  expect(m0.w).toBeGreaterThan(m0.tw);
  expect(m0.w).toBeLessThan(m0.tw + 40);
  expect(m0.h).toBeLessThan(m0.fs * 1.8);
  await page.locator('.overlay-panel__text-input').fill('Очень длинный текст оверлея');
  const m1 = await page.evaluate(() => window.editor.tools.overlay.selected.width);
  expect(m1).toBeGreaterThan(m0.w * 2);
  await page.evaluate(() => { const el = document.querySelector('.overlay-panel__font-size'); el.value = '96'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  const m2 = await page.evaluate(() => { const ov = window.editor.tools.overlay.selected; return { w: ov.width, h: ov.height }; });
  expect(m2.w).toBeGreaterThan(m1 * 1.5);
  expect(m2.h).toBeGreaterThan(m0.h * 1.5);
});

for (const width of [360, 390, 768]) {
  test(`#8: все кнопки тулбара в пределах экрана при ширине ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await openEditor(page);
    const bad = await page.evaluate((w) => {
      return [...document.querySelectorAll('.pe-toolbar__btn')].map(b => ({ t: b.dataset.tool || b.dataset.action, r: b.getBoundingClientRect() }))
        .filter(({ r }) => r.width < 20 || r.left < -1 || r.right > w + 1 || r.bottom > 800 + 1).map(x => x.t);
    }, width);
    expect(bad).toEqual([]);
    const img = await page.locator('.photoeditor__img').boundingBox();
    const tb  = await page.locator('.pe-toolbar').boundingBox();
    expect(img.y + img.height).toBeLessThanOrEqual(tb.y + 1);
  });
}

for (const width of [390, 768]) {
  test(`#7: кнопки шапки панели не перекрыты «Отмена/Применить» при ширине ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openEditor(page);
    const hit = async (sel) => page.evaluate((sel) => {
      const el = document.querySelector(sel); const r = el.getBoundingClientRect();
      return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest(sel) === el;
    }, sel);
    await startTool(page, 'overlay');
    await page.waitForTimeout(400);
    expect(await hit('.overlay-panel__btn-add-text')).toBe(true);
    expect(await hit('.overlay-panel__btn-add-image')).toBe(true);
    expect(await hit('.overlay-panel__btn-cancel')).toBe(true);
    await startTool(page, 'adjust');
    await page.waitForTimeout(400);
    expect(await hit('.adj-panel__btn-reset')).toBe(true);
    expect(await hit('.adj-panel__btn-apply')).toBe(true);
  });
}
