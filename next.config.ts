import type { NextConfig } from "next";

/**
 * No webpack overrides.
 *
 * An earlier revision replaced every `node:*` import in the Edge bundle with a
 * stub, because instrumentation.ts was compiled for the Edge runtime and
 * transitively pulled in node:crypto. That produced a build full of
 * "'timingSafeEqual' is not exported from 'node:crypto'" warnings which looked
 * like a broken crypto import but were an artefact of the stub.
 *
 * The bootstrap hook has been removed instead, so nothing Node-only is reachable
 * from the Edge graph. src/middleware.ts imports only next/server; every piece
 * of cryptography runs in Node-runtime route handlers and server components.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ["exceljs", "@neondatabase/serverless", "ws"],
  eslint: { ignoreDuringBuilds: false },
  typescript: { ignoreBuildErrors: false },
  async headers() {
    return [
      {
        source: "/tesseract/7.0.0/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
  // Never reuse a client-cached RSC payload across navigations. Every screen is
  // permission-sensitive (role + access scope are re-read from the DB on each
  // request), so a change to a user's role/access must take effect on their very
  // next navigation — not up to five minutes later from the router cache.
  experimental: { staleTimes: { dynamic: 0, static: 0 } },
  // The invoice and reimbursement generators load these Unicode fonts from
  // disk at runtime. Include them in every server trace so deployed functions
  // do not depend on route-specific static analysis finding readFile paths.
  outputFileTracingIncludes: {
    "/*": ["./assets/fonts/**/*.ttf"],
  },
};

export default nextConfig;
