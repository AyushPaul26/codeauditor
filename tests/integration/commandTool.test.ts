import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkspaceAdapter } from "../../src/contracts";
import { CommandRunner } from "../../src/mcp/commandRunner";

const directories: string[] = [];
const pythonPath =
  process.env.CODEAUDITOR_TEST_PYTHON ??
  (process.platform === "win32" ? "python" : "python3");

async function fixture(
  files: Record<string, string>,
): Promise<WorkspaceAdapter> {
  const root = await mkdtemp(
    path.join(tmpdir(), "command original with spaces-"),
  );
  directories.push(root);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  return {
    root,
    listFiles: async () => Object.keys(files),
    read: async (name) => ({
      path: name,
      text: await readFile(path.join(root, name), "utf8"),
      version: "1",
    }),
    apply: async () => {
      throw new Error("Command runner must not apply source changes");
    },
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("real controlled Python subprocesses", () => {
  it("checks syntax without creating caches in the original workspace", async () => {
    const adapter = await fixture({ "src/a file.py": "value = 1\n" });
    const result = await new CommandRunner(adapter, { pythonPath }).run({
      executable: "python",
      args: ["-m", "py_compile", "src/a file.py"],
      runId: "syntax",
    });
    expect(result.exitCode).toBe(0);
    expect(result.cancelled).toBe(false);
    expect(result.changes).toEqual([]);
    expect(await readdir(path.join(adapter.root, "src"))).toEqual([
      "a file.py",
    ]);
  });

  it("reports real syntax failures and preserves the subprocess exit status", async () => {
    const adapter = await fixture({ "bad.py": "def invalid(:\n" });
    const result = await new CommandRunner(adapter, { pythonPath }).run({
      executable: "python",
      args: ["-m", "py_compile", "bad.py"],
      runId: "bad-syntax",
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("SyntaxError");
  });

  it("uses the proposed overlay and collects test edits without modifying originals or copying secrets", async () => {
    const adapter = await fixture({
      "pytest.py": `from pathlib import Path\nimport os\nassert Path('src/app.py').read_text() == 'proposed\\n'\nassert not Path('.env').exists()\nassert 'COMMAND_TEST_SECRET' not in os.environ\nPath('src/app.py').write_text('test edit\\n')\nPath('docs/new.md').write_text('new documentation\\n')\nPath('.pytest_cache').mkdir()\nPath('.pytest_cache/output.json').write_text('{}')\nprint(Path.cwd())\n`,
      "src/app.py": "original\n",
      "docs/start.md": "start\n",
      ".env": "SECRET=should not copy\n",
    });
    process.env.COMMAND_TEST_SECRET = "do not inherit";
    try {
      const runner = new CommandRunner(adapter, {
        pythonPath,
        overlay: async (name) =>
          name === "src/app.py"
            ? { path: name, text: "proposed\n", version: "2" }
            : adapter.read(name),
      });
      const result = await runner.run({
        executable: "pytest",
        args: ["-q"],
        runId: "overlay",
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.changes).toEqual([
        { path: "docs/new.md", oldText: "", newText: "new documentation\n" },
        { path: "src/app.py", oldText: "proposed\n", newText: "test edit\n" },
      ]);
      expect(
        await readFile(path.join(adapter.root, "src/app.py"), "utf8"),
      ).toBe("original\n");
      expect(result.stdout).not.toContain(adapter.root);
      await expect(readdir(result.stdout.trim())).rejects.toThrow();
    } finally {
      delete process.env.COMMAND_TEST_SECRET;
    }
  });

  it("forces Flask imports to resolve from the proposed src tree", async () => {
    const adapter = await fixture({
      "src/flask/__init__.py": 'VALUE = "original"\n',
      "pytest.py":
        'import flask\nassert flask.VALUE == "proposed"\nprint(flask.__file__)\n',
    });
    const result = await new CommandRunner(adapter, {
      pythonPath,
      overlay: async (name) =>
        name === "src/flask/__init__.py"
          ? { path: name, text: 'VALUE = "proposed"\n', version: "2" }
          : adapter.read(name),
    }).run({ executable: "pytest", args: [], runId: "flask-import" });
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "/src/flask/__init__.py".replaceAll("/", path.sep),
    );
    expect(result.stdout).not.toContain(adapter.root);
  });

  it("bounds stdout and stderr independently", async () => {
    const adapter = await fixture({
      "pytest.py":
        'import sys\nprint("a" * 300000)\nprint("b" * 300000, file=sys.stderr)\n',
    });
    const result = await new CommandRunner(adapter, { pythonPath }).run({
      executable: "pytest",
      args: [],
      runId: "output",
    });
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(65536);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(65536);
    expect(result.stdout).toContain("[output truncated]");
  });

  it("bounds decoded output even when a child emits invalid UTF-8 bytes", async () => {
    const adapter = await fixture({
      "pytest.py": 'import os\nos.write(1, b"\\xff" * 100000)\n',
    });
    const result = await new CommandRunner(adapter, { pythonPath }).run({
      executable: "pytest",
      args: [],
      runId: "invalid-output",
    });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(65536);
  });

  it("rejects binary source mutations instead of turning them into deletions", async () => {
    const adapter = await fixture({
      "pytest.py":
        'from pathlib import Path\nPath("app.py").write_bytes(b"\\x00")\n',
      "app.py": "value = 1\n",
    });
    await expect(
      new CommandRunner(adapter, { pythonPath }).run({
        executable: "pytest",
        args: [],
        runId: "binary-source",
      }),
    ).rejects.toThrow(/binary|review/i);
    expect(await readFile(path.join(adapter.root, "app.py"), "utf8")).toBe(
      "value = 1\n",
    );
  });

  it("preserves source deletion and ignores generated files", async () => {
    const adapter = await fixture({
      "pytest.py":
        'from pathlib import Path\nPath("old.py").unlink()\nPath("result.log").write_text("test log")\n',
      "old.py": "value = 1\n",
    });
    const result = await new CommandRunner(adapter, { pythonPath }).run({
      executable: "pytest",
      args: [],
      runId: "deleted-source",
    });
    expect(result.changes).toEqual([
      { path: "old.py", oldText: "value = 1\n", newText: "" },
    ]);
    expect(await readFile(path.join(adapter.root, "old.py"), "utf8")).toBe(
      "value = 1\n",
    );
  });

  it("times out and cancels the process group promptly", async () => {
    const adapter = await fixture({
      "pytest.py":
        'import subprocess,sys,time\nsubprocess.Popen([sys.executable, "-c", "import time; time.sleep(20)"])\ntime.sleep(20)\n',
    });
    const started = Date.now();
    const result = await new CommandRunner(adapter, {
      pythonPath,
      timeoutMs: 150,
    }).run({ executable: "pytest", args: [], runId: "timeout" });
    expect(result.cancelled).toBe(true);
    expect(result.stderr).toMatch(/timed out/i);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it("supports AbortSignal and explicit run cancellation", async () => {
    const adapter = await fixture({
      "pytest.py": "import time\ntime.sleep(20)\n",
    });
    const runner = new CommandRunner(adapter, { pythonPath });
    const abort = new AbortController();
    const running = runner.run(
      { executable: "pytest", args: [], runId: "aborted" },
      abort.signal,
    );
    setTimeout(() => abort.abort(), 100);
    expect((await running).cancelled).toBe(true);
    const second = runner.run({
      executable: "pytest",
      args: [],
      runId: "cancelled",
    });
    setTimeout(() => runner.cancel("cancelled"), 100);
    expect((await second).cancelled).toBe(true);
  });
});
