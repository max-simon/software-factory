/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const controlPlane = process.env.FACTORY_URL ?? 'http://127.0.0.1:4700';
// The control plane refuses foreign origins, so the dev server presents itself as the control plane.
const toControlPlane = { target: controlPlane, changeOrigin: true, headers: { origin: controlPlane } };

export default defineConfig({
  plugins: [react()],
  // Component tests only; model.test.ts runs under node --test with the rest of the repo.
  test: { include: ['src/**/*.test.tsx'] },
  server: {
    proxy: {
      '/auth': toControlPlane,
      '/projects': toControlPlane,
      '/tasks': toControlPlane,
      '/users': toControlPlane,
      // So the `claude mcp add` command the account page shows works against the dev server too.
      '/mcp': toControlPlane,
    },
  },
});
