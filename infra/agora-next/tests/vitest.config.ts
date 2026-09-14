import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve("src") } },
  test: { include: ["fleet-tests/*.test.ts"], environment: "node", maxWorkers: 1, minWorkers: 1 },
});
