import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    headless: true,
    launchOptions: {
      executablePath: process.env.CODEAUDITOR_CHROMIUM_PATH || undefined,
      args: process.env.CI ? ["--no-sandbox"] : [],
    },
  },
  outputDir: "artifacts/browser",
});
