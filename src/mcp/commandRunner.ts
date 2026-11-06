import type { WorkspaceAdapter } from "../contracts";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import {
  commandRelativePath,
  createCommandCopy,
} from "../workspace/commandCopy";

export interface CommandRequest {
  executable: string;
  args: string[];
  runId: string;
}
export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  cancelled: boolean;
  changes: Array<{ path: string; oldText: string; newText: string }>;
}
export interface CommandRunnerOptions {
  pythonPath?: string;
  timeoutMs?: number;
  overlay?: (
    path: string,
  ) => Promise<{ path: string; text: string; version: string }>;
}

const supported =
  "Supported checks: python -m pytest [relative tests] [-q], python -m py_compile <relative .py files>, python -m compileall [-q] <relative paths>, and flask [--app module] --help|--version|routes|config. Shell commands and arbitrary Python scripts/-c are unsupported.";
function deny(): never {
  throw new Error(supported);
}

/** Argument policy is intentionally small; adding a new command requires design and tests. */
export function validateCommand(request: CommandRequest): {
  module: string;
  args: string[];
} {
  if (
    !request ||
    typeof request.executable !== "string" ||
    !Array.isArray(request.args) ||
    request.args.length > 100 ||
    typeof request.runId !== "string" ||
    !request.runId ||
    request.runId.length > 200 ||
    request.args.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length > 4096 ||
        /[\0\r\n;|&`$<>]/.test(argument),
    )
  )
    deny();
  let module: string;
  let args: string[];
  if (/^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i.test(request.executable)) {
    if (request.args[0] !== "-m") deny();
    module = request.args[1];
    args = request.args.slice(2);
  } else if (
    request.executable === "pytest" ||
    request.executable === "flask"
  ) {
    module = request.executable;
    args = [...request.args];
  } else deny();

  if (module === "pytest") {
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (
        [
          "-q",
          "-qq",
          "-v",
          "-vv",
          "-s",
          "-x",
          "--disable-warnings",
          "--collect-only",
          "--no-header",
          "--no-summary",
          "--strict-markers",
          "--strict-config",
        ].includes(arg) ||
        /^--(?:maxfail=\d{1,4}|tb=(?:auto|long|short|line|native|no))$/.test(
          arg,
        )
      )
        continue;
      if (arg === "-k" || arg === "-m") {
        if (!args[++index] || !/^[\w .():+-]+$/.test(args[index])) deny();
        continue;
      }
      if (arg.startsWith("-")) deny();
      commandRelativePath(arg.split("::")[0]);
    }
  } else if (module === "py_compile") {
    if (!args.length) deny();
    for (const arg of args) {
      if (arg.startsWith("-") || !arg.endsWith(".py")) deny();
      commandRelativePath(arg);
    }
  } else if (module === "compileall") {
    let paths = 0;
    for (const arg of args) {
      if (["-q", "-qq", "-f"].includes(arg)) continue;
      if (arg.startsWith("-")) deny();
      commandRelativePath(arg);
      paths++;
    }
    if (!paths) deny();
  } else if (module === "flask") {
    let index = 0;
    if (args[index] === "--app" || args[index] === "-A") {
      const app = args[++index];
      if (!app || /^[A-Za-z]:/.test(app) || !/^[\w./\\:-]+(?:\(\))?$/.test(app))
        deny();
      commandRelativePath(app.split(":")[0]);
      index++;
    }
    if (!["--help", "--version", "routes", "config"].includes(args[index]))
      deny();
    if (
      args.length > index + 1 &&
      !(args.length === index + 2 && args[index + 1] === "--help")
    )
      deny();
  } else deny();
  return { module, args };
}

interface ActiveCommand {
  cancelled: boolean;
  timedOut: boolean;
  child?: ChildProcess;
  terminate?: () => void;
}
const OUTPUT_BYTES = 64 * 1024;
const TRUNCATION = "\n[output truncated]\n";

function boundedOutput() {
  const chunks: Buffer[] = [];
  let length = 0;
  let truncated = false;
  return {
    append(chunk: Buffer | string) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = OUTPUT_BYTES - Buffer.byteLength(TRUNCATION) - length;
      if (remaining > 0) {
        chunks.push(buffer.subarray(0, remaining));
        length += Math.min(buffer.length, remaining);
      }
      if (buffer.length > remaining) truncated = true;
    },
    text() {
      const points: string[] = [];
      let bytes = 0;
      const limit = OUTPUT_BYTES - Buffer.byteLength(TRUNCATION);
      for (const point of Buffer.concat(chunks).toString("utf8")) {
        const size = Buffer.byteLength(point);
        if (bytes + size > limit) {
          truncated = true;
          break;
        }
        points.push(point);
        bytes += size;
      }
      return points.join("") + (truncated ? TRUNCATION : "");
    },
  };
}

function safeEnvironment(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "LANG",
    "LC_ALL",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  env.TMPDIR = env.TEMP = env.TMP = root;
  env.HOME = env.USERPROFILE = root;
  env.PYTHONPATH = [path.join(root, "src"), root].join(path.delimiter);
  env.PYTHONDONTWRITEBYTECODE = "1";
  env.PYTHONUNBUFFERED = "1";
  env.PYTHONNOUSERSITE = "1";
  return env;
}

// Fixed bridge code, never user-provided Python. Editable installs can otherwise
// import Flask from the original checkout and falsely validate the proposed copy.
const bootstrap = [
  "import os, sys, runpy",
  "root = os.path.realpath(os.getcwd())",
  'source = os.path.join(root, "src")',
  "sys.path[:0] = [source, root]",
  'if sys.argv[1] in ("pytest", "flask") and os.path.isfile(os.path.join(source, "flask", "__init__.py")):',
  "    import flask",
  "    imported = os.path.realpath(flask.__file__)",
  "    if os.path.commonpath([source, imported]) != source:",
  '        raise RuntimeError("Flask imported outside the proposed copy; check the selected Python environment")',
  "module = sys.argv[1]",
  "sys.argv = [module] + sys.argv[2:]",
  'runpy.run_module(module, run_name="__main__", alter_sys=True)',
].join("\n");

/** The caller must enforce workspace trust and explicit command approval. */
export class CommandRunner {
  private readonly active = new Map<string, ActiveCommand>();
  constructor(
    private readonly adapter: WorkspaceAdapter,
    private readonly options: CommandRunnerOptions = {},
  ) {}

  async run(
    request: CommandRequest,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    const command = validateCommand(request);
    const runId = request.runId;
    if (this.active.has(runId))
      throw new Error("A command is already running for this run ID.");
    const state: ActiveCommand = {
      cancelled: signal?.aborted ?? false,
      timedOut: false,
    };
    this.active.set(runId, state);
    const onAbort = () => this.cancel(runId);
    signal?.addEventListener("abort", onAbort, { once: true });
    let copy: Awaited<ReturnType<typeof createCommandCopy>> | undefined;
    try {
      if (state.cancelled)
        return {
          exitCode: null,
          stdout: "",
          stderr: "",
          cancelled: true,
          changes: [],
        };
      copy = await createCommandCopy(this.adapter, this.options.overlay);
      if (state.cancelled)
        return {
          exitCode: null,
          stdout: "",
          stderr: "",
          cancelled: true,
          changes: [],
        };
      const result = await this.execute(command, copy.root, state);
      const changes = state.cancelled ? [] : await copy.collectChanges();
      return {
        ...result,
        cancelled: state.cancelled,
        changes: state.cancelled ? [] : changes,
      };
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.active.delete(runId);
      if (copy) await copy.cleanup();
    }
  }

  cancel(runId: string): void {
    const state = this.active.get(runId);
    if (!state || state.cancelled) return;
    state.cancelled = true; // Invalidate before waiting for any child process.
    state.terminate?.();
  }

  private execute(
    command: { module: string; args: string[] },
    root: string,
    state: ActiveCommand,
  ): Promise<Omit<CommandResult, "changes">> {
    return new Promise((resolve, reject) => {
      const stdout = boundedOutput();
      const stderr = boundedOutput();
      const python =
        this.options.pythonPath ??
        (process.platform === "win32" ? "python" : "python3");
      const child = spawn(
        python,
        ["-c", bootstrap, command.module, ...command.args],
        {
          cwd: root,
          env: safeEnvironment(root),
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      state.child = child;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const killTree = (force: boolean) => {
        if (!child.pid) return;
        if (process.platform === "win32") {
          // /T is scoped to the PID created by this runner, never image-name kills.
          const systemRoot =
            process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
          const killer = spawn(
            path.join(systemRoot, "System32", "taskkill.exe"),
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore", shell: false },
          );
          killer.on("error", () => {
            try {
              child.kill();
            } catch {
              /* child already ended */
            }
          });
          killer.unref();
        } else {
          try {
            process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
              try {
                child.kill(force ? "SIGKILL" : "SIGTERM");
              } catch {
                /* already ended */
              }
            }
          }
        }
      };
      state.terminate = () => {
        killTree(false);
        if (process.platform !== "win32") {
          killTimer = setTimeout(() => killTree(true), 250);
          killTimer.unref();
        }
      };
      const timeoutMs = Math.min(
        Math.max(this.options.timeoutMs ?? 120000, 10),
        300000,
      );
      const timeout = setTimeout(() => {
        state.timedOut = state.cancelled = true;
        state.terminate?.();
      }, timeoutMs);
      timeout.unref();
      child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
      child.on("error", (error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        reject(
          new Error(
            `Could not start configured Python (${python}). Select an installed interpreter with project test dependencies: ${error.message}`,
          ),
        );
      });
      child.on("close", (exitCode) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        // Escalate before clearing the timer: surviving descendants may have
        // closed their inherited pipes while ignoring the initial SIGTERM.
        if (state.cancelled) killTree(true);
        if (killTimer) clearTimeout(killTimer);
        if (state.timedOut)
          stderr.append(
            "\nProject check timed out and its process tree was terminated.\n",
          );
        resolve({
          exitCode,
          stdout: stdout.text(),
          stderr: stderr.text(),
          cancelled: state.cancelled,
        });
      });
      if (state.cancelled) state.terminate();
    });
  }
}
