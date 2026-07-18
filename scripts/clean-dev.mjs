import { rm } from 'node:fs/promises';
import path from 'node:path';

// Production/Pages builds place copied assets here. Dev serves the source
// dataset through /__boxscribe and must never let Vite watch that tree.
await rm(path.resolve('static', 'dataset'), { recursive: true, force: true });
