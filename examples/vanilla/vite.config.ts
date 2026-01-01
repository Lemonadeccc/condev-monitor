import { defineConfig } from 'vite'

export default defineConfig({
    plugins: [],
    server: {
        proxy: {
            '/dsn-api': {
                target: 'http://192.168.158.81:8080',
                changeOrigin: true,
                rewrite: path => path.replace(/^\/dsn-api/, ''),
            },
        },
    },
})
