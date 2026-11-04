// SPDX-License-Identifier: Apache-2.0
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Other ports let the tests run while Mabari itself, or its Docker image, holds 4317.
const webPort = Number(process.env.MABARI_WEB_PORT ?? 4317);
const apiPort = Number(process.env.MABARI_API_PORT ?? 4327);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    // The server refuses an Origin that doesn't match the Host, so the proxy must pass the
    // browser's Host through. Vite's string shorthand would rewrite it, so changeOrigin is set off.
    proxy: {
      '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false },
      '/ws': { target: `ws://127.0.0.1:${apiPort}`, ws: true, changeOrigin: false },
    },
  },
});
