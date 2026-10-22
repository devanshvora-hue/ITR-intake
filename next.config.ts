import type { NextConfig } from "next";

// The browser only talks to this site. Requests to /api/* are forwarded to
// the local FastAPI server, so session cookies stay first-party and no
// cross-origin (CORS) access is needed.
const apiOrigin = process.env.ITR_API_ORIGIN ?? "http://127.0.0.1:8000";

// Security headers for the site's own pages. The API (/api/*) sets its own.
// A Content-Security-Policy is deliberately not set yet: a strict policy needs
// per-request nonces for Next.js inline scripts and must be tested first
// (see HANDOFF.md).
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/((?!api/).*)", headers: securityHeaders }];
  },
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiOrigin}/api/:path*` }];
  },
};

export default nextConfig;
