import { afterEach, describe, expect, test } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const script = (name: string) =>
  import(
    pathToFileURL(path.join(process.cwd(), "scripts", `${name}.mjs`)).href
  );
const dirs: string[] = [];
async function temporary() {
  const dir = await mkdtemp(path.join(tmpdir(), "codeauditor-setup-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

describe("local runtime setup", () => {
  test("resolves the private Windows and XDG data directories", async () => {
    const { runtimeDir } = await script("runtime");
    expect(
      runtimeDir({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\A User\\AppData\\Local" },
        home: "C:\\Users\\A User",
      }),
    ).toBe("C:\\Users\\A User\\AppData\\Local\\CodeAuditor");
    expect(
      runtimeDir({
        platform: "linux",
        env: { XDG_DATA_HOME: "/data" },
        home: "/home/a",
      }),
    ).toBe("/data/codeauditor");
    expect(runtimeDir({ platform: "linux", env: {}, home: "/home/a" })).toBe(
      "/home/a/.local/share/codeauditor",
    );
  });
  test("allows an explicit absolute runtime directory without changing HOME", async () => {
    const { runtimeDir } = await script("runtime");
    expect(
      runtimeDir({
        platform: "linux",
        env: { CODEAUDITOR_DATA_DIR: "/tmp/custom" },
        home: "/home/a",
      }),
    ).toBe("/tmp/custom");
    expect(() =>
      runtimeDir({
        platform: "linux",
        env: { CODEAUDITOR_DATA_DIR: "./relative" },
        home: "/home/a",
      }),
    ).toThrow(/absolute/);
  });
  test("creates a stable random token and preserves user model configuration on repeat setup", async () => {
    const { ensureRuntime, loadConfig, saveConfig } = await script("runtime");
    const dir = await temporary();
    const original = await ensureRuntime({ dir });
    expect(original.mcp.token).toMatch(/^[a-f0-9]{64}$/);
    original.primary.modelPath = "/user/selected/model.gguf";
    await saveConfig(original, { dir });
    await ensureRuntime({ dir });
    expect(await loadConfig({ dir })).toEqual(original);
    expect(
      await readFile(path.join(dir, "runtime.json"), "utf8"),
    ).not.toContain("api_key");
  });
  test("refuses malformed or unsafe configuration without overwriting it", async () => {
    const { ensureRuntime } = await script("runtime");
    const dir = await temporary();
    await writeFile(path.join(dir, "runtime.json"), "{broken");
    await expect(ensureRuntime({ dir })).rejects.toThrow(/runtime.json/);
    expect(await readFile(path.join(dir, "runtime.json"), "utf8")).toBe(
      "{broken",
    );
  });
  test("detects a reserved port collision and frees its probe socket", async () => {
    const { assertPortAvailable } = await script("runtime");
    const server = net.createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test listener");
    try {
      await expect(assertPortAvailable(address.port)).rejects.toThrow(
        /occupied|in use/,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await expect(assertPortAvailable(address.port)).resolves.toBeUndefined();
  });
  test("checks supplied model hashes before launching a process", async () => {
    const { verifyFile } = await script("runtime");
    const dir = await temporary();
    const file = path.join(dir, "model.gguf");
    await writeFile(file, "abc");
    await expect(
      verifyFile(
        file,
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      ),
    ).resolves.toBeUndefined();
    await expect(verifyFile(file, "0".repeat(64))).rejects.toThrow(/SHA-256/);
    await expect(verifyFile(file, "")).rejects.toThrow(/SHA-256/);
  });
});

describe("model and TrueForge configuration", () => {
  test("configuration helper imports under native Node with the installed SDK exports", async () => {
    const result = await promisify(execFile)(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'import("./scripts/configureHarness.mjs").then(m => console.log(typeof m.configureHarness))',
      ],
      { cwd: process.cwd() },
    );
    expect(result.stdout.trim()).toBe("function");
  });
  test("uses one Qwen tool-capable nonthinking slot with loopback context limits", async () => {
    const { modelArgs } = await script("startModel");
    const args = modelArgs({
      modelPath: "C:\\Models\\Qwen.gguf",
      modelId: "qwen3-1.7b",
      port: 8080,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--host",
        "127.0.0.1",
        "--port",
        "8080",
        "--ctx-size",
        "4096",
        "--parallel",
        "1",
        "--jinja",
        "--reasoning-budget",
        "0",
        "--chat-template-kwargs",
        '{"enable_thinking":false}',
      ]),
    );
    expect(args).not.toContain("--no-mmap");
    expect(
      modelArgs(
        { modelPath: "/m.gguf", modelId: "qwen3-1.7b", port: 8081 },
        { fallback: true },
      ),
    ).toEqual(expect.arrayContaining(["--n-gpu-layers", "0"]));
  });
  test("agent config requires approval by literal mutation tool name and preloads selected schemas", async () => {
    const { agentManifest, providerManifest, mcpManifest } =
      await script("configureHarness");
    const manifest = await agentManifest(
      "codeauditor-local-primary/qwen3-1.7b",
    );
    expect(manifest.model.name).toBe("codeauditor-local-primary/qwen3-1.7b");
    expect(manifest.mcpServers[0].requireApprovalForTools).toEqual([
      "request_apply",
      "run_command",
    ]);
    expect(manifest.mcpServers[0].preloadTools).toEqual([
      "read_file",
      "search_workspace",
      "retrieve_context",
      "stage_patch",
    ]);
    expect(manifest.mcpServers[0].enableTools).toContain("request_apply");
    expect(manifest.config.contextManagement.compaction).toEqual({
      enabled: true,
      trigger: { type: "input_tokens", value: 2048 },
    });
    expect(manifest.config.contextManagement.largeToolResponse.enabled).toBe(
      false,
    );
    expect(manifest.config.dynamicSubAgents.enabled).toBe(false);
    expect(manifest.config.askUserQuestions.enabled).toBe(false);
    expect(manifest.config.generativeUi.enabled).toBe(false);
    expect(
      providerManifest({ modelId: "qwen3-1.7b", port: 8080 }, "primary")
        .baseUrl,
    ).toBe("http://127.0.0.1:8080/v1");
    expect(
      providerManifest({ modelId: "qwen3-1.7b", port: 8080 }, "primary")
        .models[0],
    ).toMatchObject({ name: "local-model", modelId: "qwen3-1.7b" });
    expect(
      mcpManifest({ port: 8792, token: "abc" }).auth.headers.Authorization,
    ).toBe("Bearer abc");
  });
  test("harness stays loopback and allows only named local outbound hosts", async () => {
    const { harnessEnvironment } = await script("startHarness");
    const env = harnessEnvironment("/runtime");
    expect(env.HOST).toBe("127.0.0.1");
    expect(env.STANDALONE).toBe("true");
    expect(env.SQLITE_PATH).toBe(
      path.join("/runtime", "trueforge", "db.sqlite"),
    );
    expect(JSON.parse(env.OUTBOUND_URL_ALLOWED_HOSTS)).toEqual([
      "127.0.0.1",
      "localhost",
    ]);
    expect(env.NETWORK_POLICY_ENABLED).toBe("true");
    expect(env.XDG_DATA_HOME).toBe("/runtime");
    expect(env.XDG_STATE_HOME).toBe(path.join("/runtime", "logs"));
  });
  test("doctor reports missing executables without echoing private token values", async () => {
    const { doctor } = await script("doctor");
    const dir = await temporary();
    const report = await doctor({ dir, probeServices: false });
    expect(
      report.checks.some(
        (check: { name: string; status: string }) =>
          check.name === "primary model" && check.status === "missing",
      ),
    ).toBe(true);
    expect(
      report.checks.some((check: { name: string }) => check.name === "Node.js"),
    ).toBe(true);
    expect(
      report.checks.some(
        (check: { name: string; status: string }) =>
          check.name === "uv 0.9.28" && check.status === "missing",
      ),
    ).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(/[a-f0-9]{64}/);
  });
});

describe("managed fixture setup", () => {
  test("pins the exact fixture commit and keeps Python and demos outside source", async () => {
    const { FLASK_COMMIT, fixturePaths, uvBinaryPath } =
      await script("prepareFixture");
    expect(FLASK_COMMIT).toBe("22d924701a6ae2e4cd01e9a15bbaf3946094af65");
    const paths = fixturePaths("/runtime", "c");
    expect(paths.fixture).toBe(path.join("/runtime", "fixtures", "flask-c"));
    expect(paths.venv.startsWith(paths.fixture + path.sep)).toBe(false);
    expect(paths.demo.startsWith(paths.fixture + path.sep)).toBe(false);
    expect(() => fixturePaths("/runtime", "../user")).toThrow(/name/);
    expect(uvBinaryPath("/runtime", "linux")).toBe(
      "/runtime/tools/uv-0.9.28/bin/uv",
    );
    expect(uvBinaryPath("C:\\runtime", "win32")).toBe(
      "C:\\runtime\\tools\\uv-0.9.28\\bin\\uv.exe",
    );
  });
  test("refuses to overwrite any nonmanaged existing fixture", async () => {
    const { assertReusableFixture } = await script("prepareFixture");
    const dir = await temporary();
    await writeFile(path.join(dir, "user.txt"), "preserve");
    await expect(assertReusableFixture(dir)).rejects.toThrow(
      /managed|existing/,
    );
    expect(await readFile(path.join(dir, "user.txt"), "utf8")).toBe("preserve");
  });
});
