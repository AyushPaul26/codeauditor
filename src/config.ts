import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
export interface LocalRuntime {
  version: number;
  mcp: { port: number; token: string };
  harness: { url: string; agentId?: string; fallbackAgentId?: string };
  pythonPath?: string;
  primary?: { modelId: string };
}
export function localRuntimeDir(): string {
  return (
    process.env.CODEAUDITOR_DATA_DIR ??
    (process.platform === "win32"
      ? path.join(
          process.env.LOCALAPPDATA ?? path.join(homedir(), "AppData", "Local"),
          "CodeAuditor",
        )
      : path.join(
          process.env.XDG_DATA_HOME ?? path.join(homedir(), ".local", "share"),
          "codeauditor",
        ))
  );
}
export async function readRuntime(): Promise<LocalRuntime> {
  let config: LocalRuntime;
  try {
    config = JSON.parse(
      await readFile(path.join(localRuntimeDir(), "runtime.json"), "utf8"),
    );
  } catch {
    throw new Error(
      "Local setup is missing. From the CodeAuditor repository run npm run setup:local, then follow docs/windows-setup.md.",
    );
  }
  if (
    config.version !== 1 ||
    !config.mcp ||
    !/^[a-f0-9]{64}$/.test(config.mcp.token) ||
    !Number.isInteger(config.mcp.port)
  )
    throw new Error(
      "Invalid local runtime configuration. Repair runtime.json using the example configuration.",
    );
  return config;
}
