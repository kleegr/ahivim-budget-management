/**
 * Stand-in for Node built-ins in the Edge bundle.
 *
 * Next.js compiles instrumentation.ts for the Edge runtime as well as Node.
 * Our register() hook exits immediately unless NEXT_RUNTIME is "nodejs", so
 * the Node-only modules it dynamically imports are never reached there — but
 * webpack still has to resolve them to build the Edge bundle. This module is
 * what those `node:*` imports resolve to in that bundle only.
 *
 * Touching anything here at runtime means the NEXT_RUNTIME guard failed, so
 * every access throws loudly rather than silently returning undefined.
 */
const message =
  "A Node built-in was used in the Edge runtime. This is a bug: Edge code must " +
  "not depend on node:crypto. Session verification belongs in Node-runtime " +
  "server components and route handlers.";

const handler: ProxyHandler<Record<string, never>> = {
  get() {
    throw new Error(message);
  },
  apply() {
    throw new Error(message);
  },
};

const edgeNoop = new Proxy({}, handler);

export default edgeNoop;
