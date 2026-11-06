import { test, expect } from "vitest";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { CommandRunner } from "../../src/mcp/commandRunner";
import { isExcluded } from "../../src/workspace/paths";
import { loadPublicFixtures } from "../../src/workspace/publicFixtures";
const execute = promisify(execFile);
test.skipIf(process.env.CODEAUDITOR_FLASK_CHECKS !== "1")(
  "runs actual pinned Flask CLI checks against a source copy and preserves original fixture",
  async () => {
    const data = process.env.CODEAUDITOR_DATA_DIR;
    if (!data)
      throw new Error(
        "Set CODEAUDITOR_DATA_DIR to the prepared private runtime.",
      );
    const root = path.join(data, "fixtures", "flask-a"),
      python = path.join(
        data,
        "venvs",
        "flask-a",
        process.platform === "win32" ? "Scripts" : "bin",
        process.platform === "win32" ? "python.exe" : "python",
      );
    const status = () =>
      execute("git", [
        "-C",
        root,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ]).then((r) => r.stdout);
    expect(await status()).toBe("");
    expect(
      (await execute("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim(),
    ).toBe("22d924701a6ae2e4cd01e9a15bbaf3946094af65");
    const adapter = {
      root,
      listFiles: async () =>
        (await execute("git", ["-C", root, "ls-files", "-z"])).stdout
          .split("\0")
          .filter((p) => p && !isExcluded(p)),
      read: async (p: string) => {
        const text = await readFile(path.join(root, p), "utf8");
        return {
          path: p,
          text,
          version: createHash("sha256").update(text).digest("hex"),
        };
      },
      apply: async () => {
        throw new Error("This check must not mutate the fixture.");
      },
    };
    const runner = new CommandRunner(adapter, {
      pythonPath: python,
      timeoutMs: 120000,
      publicFixtures: await loadPublicFixtures(root, data),
    });
    const result = await runner.run({
      runId: "actual-flask-baseline",
      executable: "python",
      args: ["-m", "pytest", "tests/test_cli.py", "-q"],
    });
    expect(result.exitCode, result.stdout + "\n" + result.stderr).toBe(0);
    expect(result.stdout).toMatch(/58 passed/);
    expect(result.changes).toEqual([]);
    expect(await status()).toBe("");
  },
);
