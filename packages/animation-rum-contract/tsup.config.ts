import { defineConfig } from 'tsup'

const entries = { index: 'src/index.ts', testing: 'src/testing.ts' }

export default defineConfig([
    {
        entry: entries,
        format: ['cjs'],
        outDir: 'build/cjs',
        clean: true,
        splitting: false,
    },
    {
        entry: entries,
        format: ['esm'],
        outDir: 'build/esm',
        clean: true,
        splitting: false,
    },
])
