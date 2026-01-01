import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
    /* config options here */
    output: 'standalone',
    async rewrites() {
        return [
            {
                source: '/api/:path*',
                destination: 'http://192.168.158.81:8081/api/:path*',
            },
            {
                source: '/dsn-api/:path*',
                destination: 'http://192.168.158.81:8080/dsn-api/:path*',
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
