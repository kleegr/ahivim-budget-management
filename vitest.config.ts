import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests share one PostgreSQL and reset the schema, so test
    // files must not run concurrently.
    fileParallelism: false,
  },
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
});
