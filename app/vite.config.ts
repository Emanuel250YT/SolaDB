import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The app consumes the SDK straight from source (IDL JSON included), so both always match.
export default defineConfig({
  resolve: {
    alias: { '@soladb/sdk': fileURLToPath(new URL('../sdk/src/index.ts', import.meta.url)) },
  },
  server: { port: 5173 },
});
