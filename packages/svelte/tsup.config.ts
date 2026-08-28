import { defineConfig } from 'tsup'

const esmEntry = {
    index: 'src/index.ts',
    animation: 'src/animation.ts',
}

export default defineConfig([
    {
        entry: { index: 'src/index.ts' },
        format: ['cjs'],
        outDir: 'build/cjs',
        clean: true,
        external: ['svelte', /^@condev-monitor\//],
    },
    {
        entry: esmEntry,
        format: ['esm'],
        outDir: 'build/esm',
        clean: true,
        splitting: false,
        external: ['svelte', /^@condev-monitor\//],
    },
])
