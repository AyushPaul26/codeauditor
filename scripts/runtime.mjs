import path from "node:path";
import os from "node:os";
import net from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));
export function runtimeDir({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (env.CODEAUDITOR_DATA_DIR) {
    if (!paths.isAbsolute(env.CODEAUDITOR_DATA_DIR))
      throw new Error("CODEAUDITOR_DATA_DIR must be an absolute path.");
    return env.CODEAUDITOR_DATA_DIR;
  }
  return platform === "win32"
    ? paths.join(
        env.LOCALAPPDATA || paths.join(home, "AppData", "Local"),
        "CodeAuditor",
      )
    : paths.join(
        env.XDG_DATA_HOME || paths.join(home, ".local", "share"),
        "codeauditor",
      );
}
export function configPath({ dir = runtimeDir() } = {}) {
  return path.join(dir, "runtime.json");
}
export function defaultConfig() {
  return {
    version: 1,
    primary: {
      llamaServerPath: "",
      llamaServerSha256: "",
      modelPath: "",
      modelSha256: "",
      modelId: "qwen3-1.7b",
      port: 8080,
    },
    harness: { url: "http://127.0.0.1:8790" },
    mcp: { port: 8792, token: randomBytes(32).toString("hex") },
  };
}
function validPort(value) {
  return Number.isInteger(value) && value >= 1024 && value <= 65535;
}
function localUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}
export function validateConfig(config) {
  if (
    !config ||
    config.version !== 1 ||
    !config.primary ||
    !config.harness ||
    !config.mcp
  )
    throw new Error(
      "runtime.json must use the version 1 example configuration.",
    );
  for (const [slot, model] of Object.entries({
    primary: config.primary,
    ...(config.fallback ? { fallback: config.fallback } : {}),
  })) {
    if (
      !model ||
      !validPort(model.port) ||
      typeof model.modelId !== "string" ||
      !/^[a-z0-9][a-z0-9_.-]*$/.test(model.modelId)
    )
      throw new Error(
        `runtime.json ${slot} requires a valid modelId and port.`,
      );
    for (const key of ["llamaServerPath", "modelPath", "modelSha256"])
      if (typeof model[key] !== "string")
        throw new Error(`runtime.json ${slot}.${key} must be a string.`);
    if (
      model.llamaServerSha256 !== undefined &&
      typeof model.llamaServerSha256 !== "string"
    )
      throw new Error(
        `runtime.json ${slot}.llamaServerSha256 must be a string.`,
      );
  }
  if (!localUrl(config.harness.url))
    throw new Error(
      "runtime.json harness.url must be a loopback HTTP origin without credentials.",
    );
  if (!validPort(config.mcp.port) || !/^[a-f0-9]{64}$/.test(config.mcp.token))
    throw new Error(
      "runtime.json requires a valid MCP port and private token; rerun setup only after preserving your configuration.",
    );
  const ports = [
    new URL(config.harness.url).port || "80",
    config.primary.port,
    config.mcp.port,
    ...(config.fallback ? [config.fallback.port] : []),
  ].map(Number);
  if (new Set(ports).size !== ports.length)
    throw new Error("runtime.json services must have distinct ports.");
  return config;
}
export async function loadConfig({ dir = runtimeDir() } = {}) {
  try {
    return validateConfig(
      JSON.parse(await readFile(configPath({ dir }), "utf8")),
    );
  } catch (error) {
    throw new Error(
      `Cannot read valid runtime.json at ${configPath({ dir })}. Run npm run setup:local, or repair this existing file.`,
      { cause: error },
    );
  }
}
export async function saveConfig(config, { dir = runtimeDir() } = {}) {
  validateConfig(config);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const destination = configPath({ dir });
  const temporary = `${destination}.${randomBytes(8).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, destination);
  if (process.platform !== "win32") await chmod(destination, 0o600);
}
export async function ensureRuntime({ dir = runtimeDir() } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  for (const name of [
    "bin",
    "models",
    "logs",
    "fixtures",
    "venvs",
    "demos",
    "trueforge",
    "tools",
  ])
    await mkdir(path.join(dir, name), { recursive: true, mode: 0o700 });
  try {
    await access(configPath({ dir }));
    return await loadConfig({ dir });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const config = defaultConfig();
    try {
      await writeFile(
        configPath({ dir }),
        `${JSON.stringify(config, null, 2)}\n`,
        { mode: 0o600, flag: "wx" },
      );
    } catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
    }
    return loadConfig({ dir });
  }
}
export async function assertPortAvailable(port) {
  if (!validPort(port))
    throw new Error("Port must be an integer from 1024 to 65535.");
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Loopback port ${port} is occupied or unavailable. Stop the conflicting service or change runtime.json.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
}
export async function verifyFile(file, expectedHash) {
  if (!file || !/^[a-fA-F0-9]{64}$/.test(expectedHash || ""))
    throw new Error(
      "A local file and trusted expected SHA-256 are required; see docs/windows-setup.md.",
    );
  const digest = createHash("sha256");
  try {
    for await (const chunk of createReadStream(file)) digest.update(chunk);
  } catch (error) {
    throw new Error(`Cannot read configured asset: ${file}`, { cause: error });
  }
  if (digest.digest("hex") !== expectedHash.toLowerCase())
    throw new Error(
      `SHA-256 mismatch for ${file}. Do not launch this asset; verify its provenance.`,
    );
}
export async function run(
  executable,
  args,
  { cwd, env = process.env, inherit = false } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      shell: false,
      stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    if (!inherit) {
      child.stdout.on("data", (chunk) => {
        output = (output + chunk).slice(-256 * 1024);
      });
      child.stderr.on("data", (chunk) => {
        output = (output + chunk).slice(-256 * 1024);
      });
    }
    child.once("error", (error) =>
      reject(
        new Error(
          `Cannot start ${path.basename(executable)}. Install it or correct its configured path.`,
          { cause: error },
        ),
      ),
    );
    child.once("exit", (code) =>
      code === 0
        ? resolve(output.trim())
        : reject(
            new Error(
              `${path.basename(executable)} exited with code ${code}. ${inherit ? "See process output above." : output.slice(-4000)}`,
            ),
          ),
    );
  });
}
export async function foreground(
  executable,
  args,
  { cwd, env = process.env, readyUrl, label } = {},
) {
  const child = spawn(executable, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
  let exited = false;
  const stop = () => {
    if (exited || !child.pid) return;
    if (process.platform === "win32")
      spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
    else child.kill("SIGTERM");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const readiness = setInterval(async () => {
    if (!readyUrl || exited) return;
    try {
      const response = await fetch(readyUrl, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        clearInterval(readiness);
        console.log(
          `${label || "Service"} ready at ${new URL(readyUrl).origin}`,
        );
      }
    } catch {
      /* Keep readiness separate from process startup. */
    }
  }, 1000);
  readiness.unref();
  await new Promise((resolve, reject) => {
    child.once("error", (error) =>
      reject(
        new Error(
          `Cannot launch ${path.basename(executable)}; check runtime.json and prerequisites.`,
          { cause: error },
        ),
      ),
    );
    child.once("exit", (code, signal) => {
      exited = true;
      code === 0 || signal === "SIGTERM"
        ? resolve()
        : reject(
            new Error(
              `${label || "Service"} exited (${code ?? signal}). See output above.`,
            ),
          );
    });
  }).finally(() => {
    exited = true;
    clearInterval(readiness);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  });
}
export function isMain(url) {
  return (
    process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === url
  );
}
export function reportFailure(error) {
  console.error(
    error instanceof Error
      ? error.message
      : "Setup failed. See docs/windows-setup.md.",
  );
  process.exitCode = 1;
}
