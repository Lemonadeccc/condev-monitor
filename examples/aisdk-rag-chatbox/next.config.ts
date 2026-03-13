import path from 'node:path'
import type { NextConfig } from 'next'

const workspaceRoot = path.resolve(process.cwd(), '../..')

const nextConfig: NextConfig = {
    outputFileTracingRoot: workspaceRoot,
    serverExternalPackages: ['pdf-parse'],
}

export default nextConfig
