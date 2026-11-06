import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkspaceAdapter } from "../../src/contracts";
import {
  commandRelativePath,
  createCommandCopy,
} from "../../src/workspace/commandCopy";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function adapter(files: Record<string, string>): WorkspaceAdapter {
  return {
    root: "/unused-original",
    listFiles: async () => Object.keys(files),
    read: async (name) => ({ path: name, text: files[name], version: "1" }),
    apply: async () => {
      throw new Error("No changes may be applied during a check");
    },
  };
}

describe("temporary command copy", () => {
  it.each([
    "../outside.py",
    "/absolute.py",
    "C:\\absolute.py",
    "C:relative.py",
    "\\\\server\\file.py",
    "src/../../outside.py",
  ])("rejects cross-platform escaping paths: %s", (name) => {
    expect(() => commandRelativePath(name)).toThrow(/relative/i);
  });

  it("filters secrets, binary files and dependency/cache trees before reading them", async () => {
    const files = {
      "app.py": "value = 1\n",
      ".env": "TOKEN=value",
      "node_modules/dependency/index.js": "dependency",
      ".git/config": "git",
      "image.png": "\u0000data",
    };
    const workspace = adapter(files);
    const read = workspace.read;
    workspace.read = async (name) => {
      expect(name).not.toMatch(/^\.env$|^node_modules\/|^\.git\//);
      return read(name);
    };
    const copy = await createCommandCopy(workspace);
    roots.push(copy.root);
    expect(await readFile(path.join(copy.root, "app.py"), "utf8")).toBe(
      "value = 1\n",
    );
    await expect(readFile(path.join(copy.root, "image.png"))).rejects.toThrow();
    await copy.cleanup();
    await expect(readFile(path.join(copy.root, "app.py"))).rejects.toThrow();
  });

  it("captures existing project configuration changes", async () => {
    const copy = await createCommandCopy(adapter({ ".gitignore": "cache/\n" }));
    roots.push(copy.root);
    await writeFile(path.join(copy.root, ".gitignore"), "cache/\nbuild/\n");
    expect(await copy.collectChanges()).toEqual([
      { path: ".gitignore", oldText: "cache/\n", newText: "cache/\nbuild/\n" },
    ]);
  });

  it("keeps staged deletions absent from the proposed check copy", async () => {
    const copy = await createCommandCopy(
      adapter({ "deleted.py": "old\n" }),
      async (name) => ({ path: name, text: "", version: "missing" }),
    );
    roots.push(copy.root);
    await expect(
      readFile(path.join(copy.root, "deleted.py")),
    ).rejects.toThrow();
    expect(await copy.collectChanges()).toEqual([]);
  });

  it("does not follow command-created symlinks when collecting source changes", async () => {
    const copy = await createCommandCopy(adapter({ "app.py": "value = 1\n" }));
    roots.push(copy.root);
    const external = await mkdtemp(path.join(tmpdir(), "command-external-"));
    roots.push(external);
    await writeFile(path.join(external, "outside.py"), "external\n");
    await symlink(
      external,
      path.join(copy.root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(await copy.collectChanges()).toEqual([]);
  });
});
