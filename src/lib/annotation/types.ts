export interface BoundingBox {
  id: string;
  classId: number;
  /** Confidence of an automatically detected box, from 0 to 1. */
  confidence?: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageItem {
  id: string;
  name: string;
  width: number;
  height: number;
  annotated: boolean;
  excluded?: boolean;
  empty: boolean;
  boxCount: number;
  assetPath: string;
  index?: number;
}

export interface ProjectState {
  name: string;
  imageDir: string;
  classes: string[];
  images: ImageItem[];
  lastImageId: string | null;
  totalImages?: number;
  annotatedCount?: number;
  activeImages?: number;
  excludedCount?: number;
}

export interface Viewport {
  scale: number;
  offsetX: number;
  offsetY: number;
}
