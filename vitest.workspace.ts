import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["packages/*/src/**/*.test.ts", "apps/*/src/**/*.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts"],
      passWithNoTests: true,
    },
  },
  {
    test: {
      name: "integration",
      include: ["packages/*/src/**/*.integration.test.ts", "apps/*/src/**/*.integration.test.ts"],
      exclude: ["**/node_modules/**", "**/dist/**"],
      passWithNoTests: true,
    },
  },
]);
