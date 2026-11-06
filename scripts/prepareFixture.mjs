import path from "node:path";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import {
  ensureRuntime,
  isMain,
  reportFailure,
  run,
  runtimeDir,
} from "./runtime.mjs";

export const FLASK_COMMIT = "22d924701a6ae2e4cd01e9a15bbaf3946094af65";
export const UV_VERSION = "0.9.28";
export function fixturePaths(dir, name) {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name))
    throw new Error(
      "Fixture name must be 1–41 lowercase letters, numbers or hyphens.",
    );
  return {
    fixture: path.join(dir, "fixtures", `flask-${name}`),
    venv: path.join(dir, "venvs", `flask-${name}`),
    demo: path.join(dir, "demos", `flask-${name}`),
    evidence: path.join(dir, "logs", `fixture-${name}.json`),
  };
}
function pythonInvocation() {
  return process.platform === "win32"
    ? { executable: "py", prefix: ["-3.12"] }
    : { executable: "python3.12", prefix: [] };
}
export function uvBinaryPath(dir, platform = process.platform) {
  return (platform === "win32" ? path.win32 : path.posix).join(
    dir,
    "tools",
    `uv-${UV_VERSION}`,
    "bin",
    platform === "win32" ? "uv.exe" : "uv",
  );
}
export async function ensureUv({ dir = runtimeDir(), install = true } = {}) {
  const python = pythonInvocation();
  const version = await run(python.executable, [
    ...python.prefix,
    "-c",
    'import sys,struct; assert sys.version_info[:2] == (3,12), "Python 3.12 required"; assert struct.calcsize("P")==8, "64-bit Python required"; print(sys.version.split()[0])',
  ]);
  const toolDir = path.join(dir, "tools", `uv-${UV_VERSION}`);
  const executable = uvBinaryPath(dir);
  const env = { ...process.env, PYTHONPATH: toolDir };
  try {
    const installed = await run(executable, ["--version"], { env });
    if (
      !installed.startsWith(`uv ${UV_VERSION} `) &&
      installed !== `uv ${UV_VERSION}`
    )
      throw new Error("Unexpected uv version");
  } catch (error) {
    if (!install)
      throw new Error(
        `Pinned uv ${UV_VERSION} is missing. Run npm run setup:local with Python 3.12 x64 installed.`,
        { cause: error },
      );
    await mkdir(toolDir, { recursive: true, mode: 0o700 });
    console.log(
      `Installing uv ${UV_VERSION} into the private runtime (TLS verification remains enabled).`,
    );
    await run(
      python.executable,
      [
        ...python.prefix,
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-deps",
        "--target",
        toolDir,
        `uv==${UV_VERSION}`,
      ],
      {
        env: { ...process.env, PIP_CACHE_DIR: path.join(dir, "cache", "pip") },
        inherit: true,
      },
    );
    const installed = await run(executable, ["--version"], { env });
    if (!installed.startsWith(`uv ${UV_VERSION}`))
      throw new Error("Pinned uv verification failed.");
  }
  return { executable, prefix: [], env, pythonVersion: version };
}
export async function assertReusableFixture(fixture) {
  const marker = path.join(fixture, ".git", "codeauditor-managed.json");
  let record;
  try {
    record = JSON.parse(await readFile(marker, "utf8"));
  } catch (error) {
    throw new Error(
      `Refusing existing nonmanaged directory ${fixture}. Choose a new --name; no files were reset or deleted.`,
      { cause: error },
    );
  }
  if (record.commit !== FLASK_COMMIT)
    throw new Error(
      "Managed fixture marker has an unexpected commit; choose a new --name.",
    );
  const head = await run("git", ["rev-parse", "HEAD"], { cwd: fixture });
  if (head !== FLASK_COMMIT)
    throw new Error(
      `Fixture HEAD differs from pinned Flask commit. Choose a new --name; preserving ${fixture}.`,
    );
  const status = await run(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all"],
    { cwd: fixture },
  );
  if (status)
    throw new Error(
      `Fixture contains changes, including untracked files. Preserving ${fixture}; create a new clean run with --name a-2 (or b-2/c-2).`,
    );
}
export async function prepareFixture({
  dir = runtimeDir(),
  name = "a",
  uv,
} = {}) {
  await ensureRuntime({ dir });
  const paths = fixturePaths(dir, name);
  let exists = true;
  try {
    await access(paths.fixture);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    exists = false;
  }
  if (exists) await assertReusableFixture(paths.fixture);
  else {
    const staging = `${paths.fixture}.clone-${Date.now()}`;
    console.log(`Cloning Flask 3.1.3 into a new managed ${name} fixture.`);
    await run(
      "git",
      [
        "clone",
        "--branch",
        "3.1.3",
        "--single-branch",
        "https://github.com/pallets/flask.git",
        staging,
      ],
      { inherit: true },
    );
    const head = await run("git", ["rev-parse", "HEAD"], { cwd: staging });
    if (head !== FLASK_COMMIT)
      throw new Error(
        `Flask tag did not resolve to the required commit. Staging clone preserved at ${staging}; no fixture overwritten.`,
      );
    await writeFile(
      path.join(staging, ".git", "codeauditor-managed.json"),
      JSON.stringify({ commit: FLASK_COMMIT, name }),
      { mode: 0o600, flag: "wx" },
    );
    await rename(staging, paths.fixture);
  }
  const tool = uv || (await ensureUv({ dir }));
  const env = {
    ...tool.env,
    UV_PROJECT_ENVIRONMENT: paths.venv,
    UV_CACHE_DIR: path.join(dir, "cache", "uv"),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTEST_ADDOPTS: "-p no:cacheprovider",
  };
  await run(
    tool.executable,
    [
      "sync",
      "--locked",
      "--no-default-groups",
      "--group",
      "tests",
      "--python",
      "3.12",
    ],
    { cwd: paths.fixture, env, inherit: true },
  );
  const python = path.join(
    paths.venv,
    process.platform === "win32" ? "Scripts" : "bin",
    process.platform === "win32" ? "python.exe" : "python",
  );
  const imported = await run(
    python,
    [
      "-c",
      "import flask,pathlib; print(pathlib.Path(flask.__file__).resolve())",
    ],
    { cwd: paths.fixture, env },
  );
  if (
    path.resolve(imported) !==
    path.join(paths.fixture, "src", "flask", "__init__.py")
  )
    throw new Error(
      "Flask import does not resolve to the chosen fixture. Refusing misleading baseline evidence.",
    );
  await run(python, ["-m", "pytest", "tests/test_cli.py", "-q"], {
    cwd: paths.fixture,
    env,
    inherit: true,
  });
  await assertReusableFixture(paths.fixture);
  await mkdir(paths.demo, { recursive: true, mode: 0o700 });
  const demoFile = path.join(paths.demo, "app.py");
  try {
    await writeFile(
      demoFile,
      'from datetime import timedelta\nfrom flask import Flask\n\napp = Flask(__name__)\napp.config.update(DEMO_TIMEOUT=timedelta(seconds=30), DEMO_SECRET="never-display-me")\n',
      { flag: "wx" },
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await writeFile(
    paths.evidence,
    `${JSON.stringify({ commit: FLASK_COMMIT, uv: UV_VERSION, python: tool.pythonVersion, fixture: paths.fixture, venv: paths.venv, demo: paths.demo, baseline: "tests/test_cli.py passed; git status including untracked files clean", preparedAt: new Date().toISOString() }, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(
    `Fixture ready: ${paths.fixture}\nExternal Python: ${python}\nStandalone demo: ${paths.demo}\nEvidence: ${paths.evidence}`,
  );
  return { ...paths, python };
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args[0] !== "--name" || args.length !== 2))
    throw new Error("Usage: npm run fixtures:prepare -- [--name a-2]");
  const dir = runtimeDir();
  await ensureRuntime({ dir });
  const uv = await ensureUv({ dir });
  for (const name of args.length ? [args[1]] : ["a", "b", "c"])
    await prepareFixture({ dir, name, uv });
}
if (isMain(import.meta.url)) main().catch(reportFailure);
