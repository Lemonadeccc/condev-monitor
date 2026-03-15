import { defineConfig } from 'tsup'

const entry = {
    index: 'src/index.ts',
}

const banner = { js: '"use client";' }

export default defineConfig([
    {
        entry,
        format: ['cjs'],
        outDir: 'build/cjs',
        clean: true,
        external: ['react', 'react-dom', /^@condev-monitor\//],
        banner,
    },
    {
        entry,
        format: ['esm'],
        outDir: 'build/esm',
        clean: true,
        splitting: false,
        external: ['react', 'react-dom', /^@condev-monitor\//],
        banner,
    },
])
