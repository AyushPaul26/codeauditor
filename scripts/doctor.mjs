import path from "node:path";
import { access, readFile } from "node:fs/promises";
import {
  configPath,
  isMain,
  loadConfig,
  projectRoot,
  reportFailure,
  run,
  runtimeDir,
} from "./runtime.mjs";
import { UV_VERSION, uvBinaryPath } from "./prepareFixture.mjs";

export async function doctor({
  dir = runtimeDir(),
  probeServices = true,
} = {}) {
  const checks = [];
  const record = (name, status, detail) =>
    checks.push({ name, status, detail });
  const [major, minor] = process.versions.node.split(".").map(Number);
  record(
    "Node.js",
    major > 22 || (major === 22 && minor >= 14) ? "ok" : "missing",
    `${process.version}; requires >=22.14`,
  );
  for (const [name, executable, args] of [
    ["Git", "git", ["--version"]],
    [
      "VS Code CLI",
      process.platform === "win32" ? "cmd.exe" : "code",
      process.platform === "win32"
        ? ["/d", "/s", "/c", "code --version"]
        : ["--version"],
    ],
    [
      "Python 3.12 x64",
      process.platform === "win32" ? "py" : "python3.12",
      process.platform === "win32"
        ? [
            "-3.12",
            "-c",
            'import sys,struct; print(sys.version.split()[0], struct.calcsize("P")*8)',
          ]
        : [
            "-c",
            'import sys,struct; print(sys.version.split()[0], struct.calcsize("P")*8)',
          ],
    ],
    [
      "NVIDIA driver",
      "nvidia-smi",
      ["--query-gpu=name,memory.total", "--format=csv,noheader"],
    ],
  ]) {
    try {
      record(name, "ok", await run(executable, args));
    } catch {
      record(
        name,
        "missing",
        `Install ${name} and restart the terminal; see docs/windows-setup.md.`,
      );
    }
  }
  for (const [name, expected] of [
    ["trueforge", "0.184.2"],
    ["trueforge-sdk", "0.184.1"],
  ]) {
    try {
      const installed = JSON.parse(
        await readFile(
          path.join(
            projectRoot,
            "node_modules",
            "@truefoundry",
            name,
            "package.json",
          ),
          "utf8",
        ),
      );
      record(
        name,
        installed.version === expected ? "ok" : "missing",
        `Installed ${installed.version}; requires ${expected}. Run npm ci to repair.`,
      );
    } catch {
      record(name, "missing", "Run npm ci in this checkout.");
    }
  }
  try {
    const installed = await run(uvBinaryPath(dir), ["--version"]);
    record(
      `uv ${UV_VERSION}`,
      installed.startsWith(`uv ${UV_VERSION} `) ||
        installed === `uv ${UV_VERSION}`
        ? "ok"
        : "missing",
      installed.startsWith(`uv ${UV_VERSION}`)
        ? "Pinned private binary is ready."
        : "Run npm run setup:local to install the pinned private binary.",
    );
  } catch {
    record(
      `uv ${UV_VERSION}`,
      "missing",
      "Run npm run setup:local with Python 3.12 x64 installed.",
    );
  }
  let config;
  try {
    config = await loadConfig({ dir });
    record("private configuration", "ok", configPath({ dir }));
  } catch {
    record(
      "private configuration",
      "missing",
      "Run npm run setup:local; existing invalid configuration must be repaired manually.",
    );
  }
  if (config)
    record(
      "registered agent",
      config.harness.agentId ? "ok" : "missing",
      config.harness.agentId
        ? "Primary registry name is configured; a real tool call still needs verification."
        : "Start TrueForge, then run npm run harness:configure.",
    );
  for (const slot of ["primary", "fallback"]) {
    const model = config?.[slot];
    if (!model) {
      record(
        `${slot} model`,
        slot === "primary" ? "missing" : "optional",
        slot === "primary"
          ? "Configure verified local model/binary paths and SHA-256 hashes in runtime.json."
          : "Add an independent fallback on port 8081 to test automatic recovery.",
      );
      continue;
    }
    try {
      if (
        !model.modelPath ||
        !model.llamaServerPath ||
        !/^[a-fA-F0-9]{64}$/.test(model.modelSha256) ||
        !/^[a-fA-F0-9]{64}$/.test(model.llamaServerSha256 || "")
      )
        throw new Error("Unconfigured");
      await access(model.modelPath);
      await access(model.llamaServerPath);
      record(
        `${slot} model`,
        "ok",
        `Assets found for ${model.modelId}; model:start verifies hashes before launch.`,
      );
    } catch {
      record(
        `${slot} model`,
        "missing",
        "Select existing trusted llama-server and GGUF files, and set both expected SHA-256 hashes in runtime.json.",
      );
    }
  }
  if (probeServices && config) {
    const endpoints = [
      ["TrueForge", `${config.harness.url}/healthz`],
      ["primary endpoint", `http://127.0.0.1:${config.primary.port}/health`],
      ...(config.fallback
        ? [
            [
              "fallback endpoint",
              `http://127.0.0.1:${config.fallback.port}/health`,
            ],
          ]
        : []),
    ];
    await Promise.all(
      endpoints.map(async ([name, url]) => {
        try {
          const response = await fetch(url, {
            signal: AbortSignal.timeout(1500),
          });
          record(
            name,
            response.ok ? "ok" : "missing",
            response.ok
              ? "Health endpoint ready; a real tool call still needs verification."
              : `Health endpoint returned ${response.status}.`,
          );
        } catch {
          record(
            name,
            "missing",
            `Start ${name === "TrueForge" ? "npm run harness:start" : name.startsWith("fallback") ? "npm run model:fallback" : "npm run model:start"}.`,
          );
        }
      }),
    );
    record(
      "workspace MCP",
      "manual",
      `Open a trusted workspace in the extension host; MCP binds 127.0.0.1:${config.mcp.port}. Verify read_file in a TrueForge turn.`,
    );
  }
  return {
    ready: checks.every((check) => !["missing"].includes(check.status)),
    platform: process.platform,
    checks,
  };
}
if (isMain(import.meta.url))
  doctor()
    .then((report) => {
      for (const check of report.checks)
        console.log(
          `${check.status.toUpperCase().padEnd(8)} ${check.name}: ${check.detail}`,
        );
      console.log(
        "Windows CUDA fit, F5, packaged VSIX and genuine tool use require separate live checks.",
      );
      if (!report.ready) process.exitCode = 1;
    })
    .catch(reportFailure);
