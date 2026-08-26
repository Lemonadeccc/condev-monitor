import { defineConfig } from 'tsup'

export default defineConfig([
    {
        entry: { index: 'src/index.ts' },
        format: ['cjs'],
        outDir: 'build/cjs',
        clean: true,
        splitting: false,
    },
    {
        entry: { index: 'src/index.ts' },
        format: ['esm'],
        outDir: 'build/esm',
        clean: true,
        splitting: false,
    },
])
