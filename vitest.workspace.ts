import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      env: { FLEET_OPERATOR_EMAILS_JSON: JSON.stringify([1, 2, 3, 4, 5].map(i => `operator${i}@example.com`)) },
      include: [
        "packages/*/src/**/*.test.ts",
        "apps/*/src/**/*.test.ts",
        "apps/*/src/**/*.test.tsx",
        "experiments/**/*.test.ts",
      ],
      exclude: ["**/node_modules/**", "**/dist/**", "**/*.integration.test.ts", "experiments/fixtures/repos/**"],
      passWithNoTests: true,
    },
    esbuild: { jsx: "automatic" },
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
