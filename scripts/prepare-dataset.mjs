import { cp, lstat, mkdir, open, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { imageSize } from 'image-size';
import YAML from 'yaml';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const datasetRoot = path.resolve(process.env.BOXSCRIBE_DATASET_DIR || path.join(projectRoot, 'demo-dataset'));
const outputRoot = path.join(projectRoot, 'static', 'dataset', 'source');
const generatedFile = path.join(projectRoot, 'src', 'lib', 'generated', 'dataset.ts');
const mode = process.argv.includes('--link') ? 'link' : 'copy';
const extensions = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp']);

async function exists(target) { try { await lstat(target); return true; } catch { return false; } }
async function dimensions(source) {
  const handle = await open(source, 'r');
  try {
    const header = Buffer.alloc(256 * 1024);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    try { return imageSize(header.subarray(0, bytesRead)); }
    catch { return imageSize(await readFile(source)); }
  } finally { await handle.close(); }
}
async function walk(directory, root = directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await walk(full, root));
    else if (extensions.has(path.extname(entry.name).toLowerCase())) result.push(path.relative(root, full));
  }
  return result;
}

function yoloBoxes(text, width, height) {
  return text.split(/\r?\n/).filter(Boolean).flatMap((line, index) => {
    const [classId, cx, cy, w, h] = line.trim().split(/\s+/).map(Number);
    if (![classId, cx, cy, w, h].every(Number.isFinite)) return [];
    return [{ id: `box-${index}`, classId, x: (cx - w / 2) * width, y: (cy - h / 2) * height, width: w * width, height: h * height }];
  });
}

function labelCandidate(splitDir, relativeImage) {
  const parsed = path.parse(relativeImage);
  const adjacent = path.join(splitDir, parsed.dir, `${parsed.name}.txt`);
  const parts = splitDir.split(path.sep);
  const imagesIndex = parts.lastIndexOf('images');
  if (imagesIndex >= 0) {
    parts[imagesIndex] = 'labels';
    return [adjacent, path.join(parts.join(path.sep), parsed.dir, `${parsed.name}.txt`)];
  }
  return [adjacent];
}

const yamlPath = path.join(datasetRoot, 'data.yaml');
if (!await exists(yamlPath)) throw new Error(`data.yaml не найден: ${yamlPath}`);
const config = YAML.parse(await readFile(yamlPath, 'utf8'));
const names = Array.isArray(config.names)
  ? config.names.map(String)
  : Object.entries(config.names || {}).sort(([a], [b]) => Number(a) - Number(b)).map(([, value]) => String(value));
if (!names.length) throw new Error('В data.yaml не задан список names');

const yamlBase = path.dirname(yamlPath);
const configuredBase = config.path ? path.resolve(yamlBase, String(config.path)) : yamlBase;
const splitValues = [...new Set(['train', 'val', 'test'].flatMap((key) => {
  const value = config[key];
  return Array.isArray(value) ? value : value ? [value] : [];
}))];
const splitDirs = splitValues.map((value) => path.resolve(configuredBase, String(value))).filter((value, index, all) => all.indexOf(value) === index);
if (!splitDirs.length) throw new Error('В data.yaml не заданы train/val/test пути');

await rm(path.join(projectRoot, 'static', 'dataset'), { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });
const images = [];
const boxesByImage = {};

for (let splitIndex = 0; splitIndex < splitDirs.length; splitIndex++) {
  const splitDir = splitDirs[splitIndex];
  const splitKey = `${splitIndex}-${path.basename(splitDir)}`;
  const targetDir = path.join(outputRoot, splitKey);
  if (mode === 'link') await symlink(splitDir, targetDir, 'dir');
  else await mkdir(targetDir, { recursive: true });
  const relativeImages = (await walk(splitDir)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  for (const relative of relativeImages) {
    const source = path.join(splitDir, relative);
    const size = await dimensions(source);
    let labelText = '', labelFound = false;
    for (const candidate of labelCandidate(splitDir, relative)) {
      try { labelText = await readFile(candidate, 'utf8'); labelFound = true; break; } catch { /* try next convention */ }
    }
    const id = `${splitKey}/${relative}`.split(path.sep).join('/');
    const boxes = yoloBoxes(labelText, size.width, size.height);
    images.push({ id, name: path.basename(relative), width: size.width, height: size.height, annotated: labelFound, empty: labelFound && boxes.length === 0, boxCount: boxes.length, assetPath: `dataset/source/${id}` });
    boxesByImage[id] = boxes;
    if (mode === 'copy') {
      const target = path.join(targetDir, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(source, target);
    }
  }
}

const project = { name: path.basename(datasetRoot), imageDir: datasetRoot, classes: names, images, lastImageId: images[0]?.id || null };
await mkdir(path.dirname(generatedFile), { recursive: true });
await writeFile(generatedFile, `// Generated by scripts/prepare-dataset.mjs — do not edit.\nimport type { BoundingBox, ProjectState } from '$lib/annotation/types';\nexport const project = ${JSON.stringify(project)} as ProjectState;\nexport const boxesByImage = ${JSON.stringify(boxesByImage)} as Record<string, BoundingBox[]>;\n`);
console.log(`Prepared ${images.length} images from ${datasetRoot} (${mode})`);
