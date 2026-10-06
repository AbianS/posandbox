import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = `http://127.0.0.1:${process.env.POSANDBOX_HTTP_PORT ?? 8100}`;

export default defineConfig({
  root: 'src/web',
  publicDir: 'public',
  plugins: [react()],
  build: { outDir: '../../dist', emptyOutDir: true, chunkSizeWarningLimit: 1600 },
  server: {
    // The engine only accepts same-origin requests: in development the proxy speaks for the page.
    proxy: {
      '/api': {
        target: api,
        ws: true,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on('proxyReq', (req) => req.setHeader('origin', api));
          proxy.on('proxyReqWs', (req) => req.setHeader('origin', api));
        },
      },
    },
  },
});
