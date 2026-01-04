import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
    /* config options here */
    output: 'standalone',
    async rewrites() {
        // Local dev defaults: Nest APIs run on 8081/8080 (see apps/backend/*/src/main.ts)
        // Override in docker/production via env.
        const apiProxyTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8081'
        const dsnApiProxyTarget = process.env.DSN_API_PROXY_TARGET ?? 'http://localhost:8080'

        return [
            {
                source: '/api/:path*',
                destination: `${apiProxyTarget}/api/:path*`,
            },
            {
                source: '/dsn-api/:path*',
                destination: `${dsnApiProxyTarget}/dsn-api/:path*`,
            },
        ]
    },
}

export default nextConfig

// added by create cloudflare to enable calling `getCloudflareContext()` in `next dev`
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare'
if (process.env.NODE_ENV === 'development') {
    initOpenNextCloudflareForDev()
}
