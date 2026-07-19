import { expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { cleanRoadCarLabel, dataset, freePort, project, restoreEverything, setExcluded, type Project } from './helpers';

// Этот файл должен оставаться последним: восстановление выполняет второй
// сервер, поэтому in-memory индекс основного сервера после него устаревает
// (afterAll это учитывает).
test.describe.serial('перезапуск сервера', () => {
  test.beforeEach(async ({ request }) => restoreEverything(request));
  test.afterAll(async ({ request }) => {
    try { await restoreEverything(request); } catch { /* another server may have completed the final restore */ }
    await cleanRoadCarLabel();
  });

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
