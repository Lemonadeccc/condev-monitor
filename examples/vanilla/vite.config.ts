import { defineConfig } from 'vite'

export default defineConfig({
    plugins: [],
    server: {
        proxy: {
            '/dsn-api': {
                // When using the repo docker-compose, access APIs via Caddy (default http://localhost:8888).
                target: 'http://localhost:8888',
                changeOrigin: true,
            },
        },
    },
})
