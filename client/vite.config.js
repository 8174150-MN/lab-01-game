import { defineConfig } from 'vite';
import { resolve } from 'node:path'; // Вказуємо Vite дві сторінки для продакшн-збірки.

export default defineConfig({
  server: {
    proxy: {
      '/health': {
        target: 'http://127.0.0.1:' + (process.env.PORT ?? '3000'),
        changeOrigin: true,
      },
      '/api': {
        target: 'http://127.0.0.1:' + (process.env.PORT ?? '3000'),
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:' + (process.env.PORT ?? '3000'),
        ws: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        game: resolve(import.meta.dirname, 'index.html'),
        workerBenchmark: resolve(import.meta.dirname, 'worker-benchmark.html'),
      },
    },
  },
});
