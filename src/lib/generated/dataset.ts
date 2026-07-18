// Placeholder replaced by scripts/prepare-dataset.mjs before production build.
import type { BoundingBox, ProjectState } from '$lib/annotation/types';
export const project = { name: 'demo', imageDir: '', classes: [], images: [], lastImageId: null } as ProjectState;
export const boxesByImage = {} as Record<string, BoundingBox[]>;
