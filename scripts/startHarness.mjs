import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  assertPortAvailable,
  ensureRuntime,
  foreground,
  isMain,
  projectRoot,
  reportFailure,
  runtimeDir,
} from "./runtime.mjs";

export function harnessEnvironment(dir) {
  return {
    HOST: "127.0.0.1",
    STANDALONE: "true",
    SQLITE_PATH: path.join(dir, "trueforge", "db.sqlite"),
    NETWORK_POLICY_ENABLED: "true",
    OUTBOUND_URL_ALLOWED_HOSTS: '["127.0.0.1","localhost"]',
    XDG_DATA_HOME: dir,
    XDG_CONFIG_HOME: dir,
    XDG_CACHE_HOME: path.join(dir, "cache"),
    XDG_STATE_HOME: path.join(dir, "logs"),
    LOCALAPPDATA: dir,
    APPDATA: dir,
  };
}
export async function startHarness() {
  const dir = runtimeDir();
  const config = await ensureRuntime({ dir });
  const port = Number(new URL(config.harness.url).port || 80);
  await assertPortAvailable(port);
  const packageDir = path.join(
    projectRoot,
    "node_modules",
    "@truefoundry",
    "trueforge",
  );
  const installed = JSON.parse(
    await readFile(path.join(packageDir, "package.json"), "utf8"),
  );
  if (installed.version !== "0.184.2")
    throw new Error(
      "TrueForge runtime must be 0.184.2. Run npm ci in the project checkout.",
    );
  console.log(
    `Starting pinned TrueForge ${installed.version} at ${config.harness.url}; keep this terminal open.`,
  );
  await foreground(
    process.execPath,
    [path.join(packageDir, "dist", "cli.js"), "--port", String(port)],
    {
      env: { ...process.env, ...harnessEnvironment(dir) },
      cwd: dir,
      readyUrl: `${config.harness.url}/healthz`,
      label: "TrueForge",
    },
  );
}
if (isMain(import.meta.url)) startHarness().catch(reportFailure);
