/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  // @prisma/client + @node-rs/argon2 are node-native; keep them out of the bundle.
  serverExternalPackages: ['@prisma/client', '@node-rs/argon2'],
  experimental: {
    serverActions: {
      bodySizeLimit: process.env.PM_ATTACHMENT_ACTION_BODY_LIMIT || '30mb',
    },
  },
};

export default nextConfig;
