import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { caption, cleanRoadCarLabel, dataset, restoreEverything, row } from './helpers';

// Этот файл размечает road-car.png, поэтому идёт после 02-trash-api.spec.ts,
// которому нужен кадр без разметки.
test.describe.serial('разметка и корзина (UI)', () => {
  test.beforeEach(async ({ request }) => restoreEverything(request));
  test.afterAll(async () => {
    await cleanRoadCarLabel();
  });

  test('рисование bbox, сохранение, undo/redo и удаление работают из UI', async ({ page }) => {
    await page.goto('/');
    await row(page, 'road-car.png').locator('.image-open').click();
    await expect(caption(page)).toContainText('road-car.png');
    await expect(page.locator('.frame-loading')).toHaveCount(0);

    await page.locator('.class-list button').filter({ hasText: 'car' }).click();
    const canvasBox = (await page.locator('canvas').boundingBox())!;
    const cx = canvasBox.x + canvasBox.width / 2, cy = canvasBox.y + canvasBox.height / 2;
    await page.mouse.move(cx - 60, cy - 60);
    await page.mouse.down();
    await page.mouse.move(cx + 60, cy + 60, { steps: 5 });
    await page.mouse.up();

    await expect(page.locator('.boxes-head small')).toHaveText('1');
    await expect(page.locator('.box-list button')).toContainText('car');
    await expect(page.locator('.save-state')).toContainText('Не сохранено');

    await page.getByRole('button', { name: /Сохранить/ }).click();
    await expect(page.locator('.save-state')).toContainText('Сохранено');
    const labelFile = path.join(dataset, 'train/labels/road-car.txt');
    const savedLines = (await readFile(labelFile, 'utf8')).trim().split('\n');
    expect(savedLines).toHaveLength(1);
    expect(savedLines[0].startsWith('2 ')).toBeTruthy();

    await page.getByTitle('Отменить (Ctrl+Z)').click();
    await expect(page.locator('.empty-boxes')).toBeVisible();
    await page.getByTitle('Повторить (Ctrl+Y)').click();
    await expect(page.locator('.box-list button')).toHaveCount(1);

    await page.locator('.box-list button').click();
    await expect(page.locator('.selection-card')).toBeVisible();
    await page.locator('.selection-card select').selectOption('3');
    await expect(page.locator('.box-list button')).toContainText('truck');

    await page.getByTitle('Удалить').click();
    await expect(page.locator('.empty-boxes')).toBeVisible();
    await page.getByRole('button', { name: /Сохранить/ }).click();
    await expect(page.locator('.save-state')).toContainText('Сохранено');
    expect((await readFile(labelFile, 'utf8')).trim()).toBe('');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'ZIP ↓' }).click();
    expect((await downloadPromise).suggestedFilename()).toBe('road-car.zip');
  });

  test('в UI открывает корзину в read-only, экспортирует и восстанавливает кадр', async ({ page }) => {
    await page.goto('/');
    const foxRow = row(page, 'demo-fox.png');
    await expect(foxRow).toBeVisible();
    await foxRow.getByTitle('Исключить кадр (Ctrl/Cmd+Backspace)').click();

    await page.getByRole('button', { name: 'Исключённые' }).click();
    const excludedRow = row(page, 'demo-fox.png');
    await expect(excludedRow).toBeVisible();
    await excludedRow.locator('.image-open').click();
    await expect(page.getByRole('button', { name: /Сохранить/ })).toBeDisabled();
    await expect(page.getByTitle('Отменить (Ctrl+Z)')).toBeDisabled();
    await expect(page.getByTitle('Повторить (Ctrl+Y)')).toBeDisabled();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'ZIP ↓' }).click();
    expect((await downloadPromise).suggestedFilename()).toBe('demo-fox.zip');

    await excludedRow.getByTitle('Вернуть кадр (Ctrl/Cmd+Backspace)').click();
    await expect(row(page, 'demo-fox.png')).toHaveCount(0);
  });
});
