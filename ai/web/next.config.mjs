/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // @prisma/client + @node-rs/argon2 are node-native; keep them out of the bundle.
  serverExternalPackages: ['@prisma/client', '@node-rs/argon2'],
  experimental: {
    serverActions: {
      bodySizeLimit: '1mb',
    },
  },
};

export default nextConfig;
