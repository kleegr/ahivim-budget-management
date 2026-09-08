import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // Next preserves JSX for its own compiler; rendered page tests need React output.
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests share one PostgreSQL and reset the schema, so test
    // files must not run concurrently.
    fileParallelism: false,
  },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});
