import type { BoundingBox, Viewport } from './types';

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function screenToImage(x: number, y: number, viewport: Viewport) {
  return { x: (x - viewport.offsetX) / viewport.scale, y: (y - viewport.offsetY) / viewport.scale };
}

export function imageToScreen(x: number, y: number, viewport: Viewport) {
  return { x: x * viewport.scale + viewport.offsetX, y: y * viewport.scale + viewport.offsetY };
}

export function clampBox(box: BoundingBox, imageWidth: number, imageHeight: number): BoundingBox {
  const x = clamp(box.x, 0, imageWidth);
  const y = clamp(box.y, 0, imageHeight);
  return {
    ...box,
    x,
    y,
    width: clamp(box.width, 0, imageWidth - x),
    height: clamp(box.height, 0, imageHeight - y)
  };
}

export function fitViewport(canvasWidth: number, canvasHeight: number, imageWidth: number, imageHeight: number): Viewport {
  const padding = 36;
  const scale = Math.min((canvasWidth - padding * 2) / imageWidth, (canvasHeight - padding * 2) / imageHeight);
  return {
    scale: Math.max(0.01, scale),
    offsetX: (canvasWidth - imageWidth * scale) / 2,
    offsetY: (canvasHeight - imageHeight * scale) / 2
  };
}
