import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // Vinext applies this guard to multipart route requests as well. The API
      // accepts up to 60 MiB of original images plus multipart metadata.
      bodySizeLimit: '64mb',
    },
  },
};

export default nextConfig;
