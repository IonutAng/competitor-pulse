import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development Vite serves the React app and proxies API calls to the backend, so no CORS
// configuration is needed. In production the backend serves the built files itself.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
});
