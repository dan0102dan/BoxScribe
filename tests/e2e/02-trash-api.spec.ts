import { expect, test } from '@playwright/test';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { cleanRoadCarLabel, dataset, project, restoreEverything, setExcluded } from './helpers';

// Тест про annotatedCount требует, чтобы road-car.png был без разметки:
// файлы, размечающие его, идут позже (03-annotate-ui.spec.ts).
test.describe.serial('виртуальная корзина (API)', () => {
  test.beforeAll(async () => {
    await cleanRoadCarLabel();
  });
  test.beforeEach(async ({ request }) => restoreEverything(request));

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
});
