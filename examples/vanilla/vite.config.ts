import { defineConfig } from 'vite'

export default defineConfig({
    plugins: [],
    server: {
        proxy: {
            '/dsn-api': {
                target: 'http://localhost:8080',
                changeOrigin: true,
                rewrite: path => path.replace(/^\/dsn-api/, ''),
            },
        },
    },
})
