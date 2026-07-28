import type { NextConfig } from "next";
import path from "node:path";

/** Empty stand-in used only by the Edge bundle; never executed. */
const NOOP_MODULE = path.resolve("./src/lib/edge-noop.ts");

const nextConfig: NextConfig = {
  serverExternalPackages: ["exceljs", "@neondatabase/serverless", "ws"],
  eslint: { ignoreDuringBuilds: false },

  /**
   * Next.js compiles `instrumentation.ts` for BOTH the Node and Edge runtimes.
   * Our register() hook returns immediately unless NEXT_RUNTIME is "nodejs"
   * and only then dynamically imports the migration runner and the password
   * hasher — but webpack still tries to resolve those imports while building
   * the Edge bundle, and the Edge runtime has no `node:crypto`.
   *
   * Aliasing those Node built-ins away in the Edge build lets that bundle
   * compile. Nothing reaches them at runtime because of the NEXT_RUNTIME
   * guard, and full session verification happens in Node-runtime server
   * components and route handlers, never in Edge middleware.
   */
  webpack: (config, { nextRuntime, webpack }) => {
    if (nextRuntime === "edge") {
      config.plugins = config.plugins ?? [];
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(/^node:/, (resource: { request: string }) => {
          resource.request = NOOP_MODULE;
        }),
      );
    }
    return config;
  },
};

export default nextConfig;
