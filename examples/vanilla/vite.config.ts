import { defineConfig } from 'vite'

export default defineConfig({
    plugins: [],
    server: {
        proxy: {
            '/dsn-api': {
                target: 'http://localhost:8888',
                changeOrigin: true,
            },
        },
    },
})
