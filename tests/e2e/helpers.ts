import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { unlink } from 'node:fs/promises';
import { createServer, type AddressInfo } from 'node:net';
import path from 'node:path';

export const dataset = path.resolve('demo-dataset');

export type ImageItem = { id: string; name: string; excluded: boolean; index: number };
export type Project = { classes: string[]; images: ImageItem[]; annotatedCount: number; activeImages: number; excludedCount: number };

export async function project(request: APIRequestContext, status = 'active', query = '', classIds: number[] = []) {
  const response = await request.get('/__boxscribe/project', { params: { limit: 200, status, query, classIds: classIds.join(',') } });
  expect(response.ok()).toBeTruthy();
  return await response.json() as Project;
}

export async function setExcluded(request: APIRequestContext, image: ImageItem, excluded: boolean, scope: { status?: string; query?: string; classIds?: number[] } = {}) {
  const response = await request.put('/__boxscribe/exclude', {
    params: { id: image.id },
    data: { excluded, currentId: image.id, status: scope.status ?? (excluded ? 'active' : 'excluded'), query: scope.query ?? '', classIds: scope.classIds ?? [] }
  });
  expect(response.ok()).toBeTruthy();
  return await response.json() as { image: ImageItem; nextImage: ImageItem | null; annotatedCount: number };
}

export async function restoreEverything(request: APIRequestContext) {
  for (const image of (await project(request, 'excluded')).images) await setExcluded(request, image, false);
}

export function cleanRoadCarLabel() {
  return unlink(path.join(dataset, 'train/labels/road-car.txt')).catch(() => undefined);
}

export const row = (page: Page, name: string) => page.locator('.image-row').filter({ hasText: name });
export const caption = (page: Page) => page.locator('.top-image-caption');
export const frameInput = (page: Page) => page.getByLabel('Перейти к номеру кадра');

// Набирает номер кадра реальными нажатиями: программный fill не взводит
// «dirty»-флаг поля, и blur может не выдать событие change. Ввод обёрнут в
// retry: placeFrameCaretAtEnd ставит каретку через requestAnimationFrame и на
// медленной машине может схлопнуть выделение между Ctrl+A и набором текста.
export async function jumpToFrameNumber(page: Page, frame: string) {
  await expect(async () => {
    await frameInput(page).click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type(frame);
    await expect(frameInput(page)).toHaveValue(frame, { timeout: 500 });
  }).toPass({ timeout: 10_000 });
  await page.keyboard.press('Enter');
}

export function freePort() {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}
