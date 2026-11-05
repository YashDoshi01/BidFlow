import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The browser talks to ONE origin: the Vite dev server (and, later, NGINX in
// production). `/api/*` is forwarded to the API with the prefix removed, and the
// WebSocket endpoint `/socket.io` is forwarded as a WebSocket. Because everything is
// same-origin, the API needs no CORS configuration.
const apiTarget = process.env['API_URL'] ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: Number(process.env['WEB_PORT'] ?? 5173),
    proxy: {
      '/api': { target: apiTarget, rewrite: (path) => path.replace(/^\/api/, '') },
      '/socket.io': { target: apiTarget, ws: true },
    },
  },
});
