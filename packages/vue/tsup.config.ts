import { defineConfig } from 'tsup'

const entry = {
    index: 'src/index.ts',
    animation: 'src/animation.ts',
}

export default defineConfig([
    {
        entry,
        format: ['cjs'],
        outDir: 'build/cjs',
        clean: true,
        external: ['vue', /^@condev-monitor\//],
    },
    {
        entry,
        format: ['esm'],
        outDir: 'build/esm',
        clean: true,
        splitting: false,
        external: ['vue', /^@condev-monitor\//],
    },
])
