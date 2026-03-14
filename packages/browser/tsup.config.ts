import { defineConfig } from 'tsup'

const entry = {
    index: 'src/index.ts',
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
        clean: true,
        splitting: false,
    },
    {
        entry,
        format: ['iife'],
        outDir: 'build/umd',
        name: 'monitor-sdk-browser',
        splitting: false,
    },
])
