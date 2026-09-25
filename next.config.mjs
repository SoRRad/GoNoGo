/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // better-sqlite3 is a native addon: keep it external to the server bundle.
  serverExternalPackages: ['better-sqlite3', 'pngjs', 'archiver', 'nodemailer'],
  poweredByHeader: false,
  eslint: { ignoreDuringBuilds: true },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          // A surgeon's access token travels in the URL path. Without this, the
          // browser would send that whole URL as the Referer on any outbound
          // request, handing the token to whatever it navigated to.
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // The annotation surface must never be embeddable: a framed copy could
          // be overlaid to capture pointer input or mislead about what is signed in.
          { key: 'X-Frame-Options', value: 'DENY' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              // No CDN, no webfonts, no analytics: everything is served from here.
              "img-src 'self' data: blob:",
              "style-src 'self' 'unsafe-inline'",
              // Next's hydration bootstrap is inline; nothing else executes.
              "script-src 'self' 'unsafe-inline'",
              "connect-src 'self'",
              "font-src 'self'",
              "form-action 'self'",
              "base-uri 'self'",
              "object-src 'none'",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
