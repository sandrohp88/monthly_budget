/** @type {import('next').NextConfig} */

// Centralised security headers. Caddy also sets these in production; Next
// applies them so the same protections cover (a) `npm run dev`, (b) the
// loopback `127.0.0.1:3000` path used by cloudflared, and (c) any future
// deploy that doesn't go through Caddy. Browser ALWAYS honours the strictest
// CSP if multiple Content-Security-Policy headers are present.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value:
      "accelerometer=(), autoplay=(), camera=(), display-capture=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), midi=(), payment=(), usb=(), xr-spatial-tracking=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data: https://cdn.plaid.com",
      "font-src 'self' data:",
      // 'unsafe-inline' is needed for Next's hydration script and for the
      // inline styles emitted by Tailwind utility classes via styled-jsx;
      // dropping it requires nonces or hashes per page (separate cleanup).
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.plaid.com",
      "connect-src 'self' https://*.plaid.com",
      "frame-src 'self' https://*.plaid.com",
      "worker-src 'self' blob:",
      "manifest-src 'self'",
    ].join("; "),
  },
];

const nextConfig = {
  // Standalone is only needed for the Docker image. Setting it for local
  // builds breaks `next start`, which we want for Playwright e2e.
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" } : {}),
  reactStrictMode: true,
  serverExternalPackages: ["better-sqlite3", "argon2"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
