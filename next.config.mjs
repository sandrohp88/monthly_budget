/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standalone is only needed for the Docker image. Setting it for local
  // builds breaks `next start`, which we want for Playwright e2e.
  ...(process.env.NEXT_OUTPUT_STANDALONE === "1" ? { output: "standalone" } : {}),
  reactStrictMode: true,
  serverExternalPackages: ["better-sqlite3", "argon2"],
};

export default nextConfig;
