import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
    /* config options here */
    async rewrites() {
        return [
            {
                source: '/api/:path*',
                destination: 'http://localhost:8091/api/:path*',
            },
            {
                source: '/dsn-api/:path*',
                destination: 'http://localhost:8000/dsn-api/:path*',
            },
        ]
    },
}

export default nextConfig

// added by create cloudflare to enable calling `getCloudflareContext()` in `next dev`
import { initOpenNextCloudflareForDev } from '@opennextjs/cloudflare'
initOpenNextCloudflareForDev()
