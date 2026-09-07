import { networkInterfaces } from 'node:os';

const isDevelopment = process.env.NODE_ENV !== 'production';
// Binding to 0.0.0.0 requires explicitly allowing this machine's browser origins for HMR.
const developmentOrigins = isDevelopment
  ? [...new Set(['127.0.0.1', ...Object.values(networkInterfaces()).flatMap((addresses) =>
    (addresses ?? []).filter(({ family }) => family === 'IPv4').map(({ address }) => address))])]
  : undefined;
const scriptPolicy = isDevelopment
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";

const securityHeaders = [
  { key: 'Content-Security-Policy', value: `default-src 'self'; ${scriptPolicy}; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'` },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  distDir: process.env.XHS_NEXT_DIST_DIR || '.next',
  allowedDevOrigins: developmentOrigins,
  serverExternalPackages: ['exceljs', 'sharp'],
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
