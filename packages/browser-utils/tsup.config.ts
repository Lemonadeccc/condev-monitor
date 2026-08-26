import { defineConfig } from 'tsup'

const entry = {
    index: 'src/index.ts',
    'performance-runtime': 'src/performance-runtime.ts',
    'web-vitals-runtime': 'src/web-vitals-runtime.ts',
}

export default defineConfig([
    {
        entry,
        format: ['cjs'],
        outDir: 'build/cjs',
        clean: true,
    },
    {
        entry,
        format: ['esm'],
        outDir: 'build/esm',
    },
    {
        entry,
        format: ['iife'],
        outDir: 'build/umd',
    },
])
