import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig(() => {
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url))

  return {
    server: {
      port: 5181,
      host: '0.0.0.0',
    },
    resolve: {
      alias: [
        {
          find: /^@\//,
          replacement: '/src/',
        },
        {
          find: '@condev-monitor/monitor-sdk-browser',
          replacement: path.join(
            repoRoot,
            'packages/browser/build/esm/index.mjs',
          ),
        },
        {
          find: '@condev-monitor/monitor-sdk-core',
          replacement: path.join(
            repoRoot,
            'packages/core/build/esm/index.mjs',
          ),
        },
        {
          find: '@condev-monitor/monitor-sdk-browser-utils',
          replacement: path.join(
            repoRoot,
            'packages/browser-utils/build/esm/index.mjs',
          ),
        },
      ],
    },

    plugins: [react()],
  }
})
