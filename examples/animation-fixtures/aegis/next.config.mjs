import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    optimizePackageImports: [
      "@react-three/drei",
      "@react-three/fiber",
    ],
  },
  outputFileTracingRoot: __dirname,
  reactStrictMode: true,
};

export default nextConfig;
