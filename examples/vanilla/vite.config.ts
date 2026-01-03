import { defineConfig } from 'vite'

export default defineConfig({
    plugins: [],
    server: {
        proxy: {
            '/dsn-api': {
                target: 'http://152.53.88.58:8080',
                changeOrigin: true,
                rewrite: path => path.replace(/^\/dsn-api/, ''),
            },
        },
    },
})
