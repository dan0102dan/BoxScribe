import type { BoundingBox } from './types';

export function serializeYolo(boxes: BoundingBox[], imageWidth: number, imageHeight: number): string {
  return boxes.map((box) => [
    box.classId,
    (box.x + box.width / 2) / imageWidth,
    (box.y + box.height / 2) / imageHeight,
    box.width / imageWidth,
    box.height / imageHeight
  ].map((value, index) => index === 0 ? value : Number(value).toFixed(6)).join(' ')).join('\n');
}

export function parseYolo(text: string, imageWidth: number, imageHeight: number): BoundingBox[] {
  return text.split(/\r?\n/).filter(Boolean).flatMap((line, index) => {
    const [classId, cx, cy, width, height] = line.trim().split(/\s+/).map(Number);
    if (![classId, cx, cy, width, height].every(Number.isFinite)) return [];
    const w = width * imageWidth;
    const h = height * imageHeight;
    return [{ id: `box-${index}-${crypto.randomUUID()}`, classId, x: cx * imageWidth - w / 2, y: cy * imageHeight - h / 2, width: w, height: h }];
  });
}
