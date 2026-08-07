import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/live/**/*.live.ts"],
    testTimeout: 180_000,
    hookTimeout: 30_000,
    pool: "forks",
    sequence: { concurrent: false },
  },
});
