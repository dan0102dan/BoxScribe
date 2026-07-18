import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { imageSize } from 'image-size';
import YAML from 'yaml';

type RecordItem = { relative: string; splitIndex: number; index: number; annotated: boolean; boxCount?: number; classIds?: number[] };
type DatasetIndex = { root: string; classes: string[]; splitDirs: string[]; records: RecordItem[]; annotatedCount: number };
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);
const contentTypes: Record<string, string> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.bmp': 'image/bmp' };

async function scanDirectory(directory: string, root = directory) {
  const images: string[] = [], labels = new Set<string>(), pending = [directory];
  while (pending.length) {
    const current = pending.pop()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(full);
      else {
        const relative = path.relative(root, full);
        const extension = path.extname(entry.name).toLowerCase();
        if (imageExtensions.has(extension)) images.push(relative);
        else if (extension === '.txt') labels.add(relative.slice(0, -4));
      }
    }
  }
  images.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return { images, labels };
}

async function buildIndex(): Promise<DatasetIndex> {
  const root = path.resolve(process.env.BOXSCRIBE_DATASET_DIR || 'demo-dataset');
  const yamlPath = path.join(root, 'data.yaml');
  const config = YAML.parse(await readFile(yamlPath, 'utf8'));
  const classes = Array.isArray(config.names)
    ? config.names.map(String)
    : Object.entries(config.names || {}).sort(([a], [b]) => Number(a) - Number(b)).map(([, value]) => String(value));
  const configuredBase = config.path ? path.resolve(root, String(config.path)) : root;
  const values = [...new Set(['train', 'val', 'test'].flatMap((key) => Array.isArray(config[key]) ? config[key] : config[key] ? [config[key]] : []))];
  const splitDirs = values.map((value) => path.resolve(configuredBase, String(value))).filter((value, index, all) => all.indexOf(value) === index);
  const records: RecordItem[] = [];
  for (let splitIndex = 0; splitIndex < splitDirs.length; splitIndex++) {
    const splitDir = splitDirs[splitIndex];
    const splitKey = `${splitIndex}-${path.basename(splitDir)}`;
    const scanned = await scanDirectory(splitDir);
    for (const relative of scanned.images) {
      const stem = relative.slice(0, -path.extname(relative).length);
      records.push({ relative, splitIndex, index: records.length, annotated: scanned.labels.has(stem) });
    }
  }
  return { root, classes, splitDirs, records, annotatedCount: records.filter((record) => record.annotated).length };
}

function sourcePath(index: DatasetIndex, record: RecordItem) {
  return path.join(index.splitDirs[record.splitIndex], record.relative);
}

function labelCandidates(index: DatasetIndex, record: RecordItem) {
  const parsed = path.parse(record.relative);
  const splitDir = index.splitDirs[record.splitIndex];
  const adjacent = path.join(splitDir, parsed.dir, `${parsed.name}.txt`);
  const parts = splitDir.split(path.sep);
  const imagesIndex = parts.lastIndexOf('images');
  if (imagesIndex < 0) return [adjacent];
  parts[imagesIndex] = 'labels';
  return [adjacent, path.join(parts.join(path.sep), parsed.dir, `${parsed.name}.txt`)];
}

async function labelPath(index: DatasetIndex, record: RecordItem) {
  for (const candidate of labelCandidates(index, record)) {
    try { await open(candidate, 'r').then((handle) => handle.close()); return candidate; } catch { /* try next */ }
  }
  return labelCandidates(index, record).at(-1)!;
}

async function hydrateLabel(index: DatasetIndex, record: RecordItem) {
  if (record.boxCount !== undefined) return;
  if (!record.annotated) { record.boxCount = 0; record.classIds = []; return; }
  try {
    const text = await readFile(await labelPath(index, record), 'utf8');
    const rows = text.split(/\r?\n/).filter(Boolean);
    record.boxCount = rows.length;
    record.classIds = [...new Set(rows.map((line) => Number.parseInt(line.trim().split(/\s+/)[0], 10)).filter(Number.isFinite))];
  } catch { record.boxCount = 0; record.classIds = []; }
}

async function hydrateLabels(index: DatasetIndex, records: RecordItem[]) {
  for (let offset = 0; offset < records.length; offset += 128) {
    await Promise.all(records.slice(offset, offset + 128).map((record) => hydrateLabel(index, record)));
  }
}

async function dimensions(source: string) {
  const handle = await open(source, 'r');
  try {
    const header = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    try { return imageSize(header.subarray(0, bytesRead)); }
    catch { return imageSize(await readFile(source)); }
  } finally { await handle.close(); }
}

function parseYolo(text: string, width: number, height: number) {
  return text.split(/\r?\n/).filter(Boolean).flatMap((line, index) => {
    const [classId, cx, cy, w, h] = line.trim().split(/\s+/).map(Number);
    if (![classId, cx, cy, w, h].every(Number.isFinite)) return [];
    return [{ id: `box-${index}-${crypto.randomUUID()}`, classId, x: (cx - w / 2) * width, y: (cy - h / 2) * height, width: w * width, height: h * height }];
  });
}

function serializeYolo(boxes: any[], width: number, height: number) {
  return boxes.map((box) => [box.classId, (box.x + box.width / 2) / width, (box.y + box.height / 2) / height, box.width / width, box.height / height]
    .map((value, index) => index ? Number(value).toFixed(6) : value).join(' ')).join('\n');
}

function item(record: RecordItem) {
  return { id: String(record.index), name: path.basename(record.relative), width: 0, height: 0, annotated: record.annotated, empty: record.annotated && record.boxCount === 0, boxCount: record.boxCount ?? -1, assetPath: '', index: record.index };
}

function sendJson(res: ServerResponse, value: unknown, status = 200) {
  res.statusCode = status; res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(value));
}

async function body(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function datasetDevPlugin(): Plugin {
  let indexPromise: Promise<DatasetIndex> | null = null;
  const getIndex = () => indexPromise ??= buildIndex();
  return {
    name: 'boxscribe-dataset-dev',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url || '/', 'http://localhost');
        if (!url.pathname.startsWith('/__boxscribe/')) return next();
        try {
          const index = await getIndex();
          if (url.pathname === '/__boxscribe/project') {
            const query = (url.searchParams.get('query') || '').toLowerCase();
            const requiredClassIds = (url.searchParams.get('classIds') || '').split(',').filter(Boolean).map(Number).filter(Number.isInteger);
            const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            if (requiredClassIds.length) await hydrateLabels(index, index.records);
            const source = index.records.filter((record) => (!query || record.relative.toLowerCase().includes(query)) && requiredClassIds.every((classId) => record.classIds?.includes(classId)));
            const page = source.slice(offset, offset + limit);
            await hydrateLabels(index, page);
            return sendJson(res, { name: path.basename(index.root), imageDir: index.root, classes: index.classes, images: page.map(item), lastImageId: source[0] ? String(source[0].index) : null, totalImages: index.records.length, annotatedCount: index.annotatedCount, resultCount: source.length });
          }
          if (url.pathname === '/__boxscribe/item') {
            const record = index.records[Number(url.searchParams.get('index'))];
            return record ? sendJson(res, item(record)) : sendJson(res, { message: 'Кадр не найден' }, 404);
          }
          if (url.pathname === '/__boxscribe/neighbor') {
            const currentIndex = Number(url.searchParams.get('id'));
            const direction = Number(url.searchParams.get('direction')) < 0 ? -1 : 1;
            const query = (url.searchParams.get('query') || '').toLowerCase();
            const requiredClassIds = (url.searchParams.get('classIds') || '').split(',').filter(Boolean).map(Number).filter(Number.isInteger);
            if (requiredClassIds.length) await hydrateLabels(index, index.records);
            const source = index.records.filter((candidate) => (!query || candidate.relative.toLowerCase().includes(query)) && requiredClassIds.every((classId) => candidate.classIds?.includes(classId)));
            const position = source.findIndex((candidate) => candidate.index === currentIndex);
            const neighbor = position >= 0 ? source[position + direction] : undefined;
            if (!neighbor) return sendJson(res, { message: 'Соседний кадр не найден' }, 404);
            await hydrateLabel(index, neighbor);
            return sendJson(res, item(neighbor));
          }
          const rawId = url.searchParams.get('id') || '';
          const numericId = Number(rawId);
          const record = Number.isInteger(numericId) && String(numericId) === rawId ? index.records[numericId] : undefined;
          if (!record) return sendJson(res, { message: 'Кадр не найден' }, 404);
          if (url.pathname === '/__boxscribe/image') {
            const source = sourcePath(index, record);
            res.statusCode = 200; res.setHeader('content-type', contentTypes[path.extname(source).toLowerCase()] || 'application/octet-stream'); res.setHeader('cache-control', 'private, max-age=3600');
            return createReadStream(source).pipe(res);
          }
          if (url.pathname === '/__boxscribe/annotations' && req.method === 'GET') {
            const size = await dimensions(sourcePath(index, record));
            let text = '', saved = false;
            try { text = await readFile(await labelPath(index, record), 'utf8'); saved = true; } catch { /* unlabeled */ }
            return sendJson(res, { boxes: parseYolo(text, size.width, size.height), saved, image: { ...item(record), width: size.width, height: size.height, annotated: saved, empty: saved && !text.trim(), boxCount: text.split(/\r?\n/).filter(Boolean).length } });
          }
          if (url.pathname === '/__boxscribe/annotations' && req.method === 'PUT') {
            const payload = await body(req), size = await dimensions(sourcePath(index, record)), target = await labelPath(index, record);
            await mkdir(path.dirname(target), { recursive: true });
            const text = serializeYolo(Array.isArray(payload.boxes) ? payload.boxes : [], size.width, size.height);
            await writeFile(target, text ? `${text}\n` : '', 'utf8'); record.annotated = true;
            record.boxCount = Array.isArray(payload.boxes) ? payload.boxes.length : 0;
            record.classIds = [...new Set<number>((Array.isArray(payload.boxes) ? payload.boxes : []).map((box: any) => Number(box.classId)))];
            return sendJson(res, { ok: true, savedAt: new Date().toISOString() });
          }
          return sendJson(res, { message: 'Маршрут не найден' }, 404);
        } catch (error) {
          indexPromise = null;
          return sendJson(res, { message: error instanceof Error ? error.message : 'Ошибка датасета' }, 500);
        }
      });
    }
  };
}
