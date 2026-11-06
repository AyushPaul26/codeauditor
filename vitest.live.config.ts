import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/live/**/*.test.ts"],
    testTimeout: 600000,
    hookTimeout: 60000,
    fileParallelism: false,
  },
});
