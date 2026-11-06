import { build } from "esbuild";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
// The upstream downloader reads npm proxy variables at import time. Preserve
// the session proxy and CA trust instead of falling back to direct networking.
if (!process.env.npm_config_https_proxy && process.env.HTTPS_PROXY)
  process.env.npm_config_https_proxy = process.env.HTTPS_PROXY;
if (!process.env.npm_config_proxy && process.env.HTTP_PROXY)
  process.env.npm_config_proxy = process.env.HTTP_PROXY;
const { runTests } = await import("@vscode/test-electron");
const temporary = await mkdtemp(path.join(tmpdir(), "codeauditor-extension-"));
try {
  await import("./build.mjs");
  await build({
    entryPoints: [path.join(root, "tests/extension/suite.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["vscode"],
    outfile: path.join(root, "out/extension-tests.cjs"),
  });
  const workspace = path.join(temporary, "workspace");
  await mkdir(workspace);
  await writeFile(
    path.join(workspace, "sample.py"),
    "FIRST = 1\n\nSECOND = 2\n",
  );
  const options = {
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "out/extension-tests.cjs"),
    launchArgs: [
      workspace,
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--no-sandbox",
      "--disable-gpu",
      "--user-data-dir=" + path.join(temporary, "profile"),
    ],
    extensionTestsEnv: {
      CODEAUDITOR_DATA_DIR: path.join(temporary, "runtime"),
    },
    version: "1.106.3",
    ...(process.env.CODEAUDITOR_VSCODE_EXECUTABLE
      ? { vscodeExecutablePath: process.env.CODEAUDITOR_VSCODE_EXECUTABLE }
      : {}),
  };
  await runTests(options);
} catch (error) {
  console.error(
    "VS Code extension-host checks did not complete. They require a desktop/display and access to the official VS Code test download, or CODEAUDITOR_VSCODE_EXECUTABLE pointing to an existing VS Code binary.",
  );
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await rm(temporary, { recursive: true, force: true });
}
