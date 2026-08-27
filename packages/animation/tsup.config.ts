import { defineConfig } from 'tsup'

const entry = {
    index: 'src/index.ts',
    devtools: 'src/devtools.ts',
}

export default defineConfig([
    {
        entry,
        format: ['cjs'],
        outDir: 'build/cjs',
        clean: true,
        splitting: false,
        noExternal: ['@condev-monitor/animation-rum-contract'],
    },
    {
        entry,
        format: ['esm'],
        outDir: 'build/esm',
        clean: true,
        splitting: false,
        noExternal: ['@condev-monitor/animation-rum-contract'],
    },
])
