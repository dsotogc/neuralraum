import { defineConfig } from 'vite';

const proxy = { '/v1': 'http://127.0.0.1:8000' };
export default defineConfig({
  server: { host: 'localhost', port: 5173, strictPort: true, proxy },
  preview: { host: 'localhost', port: 5173, strictPort: true, proxy },
});
