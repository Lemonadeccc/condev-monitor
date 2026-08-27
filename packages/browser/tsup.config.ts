import { defineConfig } from 'tsup'

const moduleEntry = {
    index: 'src/index.ts',
    animation: 'src/animation.ts',
}

const browserRoot = '@condev-monitor/monitor-sdk-browser'

export default defineConfig([
    {
        entry: moduleEntry,
        format: ['cjs'],
        outDir: 'build/cjs',
        clean: true,
        external: [browserRoot],
        noExternal: ['@condev-monitor/animation-rum-contract'],
    },
    {
        entry: moduleEntry,
        format: ['esm'],
        outDir: 'build/esm',
        clean: true,
        splitting: false,
        external: [browserRoot],
        noExternal: ['@condev-monitor/animation-rum-contract'],
    },
    {
        entry: { index: 'src/index.ts' },
        format: ['iife'],
        outDir: 'build/umd',
        name: 'monitor-sdk-browser',
        splitting: false,
        noExternal: ['@condev-monitor/animation-rum-contract'],
    },
])
