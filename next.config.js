/** @type {import('next').NextConfig} */

// "Collecting page data" forks one worker per CPU, and each worker needs a few
// hundred MB. On a memory-constrained host that exhausts the commit limit and
// the build dies partway through with an unhelpful OOM. Opt in with
// NEXT_BUILD_CPUS=1 there; left unset, normal parallel builds are unaffected.
const constrainedBuild = process.env.NEXT_BUILD_CPUS
  ? { experimental: { cpus: Number(process.env.NEXT_BUILD_CPUS), workerThreads: false } }
  : {};

const nextConfig = {
  reactStrictMode: true,
  images: { unoptimized: true },
  ...constrainedBuild,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net",
              "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
              "font-src 'self' https://fonts.gstatic.com",
              // http: is required for LAN IP cameras (MJPEG feeds are plain HTTP)
              "img-src 'self' data: blob: http: https:",
              "media-src 'self' blob: http: https:",
              "connect-src 'self' https://cdn.jsdelivr.net https://storage.googleapis.com http: https:",
              "worker-src 'self' blob:",
              "object-src 'none'",
              "frame-ancestors 'self'",
            ].join("; "),
          },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
