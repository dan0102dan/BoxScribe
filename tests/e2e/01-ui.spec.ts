import { expect, test } from '@playwright/test';
import { caption, cleanRoadCarLabel, frameInput, jumpToFrameNumber, project, restoreEverything, row, setExcluded } from './helpers';

// Файлы e2e делят один dev-сервер и датасет, поэтому их порядок закреплён
// числовым префиксом. Тесты здесь не создают разметку — road-car.png должен
// остаться неразмеченным до 02-trash-api.spec.ts.
test.describe.serial('интерфейс', () => {
  test.beforeAll(async () => {
    // После упавшего прогона файл мог остаться; удалить его нужно до того, как
    // первый запрос построит in-memory индекс сервера.
    await cleanRoadCarLabel();
  });
  test.beforeEach(async ({ request }) => restoreEverything(request));

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

  test.describe(() => {
    test.use({ deviceScaleFactor: 2, viewport: { width: 1280, height: 800 } });
    test('canvas корректно масштабируется на retina (dpr=2)', async ({ page }) => {
      await page.goto('/');
      const geometry = await page.locator('.canvas-host canvas').evaluate((canvas: HTMLCanvasElement) => {
        const host = document.querySelector<HTMLElement>('.canvas-host')!.getBoundingClientRect();
        const rect = canvas.getBoundingClientRect();
        return { host: { width: host.width, height: host.height }, canvas: { width: rect.width, height: rect.height } };
      });
      expect(geometry.canvas).toEqual(geometry.host);
      await expect.poll(() => page.locator('.canvas-host canvas').evaluate((canvas: HTMLCanvasElement) => [canvas.width, canvas.height]))
        .toEqual([Math.round(geometry.canvas.width * 2), Math.round(geometry.canvas.height * 2)]);
    });
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
    await expect(page.locator('.frame-loading')).toHaveCount(0);

    await jumpToFrameNumber(page, '5');
    await expect(caption(page)).toContainText('road-car.png');
    await expect(next).toBeDisabled();
    await expect(page.locator('.frame-loading')).toHaveCount(0);

    await jumpToFrameNumber(page, '999');
    await expect(caption(page)).toContainText('road-car.png');
    await expect(frameInput(page)).toHaveValue('5');
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
    await expect(page.locator('.frame-loading')).toHaveCount(0);

    await jumpToFrameNumber(page, '2');
    await expect(caption(page)).toContainText('road-car-truck.png');
    await expect(page.getByRole('button', { name: 'Все', exact: true })).toHaveClass(/active/);
    await expect(row(page, 'demo-fox.png')).toHaveCount(0);
    await expect(page.locator('.image-row')).toHaveCount(3);
  });
});
