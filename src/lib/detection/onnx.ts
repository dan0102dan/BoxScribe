import type { BoundingBox } from '$lib/annotation/types';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.jsep.wasm?url';

export type Detection = Omit<BoundingBox, 'id'> & { score: number };

type TensorLike = { data: ArrayLike<number>; dims: readonly number[] };
type Letterbox = { scale: number; padX: number; padY: number; imageWidth: number; imageHeight: number; inputWidth: number; inputHeight: number };
type DecodeStats = { bestScore: number };

type LoadedSession = { session: import('onnxruntime-web').InferenceSession; backend: 'webgpu' | 'wasm' };
const sessions = new Map<string, Promise<LoadedSession>>();
// Each retained session keeps the whole model plus runtime workspace in memory
// (hundreds of MB for the bundled weights); an unbounded cache gets the tab
// killed by Safari's memory watchdog.
const maxCachedSessions = 2;

function iou(a: Detection, b: Detection) {
  const left = Math.max(a.x, b.x), top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  return intersection / (a.width * a.height + b.width * b.height - intersection || 1);
}

export function mergeDetections(detections: Detection[], threshold = 0.45, limit = 300) {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: Detection[] = [];
  for (const candidate of sorted) {
    if (kept.length >= limit) break;
    if (!kept.some((box) => iou(box, candidate) > threshold)) kept.push(candidate);
  }
  return kept;
}

function restoreBox(values: number[], classId: number, score: number, meta: Letterbox, xyxy: boolean): Detection | null {
  let [a, b, c, d] = values;
  const normalized = Math.max(Math.abs(a), Math.abs(b), Math.abs(c), Math.abs(d)) <= 2;
  if (normalized) { a *= meta.inputWidth; c *= meta.inputWidth; b *= meta.inputHeight; d *= meta.inputHeight; }
  let x1 = xyxy ? a : a - c / 2, y1 = xyxy ? b : b - d / 2;
  let x2 = xyxy ? c : a + c / 2, y2 = xyxy ? d : b + d / 2;
  x1 = Math.max(0, Math.min(meta.imageWidth, (x1 - meta.padX) / meta.scale));
  y1 = Math.max(0, Math.min(meta.imageHeight, (y1 - meta.padY) / meta.scale));
  x2 = Math.max(0, Math.min(meta.imageWidth, (x2 - meta.padX) / meta.scale));
  y2 = Math.max(0, Math.min(meta.imageHeight, (y2 - meta.padY) / meta.scale));
  if (x2 <= x1 || y2 <= y1 || classId < 0) return null;
  return { classId, score, x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Decodes the common YOLOv5, YOLOv8/YOLO11 and end-to-end [x1,y1,x2,y2,score,class] exports. */
export function decodeDetections(output: TensorLike, classCount: number, confidence: number, meta: Letterbox, stats?: DecodeStats) {
  const dims = output.dims.map(Number);
  if (dims.length < 2) throw new Error(`Неподдерживаемая форма выхода ONNX: [${dims.join(', ')}]`);
  const rows = dims.at(-2)!, columns = dims.at(-1)!;
  const featureSizes = new Set([6, classCount + 4, classCount + 5]);
  // A transposed export puts a small feature axis before a large candidate axis;
  // requiring many candidates keeps an [N, 6] end-to-end output with tiny N row-major.
  const transposed = (featureSizes.has(rows) && !featureSizes.has(columns)) || (rows >= 5 && rows <= 512 && columns > 512);
  const candidates = transposed ? columns : rows;
  const features = transposed ? rows : columns;
  const at = (row: number, column: number) => Number(output.data[transposed ? column * candidates + row : row * features + column]);

  // Layout decisions are per-tensor: a single row on its own (zero padding, a
  // sigmoid saturated to exactly 0 or 1) can look like the wrong export flavour.
  // End-to-end exporters emit [x1, y1, x2, y2, score, classId] for EVERY row —
  // an integer class column (negative allowed as padding) and scores within [0, 1].
  let endToEnd = features === 6 && candidates > 0;
  for (let row = 0; endToEnd && row < candidates; row++) {
    const classValue = at(row, 5), score = at(row, 4);
    if (!Number.isInteger(classValue) || score < 0 || score > 1) endToEnd = false;
  }
  // A one-class YOLOv5 export has 6 features, which is otherwise ambiguous with
  // a two-class YOLOv8 export; raw YOLOv5 grids are large while raw YOLOv8
  // exports come transposed, so many row-major candidates identify YOLOv5.
  const hasObjectness = !endToEnd && (features === classCount + 5 || (features === 6 && candidates > 1000));
  const classOffset = hasObjectness ? 5 : 4;
  const availableClasses = Math.min(classCount, features - classOffset);
  const result: Detection[] = [];

  for (let row = 0; row < candidates; row++) {
    if (endToEnd) {
      const score = at(row, 4), classId = Math.round(at(row, 5));
      if (stats && Number.isFinite(score)) stats.bestScore = Math.max(stats.bestScore, score);
      if (score < confidence || classId < 0 || classId >= classCount) continue;
      const box = restoreBox([at(row, 0), at(row, 1), at(row, 2), at(row, 3)], classId, score, meta, true);
      if (box) result.push(box);
      continue;
    }

    let classId = -1, classScore = -Infinity;
    for (let index = 0; index < availableClasses; index++) {
      const value = at(row, classOffset + index);
      if (value > classScore) { classScore = value; classId = index; }
    }
    const score = classScore * (hasObjectness ? at(row, 4) : 1);
    if (stats && Number.isFinite(score)) stats.bestScore = Math.max(stats.bestScore, score);
    if (score < confidence) continue;
    const box = restoreBox([at(row, 0), at(row, 1), at(row, 2), at(row, 3)], classId, score, meta, false);
    if (box) result.push(box);
  }
  return mergeDetections(result);
}

async function loadSession(url: string) {
  let pending = sessions.get(url);
  if (pending) {
    // Refresh insertion order so the first map entry is always the LRU session.
    sessions.delete(url); sessions.set(url, pending);
  }
  if (!pending) {
    while (sessions.size >= maxCachedSessions) await releaseOnnxSession(sessions.keys().next().value!);
    pending = import('onnxruntime-web').then(async ({ env, InferenceSession }) => {
      env.wasm.wasmPaths = { wasm: new URL(wasmUrl, window.location.href).href };
      if ('gpu' in navigator) {
        try { return { session: await InferenceSession.create(url, { executionProviders: ['webgpu'] }), backend: 'webgpu' as const }; }
        catch (error) { console.warn('WebGPU недоступен для этой ONNX-модели, используется WASM.', error); }
      }
      return { session: await InferenceSession.create(url, { executionProviders: ['wasm'] }), backend: 'wasm' as const };
    });
    sessions.set(url, pending);
    pending.catch(() => sessions.delete(url));
  }
  return pending;
}

export async function releaseOnnxSession(url: string) {
  const pending = sessions.get(url);
  if (!pending) return;
  sessions.delete(url);
  try { const { session } = await pending; await session.release(); }
  catch { /* A failed/partially-created session has nothing reliable to release. */ }
}

export function isOnnxSessionCached(url: string) { return sessions.has(url); }

export async function detectOnnx(modelUrl: string, imageUrl: string, classCount: number, confidence: number) {
  const startedAt = performance.now();
  const { session, backend } = await loadSession(modelUrl);
  const sessionReadyAt = performance.now();
  const metadata = session.inputMetadata[0];
  if (!metadata || !('shape' in metadata)) throw new Error('У модели нет тензорного входа');
  const shape = metadata.shape;
  const inputHeight = typeof shape[2] === 'number' && shape[2] > 0 ? shape[2] : 640;
  const inputWidth = typeof shape[3] === 'number' && shape[3] > 0 ? shape[3] : 640;
  const response = await fetch(imageUrl);
  if (!response.ok) throw new Error('Не удалось загрузить изображение для детекции');
  const bitmap = await createImageBitmap(await response.blob());
  const imageWidth = bitmap.width, imageHeight = bitmap.height;
  const scale = Math.min(inputWidth / bitmap.width, inputHeight / bitmap.height);
  const drawWidth = Math.round(bitmap.width * scale), drawHeight = Math.round(bitmap.height * scale);
  const padX = Math.floor((inputWidth - drawWidth) / 2), padY = Math.floor((inputHeight - drawHeight) / 2);
  const canvas = document.createElement('canvas'); canvas.width = inputWidth; canvas.height = inputHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas недоступен для подготовки изображения');
  context.fillStyle = 'rgb(114,114,114)'; context.fillRect(0, 0, inputWidth, inputHeight);
  context.drawImage(bitmap, padX, padY, drawWidth, drawHeight); bitmap.close();
  const rgba = context.getImageData(0, 0, inputWidth, inputHeight).data;
  const plane = inputWidth * inputHeight, chw = new Float32Array(plane * 3);
  for (let index = 0; index < plane; index++) {
    chw[index] = rgba[index * 4] / 255;
    chw[plane + index] = rgba[index * 4 + 1] / 255;
    chw[plane * 2 + index] = rgba[index * 4 + 2] / 255;
  }
  const { Tensor } = await import('onnxruntime-web');
  const preprocessedAt = performance.now();
  const inputTensor = new Tensor('float32', chw, [1, 3, inputHeight, inputWidth]);
  let outputs: Awaited<ReturnType<typeof session.run>>;
  try { outputs = await session.run({ [session.inputNames[0]]: inputTensor }); }
  finally { inputTensor.dispose(); }
  const inferredAt = performance.now();
  const output = outputs[session.outputNames[0]];
  let detections: Detection[], stats: DecodeStats = { bestScore: 0 };
  try {
    if (!output || !('dims' in output) || !('data' in output)) throw new Error('Модель не вернула тензор детекций');
    detections = decodeDetections(output as TensorLike, classCount, confidence, { scale, padX, padY, imageWidth, imageHeight, inputWidth, inputHeight }, stats);
  } finally {
    for (const value of Object.values(outputs)) if ('dispose' in value && typeof value.dispose === 'function') value.dispose();
  }
  const finishedAt = performance.now();
  return {
    detections,
    bestScore: stats.bestScore,
    backend,
    inputSize: `${inputWidth}×${inputHeight}`,
    timings: {
      session: sessionReadyAt - startedAt,
      preprocess: preprocessedAt - sessionReadyAt,
      inference: inferredAt - preprocessedAt,
      postprocess: finishedAt - inferredAt,
      total: finishedAt - startedAt
    }
  };
}
