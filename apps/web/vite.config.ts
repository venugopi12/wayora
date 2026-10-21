import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
  },
  preview: {
    port: 4173,
  },
  build: {
    // Production maps are generated for debugging and error tracking but are
    // never referenced from the bundle (`hidden`: no sourceMappingURL), and
    // scripts/extract-sourcemaps.mjs moves them out of dist/ so a deploy of
    // dist/ can't publish them. The dev server always has full source maps.
    sourcemap: 'hidden',
    target: 'es2022',
    rolldownOptions: {
      output: {
        // Split rarely-changing vendor code into separately cacheable chunks.
        codeSplitting: {
          groups: [
            {
              name: 'react',
              test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/,
            },
            {
              name: 'motion',
              test: /node_modules[\\/](motion|motion-dom|motion-utils|framer-motion)[\\/]/,
            },
            {
              name: 'data',
              test: /node_modules[\\/](@tanstack|zod|react-hook-form|@hookform)[\\/]/,
            },
          ],
        },
      },
    },
  },
});
