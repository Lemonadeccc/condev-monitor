import { defineConfig } from 'vite'

export default defineConfig({
    plugins: [],
    build: {
        sourcemap: true,
    },
    server: {
        proxy: {
            '/dsn-api': {
                target: 'http://localhost:8888',
                changeOrigin: true,
            },
        },
    },
})
