import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import { access, readFile, unlink } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
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

const row = (page: Page, name: string) => page.locator('.image-row').filter({ hasText: name });
const caption = (page: Page) => page.locator('.top-image-caption');
const frameInput = (page: Page) => page.getByLabel('Перейти к номеру кадра');

function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

test.describe.serial('виртуальная корзина', () => {
  test.beforeAll(async () => {
    // A crashed previous run may have left this label behind; drop it before the
    // first request builds the server's in-memory index.
    await unlink(path.join(dataset, 'train/labels/road-car.txt')).catch(() => undefined);
  });
  test.beforeEach(async ({ request }) => restoreEverything(request));
  test.afterAll(async ({ request }) => {
    try { await restoreEverything(request); } catch { /* another server may have completed the final restore */ }
    await unlink(path.join(dataset, 'train/labels/road-car.txt')).catch(() => undefined);
  });

  test('canvas занимает всю рабочую область при изменении viewport', async ({ page }) => {
    await page.goto('/');
    for (const viewport of [{ width: 960, height: 600 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
      await page.setViewportSize(viewport);
      const geometry = await page.locator('.canvas-host canvas').evaluate((canvas: HTMLCanvasElement) => {
        const workspace = document.querySelector<HTMLElement>('.workspace')!.getBoundingClientRect();
        const host = document.querySelector<HTMLElement>('.canvas-host')!.getBoundingClientRect();
        const rect = canvas.getBoundingClientRect();
        return {
          workspace: { x: workspace.x, y: workspace.y, width: workspace.width, height: workspace.height },
          host: { x: host.x, y: host.y, width: host.width, height: host.height },
          canvas: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          bitmap: { width: canvas.width, height: canvas.height },
          dpr: window.devicePixelRatio || 1
        };
      });
      expect(geometry.host).toEqual(geometry.workspace);
      expect(geometry.canvas).toEqual(geometry.workspace);
      await expect.poll(() => page.locator('.canvas-host canvas').evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]))
        .toEqual([Math.round(geometry.canvas.width * geometry.dpr), Math.round(geometry.canvas.height * geometry.dpr)]);
    }
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

  test('кнопки статусов и поиск фильтруют список кадров', async ({ page }) => {
    await page.goto('/');
    await expect(caption(page)).toContainText('crowd-person.png');

    await page.getByRole('button', { name: 'Новые' }).click();
    await expect(row(page, 'road-car.png')).toBeVisible();
    await expect(row(page, 'demo-fox.png')).toHaveCount(0);

    await page.getByRole('button', { name: 'Готово' }).click();
    await expect(row(page, 'demo-fox.png')).toBeVisible();
    await expect(row(page, 'road-car.png')).toHaveCount(0);

    await page.getByRole('button', { name: 'Пустые' }).click();
    await expect(row(page, 'demo-fox.png')).toHaveCount(0);
    await expect(row(page, 'crowd-person.png')).toBeVisible();

    await page.getByRole('button', { name: 'Все', exact: true }).click();
    await expect(page.locator('.image-row')).toHaveCount(5);

    await page.locator('.search input').fill('fox');
    await expect(page.locator('.image-row')).toHaveCount(1);
    await expect(row(page, 'demo-fox.png')).toBeVisible();
    await expect(caption(page)).toContainText('demo-fox.png');

    await page.locator('.search input').fill('');
    await expect(page.locator('.image-row')).toHaveCount(5);
  });

  test('фильтры классов работают как AND и сбрасываются кнопкой «Любой»', async ({ page }) => {
    await page.goto('/');
    await expect(caption(page)).toContainText('crowd-person.png');

    await page.getByRole('button', { name: 'car', exact: true }).click();
    await expect(page.locator('.image-row')).toHaveCount(1);
    await expect(row(page, 'road-car-truck.png')).toBeVisible();
    await expect(page.locator('.status-locked')).toContainText('С разметкой');

    await page.getByRole('button', { name: 'truck', exact: true }).click();
    await expect(row(page, 'road-car-truck.png')).toBeVisible();

    await page.getByRole('button', { name: 'person', exact: true }).click();
    await expect(page.locator('.no-results')).toBeVisible();

    await page.getByRole('button', { name: 'Любой' }).click();
    await expect(page.locator('.image-row')).toHaveCount(5);
    await expect(page.getByRole('button', { name: 'Новые' })).toBeVisible();
  });

  test('стрелки, счётчик кадров и клавиши A/D переключают кадры', async ({ page }) => {
    await page.goto('/');
    await expect(caption(page)).toContainText('crowd-person.png');
    const previous = page.locator('.nav-controls button').first();
    const next = page.locator('.nav-controls button').last();

    await expect(previous).toBeDisabled();
    await next.click();
    await expect(caption(page)).toContainText('demo-bird.png');
    await expect(frameInput(page)).toHaveValue('2');
    await previous.click();
    await expect(caption(page)).toContainText('crowd-person.png');
    await expect(previous).toBeDisabled();

    await page.keyboard.press('d');
    await expect(caption(page)).toContainText('demo-bird.png');
    await page.keyboard.press('a');
    await expect(caption(page)).toContainText('crowd-person.png');

    await frameInput(page).fill('5');
    await frameInput(page).press('Enter');
    await expect(caption(page)).toContainText('road-car.png');
    await expect(next).toBeDisabled();

    await frameInput(page).fill('999');
    await frameInput(page).press('Enter');
    await expect(caption(page)).toContainText('road-car.png');
    await expect(frameInput(page)).toHaveValue('5');
  });

  test('кадр вписывается в рабочую область и подстраивается под окно', async ({ page }) => {
    await page.goto('/');
    await expect(caption(page)).toContainText('crowd-person.png');
    const check = async () => {
      await expect(async () => {
        const state = await page.evaluate(() => {
          const rect = document.querySelector('.canvas-host')!.getBoundingClientRect();
          return { hostW: rect.width, hostH: rect.height, zoom: document.querySelector('.canvas-tools span')!.textContent! };
        });
        const expectedZoom = Math.round(Math.min((state.hostW - 72) / 1536, (state.hostH - 72) / 1024) * 100);
        expect(Math.abs(Number.parseInt(state.zoom, 10) - expectedZoom)).toBeLessThanOrEqual(1);
      }).toPass({ timeout: 5000 });
    };
    await check();
    await page.keyboard.press('d');
    await expect(caption(page)).toContainText('demo-bird.png');
    await check();
    await page.setViewportSize({ width: 1000, height: 700 });
    await check();
  });

  test('«Следующий неразмеченный», подписи и вписывание кадра работают', async ({ page }) => {
    await page.goto('/');
    await expect(caption(page)).toContainText('crowd-person.png');
    await expect(page.locator('.frame-loading')).toHaveCount(0);
    const zoom = page.locator('.canvas-tools span');
    await expect(zoom).toHaveText(/^\d+%$/);
    const fitZoom = await zoom.textContent();

    await page.getByRole('button', { name: 'Следующий неразмеченный' }).click();
    await expect(caption(page)).toContainText('road-car.png');
    await page.getByRole('button', { name: 'Следующий неразмеченный' }).click();
    await expect(caption(page)).toContainText('road-car.png');

    const labels = page.getByTitle('Подписи');
    await expect(labels).toHaveClass(/active/);
    await labels.click();
    await expect(labels).not.toHaveClass(/active/);
    await labels.click();
    await expect(labels).toHaveClass(/active/);

    await page.getByTitle('Показать весь кадр (F)').click();
    await expect(zoom).toHaveText(fitZoom!);
  });

  test('Ctrl/Cmd+Backspace исключает и возвращает кадр, но не срабатывает в полях ввода', async ({ page }) => {
    await page.goto('/');
    await expect(caption(page)).toContainText('crowd-person.png');

    await page.keyboard.press('Control+Backspace');
    await expect(row(page, 'crowd-person.png')).toHaveCount(0);
    await expect(caption(page)).toContainText('demo-bird.png');

    await page.locator('.search input').click();
    await page.keyboard.press('Control+Backspace');
    await page.waitForTimeout(400);
    await expect(row(page, 'demo-bird.png')).toBeVisible();
    await expect(page.locator('.image-row')).toHaveCount(4);

    await page.getByRole('button', { name: 'Исключённые' }).click();
    await expect(caption(page)).toContainText('crowd-person.png');
    await page.keyboard.press('Control+Backspace');
    await expect(page.locator('.no-results')).toBeVisible();

    await page.getByRole('button', { name: 'Все', exact: true }).click();
    await expect(page.locator('.image-row')).toHaveCount(5);
  });

  test('прыжок по номеру кадра из корзины возвращает в активную ленту', async ({ page, request }) => {
    const active = await project(request);
    await setExcluded(request, active.images.find((item) => item.name === 'demo-bird.png')!, true);
    await setExcluded(request, active.images.find((item) => item.name === 'demo-fox.png')!, true);

    await page.goto('/');
    await page.getByRole('button', { name: 'Исключённые' }).click();
    await expect(caption(page)).toContainText('demo-bird.png');

    await frameInput(page).fill('2');
    await frameInput(page).press('Enter');
    await expect(caption(page)).toContainText('road-car-truck.png');
    await expect(page.getByRole('button', { name: 'Все', exact: true })).toHaveClass(/active/);
    await expect(row(page, 'demo-fox.png')).toHaveCount(0);
    await expect(page.locator('.image-row')).toHaveCount(3);
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

  // Этот тест должен оставаться последним в serial-наборе: восстановление выполняет
  // второй сервер, поэтому in-memory индекс основного сервера после него устаревает
  // (afterAll это учитывает).
  test('восстанавливает исходный adjacent TXT после перезапуска сервера', async ({ request }) => {
    const image = (await project(request)).images.find((item) => item.name === 'demo-bird.png')!;
    await setExcluded(request, image, true);

    const port = await freePort();
    const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: path.resolve('.'),
      env: { ...process.env, BOXSCRIBE_DATASET_DIR: dataset },
      stdio: 'ignore'
    });
    try {
      let ready = false;
      for (let attempt = 0; attempt < 50 && !ready; attempt++) {
        try { ready = (await fetch(`http://127.0.0.1:${port}/__boxscribe/project?status=excluded`)).ok; }
        catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
      }
      expect(ready).toBeTruthy();
      const trash = await fetch(`http://127.0.0.1:${port}/__boxscribe/project?status=excluded`).then((response) => response.json()) as Project;
      const restartedRecord = trash.images.find((item) => item.name === image.name)!;
      const response = await fetch(`http://127.0.0.1:${port}/__boxscribe/exclude?id=${encodeURIComponent(restartedRecord.id)}`, {
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
