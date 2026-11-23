import { defineConfig } from 'vite';

export default defineConfig({
  // 相对路径：既能放在域名根，也能挂在 /show3d/ 这类子路径下
  base: './',
  server: { port: 5178, open: false },
  build: { target: 'es2022', chunkSizeWarningLimit: 1500 },
});
