import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { datasetDevPlugin } from './scripts/dev-dataset-plugin';

export default defineConfig({
  plugins: [datasetDevPlugin(), sveltekit()],
  server: {
    watch: {
      usePolling: true,
      interval: 500,
      ignored: ['**/static/dataset/**', '**/node_modules/**', '**/build/**']
    }
  }
});
