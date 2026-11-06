import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: { alias: { vscode: fileURLToPath(new URL("./tests/fixtures/vscode-stub.ts", import.meta.url)) } },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    testTimeout: 15000,
  },
});
