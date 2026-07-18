import type { BoundingBox } from './types';

const copy = (boxes: BoundingBox[]) => boxes.map((box) => ({ ...box }));

export class BoxHistory {
  private past: BoundingBox[][] = [];
  private future: BoundingBox[][] = [];

  push(previous: BoundingBox[]) {
    this.past.push(copy(previous));
    if (this.past.length > 80) this.past.shift();
    this.future = [];
  }

  undo(current: BoundingBox[]) {
    const previous = this.past.pop();
    if (!previous) return null;
    this.future.push(copy(current));
    return copy(previous);
  }

  redo(current: BoundingBox[]) {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(copy(current));
    return copy(next);
  }

  reset() { this.past = []; this.future = []; }
}
