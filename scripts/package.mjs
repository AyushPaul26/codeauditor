import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
await mkdir(new URL("../artifacts/", import.meta.url), { recursive: true });
// Use Node directly for cross-platform execution, not .cmd shell wrappers.
const cli = fileURLToPath(
  new URL("../node_modules/@vscode/vsce/vsce", import.meta.url),
);
const child = spawn(
  process.execPath,
  [cli, "package", "--no-dependencies", "--out", "artifacts/codeauditor.vsix"],
  {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
    shell: false,
  },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
