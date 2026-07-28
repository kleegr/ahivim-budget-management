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
};

export default nextConfig;
