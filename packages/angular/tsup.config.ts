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
        external: ['@angular/core', /^@condev-monitor\//],
    },
    {
        entry,
        format: ['esm'],
        outDir: 'build/esm',
        clean: true,
        splitting: false,
        external: ['@angular/core', /^@condev-monitor\//],
    },
])
