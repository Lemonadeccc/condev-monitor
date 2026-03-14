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
    },
])
