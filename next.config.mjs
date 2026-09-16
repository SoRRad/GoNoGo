/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // better-sqlite3 is a native addon: keep it external to the server bundle.
  serverExternalPackages: ['better-sqlite3', 'pngjs', 'archiver'],
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
