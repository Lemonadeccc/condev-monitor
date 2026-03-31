import { defineConfig } from 'tsup'

const shared = {
    external: ['ai', 'react', 'react-dom', 'next', '@opentelemetry/api', '@opentelemetry/sdk-trace-base', /^@condev-monitor\//],
}

const clientBanner = { js: '"use client";' }

export default defineConfig([
    // Client entries (index + client) — need "use client"
    {
        entry: {
            index: 'src/index.ts',
            client: 'src/client.ts',
            chat: 'src/chat.ts',
        },
        format: ['cjs'],
        outDir: 'build/cjs',
        clean: true,
        banner: clientBanner,
        ...shared,
    },
    {
        entry: {
            index: 'src/index.ts',
            client: 'src/client.ts',
            chat: 'src/chat.ts',
        },
        format: ['esm'],
        outDir: 'build/esm',
        clean: true,
        splitting: false,
        banner: clientBanner,
        ...shared,
    },
    // Server entry — no "use client"
    {
        entry: { server: 'src/server.ts' },
        format: ['cjs'],
        outDir: 'build/cjs',
        ...shared,
    },
    {
        entry: { server: 'src/server.ts' },
        format: ['esm'],
        outDir: 'build/esm',
        splitting: false,
        ...shared,
    },
])
