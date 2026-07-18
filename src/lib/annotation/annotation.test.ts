import { describe, expect, it } from 'vitest';
import { clampBox, fitViewport, imageToScreen, screenToImage } from './coordinates';
import { parseYolo, serializeYolo } from './yolo';

describe('coordinate transforms', () => {
  it('round-trips image and screen points', () => {
    const viewport = { scale: 1.75, offsetX: 42, offsetY: -13 };
    expect(screenToImage(...Object.values(imageToScreen(123, 456, viewport)) as [number, number], viewport)).toEqual({ x: 123, y: 456 });
  });

  it('keeps boxes inside the source image', () => {
    expect(clampBox({ id: '1', classId: 0, x: -10, y: 90, width: 120, height: 50 }, 100, 100)).toMatchObject({ x: 0, y: 90, width: 100, height: 10 });
  });

  it('fits an image with padding', () => {
    const viewport = fitViewport(1000, 600, 1600, 900);
    expect(viewport.scale).toBeGreaterThan(0);
    expect(viewport.offsetX).toBeGreaterThan(0);
    expect(viewport.offsetY).toBeGreaterThan(0);
  });
});

describe('YOLO adapter', () => {
  it('serializes and parses pixel boxes without meaningful drift', () => {
    const original = [{ id: 'box', classId: 2, x: 100, y: 50, width: 400, height: 200 }];
    const text = serializeYolo(original, 1000, 500);
    expect(text).toBe('2 0.300000 0.300000 0.400000 0.400000');
    expect(parseYolo(text, 1000, 500)[0]).toMatchObject({ classId: 2, x: 100, y: 50, width: 400, height: 200 });
  });

  it('ignores malformed rows', () => {
    expect(parseYolo('broken row', 100, 100)).toEqual([]);
  });
});
