import type { NextConfig } from "next";

// The API is part of this Next.js app (app/api/*), so pages and API share one
// origin: session cookies stay first-party and no CORS access is needed.

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
};

export default nextConfig;
