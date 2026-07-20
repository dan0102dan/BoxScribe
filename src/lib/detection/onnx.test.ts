import { describe, expect, it } from 'vitest';
import { decodeDetections, mergeDetections } from './onnx';

const meta = { scale: 1, padX: 0, padY: 0, imageWidth: 640, imageHeight: 640, inputWidth: 640, inputHeight: 640 };

describe('ONNX detection decoder', () => {
  it('decodes a transposed YOLOv8 output', () => {
    const output = {
      dims: [1, 6, 2],
      data: new Float32Array([
        100, 400, // center x
        120, 400, // center y
        40, 20,   // width
        60, 20,   // height
        .9, .1,   // class 0
        .1, .8    // class 1
      ])
    };
    const boxes = decodeDetections(output, 2, .3, meta);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({ classId: 0, x: 80, y: 90, width: 40, height: 60 });
    expect(boxes[1].classId).toBe(1);
  });

  it('merges overlapping detections from multiple models by confidence', () => {
    const boxes = mergeDetections([
      { classId: 1, score: .62, x: 10, y: 10, width: 100, height: 100 },
      { classId: 1, score: .91, x: 12, y: 12, width: 100, height: 100 },
      { classId: 2, score: .55, x: 12, y: 12, width: 100, height: 100 },
      { classId: 1, score: .7, x: 300, y: 300, width: 40, height: 40 }
    ], .5);
    expect(boxes).toHaveLength(2);
    expect(boxes).toContainEqual(expect.objectContaining({ classId: 1, score: .91, x: 12 }));
    expect(boxes).not.toContainEqual(expect.objectContaining({ score: .62 }));
    expect(boxes).not.toContainEqual(expect.objectContaining({ classId: 2, score: .55 }));
  });

  it('applies objectness for a YOLOv5 output', () => {
    const output = { dims: [1, 1, 7], data: new Float32Array([100, 100, 20, 20, .5, .8, .1]) };
    expect(decodeDetections(output, 2, .45, meta)).toHaveLength(0);
    expect(decodeDetections(output, 2, .35, meta)[0]).toMatchObject({ classId: 0, x: 90, y: 90 });
  });

  it('recognizes a one-class YOLOv5 model even if the dataset has more classes', () => {
    const values = new Float32Array(2 * 6);
    values.set([100, 100, 20, 20, .8, .9], 0);
    const boxes = decodeDetections({ dims: [1, 2000, 6], data: values }, 5, .5, meta);
    expect(boxes[0]).toMatchObject({ classId: 0, score: expect.closeTo(.72, 4) });
  });

  it('applies objectness for a one-class YOLOv5 export when the dataset has exactly two classes', () => {
    const values = new Float32Array(2000 * 6);
    values.set([100, 100, 20, 20, .8, .9], 0);
    const boxes = decodeDetections({ dims: [1, 2000, 6], data: values }, 2, .5, meta);
    expect(boxes).toHaveLength(1);
    expect(boxes[0]).toMatchObject({ classId: 0, score: expect.closeTo(.72, 4), x: 90, y: 90 });
  });

  it('keeps YOLO layout for a row whose class score saturates to an exact integer', () => {
    const values = new Float32Array(2000 * 6);
    values.set([100, 100, 20, 20, .8, 1], 0);
    values.set([300, 300, 40, 40, .7, .93], 6);
    const boxes = decodeDetections({ dims: [1, 2000, 6], data: values }, 1, .5, meta);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toMatchObject({ classId: 0, score: expect.closeTo(.8, 4), x: 90, y: 90 });
    expect(boxes).toContainEqual(expect.objectContaining({ x: 280, y: 280 }));
  });

  it('decodes an end-to-end output row-major even with only five detections', () => {
    const values = new Float32Array(5 * 6);
    for (let row = 0; row < 5; row++) values.set([row * 100, 20, row * 100 + 50, 80, .9, row % 3], row * 6);
    const boxes = decodeDetections({ dims: [1, 5, 6], data: values }, 3, .5, meta);
    expect(boxes).toHaveLength(5);
    expect(boxes).toContainEqual(expect.objectContaining({ classId: 1, x: 100, y: 20, width: 50, height: 60 }));
  });

  it('decodes end-to-end xyxy detections', () => {
    const output = { dims: [1, 1, 6], data: new Float32Array([10, 20, 110, 220, .75, 1]) };
    expect(decodeDetections(output, 3, .5, meta)[0]).toMatchObject({ classId: 1, x: 10, y: 20, width: 100, height: 200 });
  });

  it('decodes an unfiltered end-to-end output with many proposals', () => {
    const values = new Float32Array(2000 * 6);
    values.set([10, 20, 110, 220, .7, 0]);
    const stats = { bestScore: 0 };
    const boxes = decodeDetections({ dims: [1, 2000, 6], data: values }, 3, .5, meta, stats);
    expect(boxes[0]).toMatchObject({ classId: 0, score: expect.closeTo(.7, 4), width: 100, height: 200 });
    expect(stats.bestScore).toBeCloseTo(.7);
  });
});
