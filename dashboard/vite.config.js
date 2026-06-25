import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies API + provider routes to the local ForkMind proxy (4500),
// so `npm run dashboard:dev` works without CORS while you develop the UI.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4500',
      '/v1': 'http://localhost:4500',
      '/health': 'http://localhost:4500',
    },
  },
  // Built assets are served by the Express proxy in production (forkmind start).
  build: { outDir: 'dist' },
});
