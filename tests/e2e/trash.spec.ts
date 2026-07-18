import { expect, test, type APIRequestContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import { access, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

const dataset = path.resolve('demo-dataset');

type ImageItem = { id: string; name: string; excluded: boolean; index: number };
type Project = { classes: string[]; images: ImageItem[]; annotatedCount: number; activeImages: number; excludedCount: number };

async function project(request: APIRequestContext, status = 'active', query = '', classIds: number[] = []) {
  const response = await request.get('/__boxscribe/project', { params: { limit: 200, status, query, classIds: classIds.join(',') } });
  expect(response.ok()).toBeTruthy();
  return await response.json() as Project;
}

async function setExcluded(request: APIRequestContext, image: ImageItem, excluded: boolean, scope: { status?: string; query?: string; classIds?: number[] } = {}) {
  const response = await request.put('/__boxscribe/exclude', {
    params: { id: image.id },
    data: { excluded, currentId: image.id, status: scope.status ?? (excluded ? 'active' : 'excluded'), query: scope.query ?? '', classIds: scope.classIds ?? [] }
  });
  expect(response.ok()).toBeTruthy();
  return await response.json() as { image: ImageItem; nextImage: ImageItem | null; annotatedCount: number };
}

async function restoreEverything(request: APIRequestContext) {
  for (const image of (await project(request, 'excluded')).images) await setExcluded(request, image, false);
}

test.describe.serial('виртуальная корзина', () => {
  test.beforeEach(async ({ request }) => restoreEverything(request));
  test.afterAll(async ({ request }) => {
    try { await restoreEverything(request); } catch { /* another server may have completed the final restore */ }
    await unlink(path.join(dataset, 'train/labels/road-car.txt')).catch(() => undefined);
  });

  test('использует стабильные ID и не переиспользует URL другого изображения', async ({ request }) => {
    const before = await project(request);
    const [removed, next] = before.images;
    const removedBytes = await (await request.get('/__boxscribe/image', { params: { id: removed.id } })).body();

    const result = await setExcluded(request, removed, true);
    const after = await project(request);

    expect(result.nextImage?.id).toBe(next.id);
    expect(after.images[0].id).toBe(next.id);
    expect(after.images[0].id).not.toBe(removed.id);
    expect(await (await request.get('/__boxscribe/image', { params: { id: removed.id } })).body()).toEqual(removedBytes);
  });

  test('переносит paired TXT вместе с изображением и возвращает оба файла', async ({ request }) => {
    const image = (await project(request)).images.find((item) => item.name === 'demo-fox.png')!;
    await setExcluded(request, image, true);

    await expect(access(path.join(dataset, '.boxscribe/excluded/train/images/demo-fox.png'))).resolves.toBeUndefined();
    await expect(access(path.join(dataset, '.boxscribe/excluded/train/labels/demo-fox.txt'))).resolves.toBeUndefined();
    await expect(access(path.join(dataset, 'train/images/demo-fox.png'))).rejects.toThrow();

    const excluded = (await project(request, 'excluded')).images.find((item) => item.name === 'demo-fox.png')!;
    await setExcluded(request, excluded, false);
    await expect(access(path.join(dataset, 'train/images/demo-fox.png'))).resolves.toBeUndefined();
    await expect(access(path.join(dataset, 'train/labels/demo-fox.txt'))).resolves.toBeUndefined();
  });

  test('возвращает adjacent TXT точно на исходное место', async ({ request }) => {
    const original = path.join(dataset, 'train/images/demo-bird.txt');
    const originalText = await readFile(original, 'utf8');
    const image = (await project(request)).images.find((item) => item.name === 'demo-bird.png')!;

    await setExcluded(request, image, true);
    await expect(access(original)).rejects.toThrow();
    await expect(access(path.join(dataset, '.boxscribe/excluded/train/images/demo-bird.txt'))).resolves.toBeUndefined();

    const excluded = (await project(request, 'excluded')).images.find((item) => item.name === image.name)!;
    await setExcluded(request, excluded, false);
    expect(await readFile(original, 'utf8')).toBe(originalText);
    await expect(access(path.join(dataset, 'train/labels/demo-bird.txt'))).rejects.toThrow();
  });

  test('выбирает следующий кадр внутри текущего поиска', async ({ request }) => {
    const roadFrames = await project(request, 'active', 'road');
    expect(new Set(roadFrames.images.map(({ name }) => name))).toEqual(new Set(['road-car.png', 'road-car-truck.png']));

    const result = await setExcluded(request, roadFrames.images[0], true, { query: 'road' });
    expect(result.nextImage?.name).toBe(roadFrames.images[1].name);
  });

  test('учитывает AND-фильтр по нескольким классам при переносе', async ({ request }) => {
    const carsAndTrucks = await project(request, 'active', '', [2, 3]);
    expect(carsAndTrucks.classes).toEqual(['fox', 'bird', 'car', 'truck', 'person']);
    expect(carsAndTrucks.images.map(({ name }) => name)).toEqual(['road-car-truck.png']);

    const result = await setExcluded(request, carsAndTrucks.images[0], true, { classIds: [2, 3] });
    expect(result.nextImage).toBeNull();
    expect((await project(request, 'active', '', [2, 3])).images).toHaveLength(0);
  });

  test('сразу обновляет annotatedCount при первом сохранении', async ({ request }) => {
    const before = await project(request);
    const image = before.images.find((item) => item.name === 'road-car.png')!;
    const response = await request.put('/__boxscribe/annotations', { params: { id: image.id }, data: { boxes: [] } });
    expect(response.ok()).toBeTruthy();

    const after = await project(request);
    expect(after.annotatedCount).toBe(before.annotatedCount + 1);
    await setExcluded(request, image, true);
    const excluded = (await project(request, 'excluded')).images.find((item) => item.name === image.name)!;
    await setExcluded(request, excluded, false);
    expect((await project(request)).annotatedCount).toBe(after.annotatedCount);
  });

  test('в UI открывает корзину в read-only, экспортирует и восстанавливает кадр', async ({ page }) => {
    await page.goto('/');
    const row = page.locator('.image-row').filter({ hasText: 'demo-fox.png' });
    await expect(row).toBeVisible();
    await row.getByTitle('Исключить кадр (Ctrl/Cmd+Backspace)').click();

    await page.getByRole('button', { name: 'Исключённые' }).click();
    const excludedRow = page.locator('.image-row').filter({ hasText: 'demo-fox.png' });
    await expect(excludedRow).toBeVisible();
    await excludedRow.locator('.image-open').click();
    await expect(page.getByRole('button', { name: /Сохранить/ })).toBeDisabled();

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'ZIP ↓' }).click();
    expect((await downloadPromise).suggestedFilename()).toBe('demo-fox.zip');

    await excludedRow.getByTitle('Вернуть кадр (Ctrl/Cmd+Backspace)').click();
    await expect(page.locator('.image-row').filter({ hasText: 'demo-fox.png' })).toHaveCount(0);
  });

  test('восстанавливает исходный adjacent TXT после перезапуска сервера', async ({ request }) => {
    const image = (await project(request)).images.find((item) => item.name === 'demo-bird.png')!;
    await setExcluded(request, image, true);

    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4174', '--strictPort'], {
      cwd: path.resolve('.'),
      env: { ...process.env, BOXSCRIBE_DATASET_DIR: dataset },
      stdio: 'ignore'
    });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 50 && !ready; attempt++) {
        try { ready = (await fetch('http://127.0.0.1:4174/__boxscribe/project?status=excluded')).ok; }
        catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
      }
      expect(ready).toBeTruthy();
      const trash = await fetch('http://127.0.0.1:4174/__boxscribe/project?status=excluded').then((response) => response.json()) as Project;
      const restartedRecord = trash.images.find((item) => item.name === image.name)!;
      const response = await fetch(`http://127.0.0.1:4174/__boxscribe/exclude?id=${encodeURIComponent(restartedRecord.id)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ excluded: false, currentId: restartedRecord.id, status: 'excluded' })
      });
      expect(response.ok).toBeTruthy();
      await expect(access(path.join(dataset, 'train/images/demo-bird.txt'))).resolves.toBeUndefined();
      await expect(access(path.join(dataset, 'train/labels/demo-bird.txt'))).rejects.toThrow();
    } finally {
      server.kill('SIGTERM');
    }
  });
});
