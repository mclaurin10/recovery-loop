import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    maxWorkers: 2,
    sequence: {
      concurrent: false,
    },
    coverage: {
      provider: "v8",
    },
  },
});
