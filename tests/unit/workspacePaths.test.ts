import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isExcluded, resolveWorkspacePath } from "../../src/workspace/paths";

const temporary: string[] = [];
async function workspace() {
  const root = await mkdtemp(path.join(tmpdir(), "codeauditor workspace ü "));
  temporary.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("workspace path boundary", () => {
  it("resolves Unicode, spaces and Windows separators within the workspace", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "source dir"));
    await writeFile(
      path.join(root, "source dir", "café.ts"),
      "export const value = 1;\r\n",
    );
    expect(await resolveWorkspacePath(root, "source dir\\café.ts")).toBe(
      path.join(root, "source dir", "café.ts"),
    );
  });

  it.each([
    "/etc/passwd",
    "../outside",
    "src/../file.ts",
    "..\\outside",
    "C:\\Windows\\system.ini",
    "C:relative.txt",
    "\\\\server\\share\\file",
    "\\rooted",
    "bad\0path",
    "",
    "src/file.ts:secret",
    "src/file.ts.",
    "src/NUL.ts",
  ])("rejects unsafe path %j", async (candidate) => {
    await expect(
      resolveWorkspacePath(await workspace(), candidate, true),
    ).rejects.toThrow(/path|relative|workspace/i);
  });

  it.each([
    ".git/config",
    "NODE_MODULES/pkg/index.js",
    "src/.env.production",
    ".aws/credentials",
    "secrets.json",
    "secrets/access.txt",
    ".envrc",
    ".kube/config",
    "keys/server.pem",
    "dist/bundle.js",
    "src/file.min.js",
    "image.png",
    "poetry.lock",
  ])("excludes private, generated or binary path %s", async (candidate) => {
    expect(isExcluded(candidate)).toBe(true);
    await expect(
      resolveWorkspacePath(await workspace(), candidate, true),
    ).rejects.toThrow(/excluded/i);
  });

  it("rejects symlink escapes for existing and missing descendants", async () => {
    const root = await workspace();
    const outside = await workspace();
    await writeFile(path.join(outside, "private.txt"), "private");
    await symlink(outside, path.join(root, "linked"), "dir");
    await expect(
      resolveWorkspacePath(root, "linked/private.txt"),
    ).rejects.toThrow(/outside|escape|workspace/i);
    await expect(
      resolveWorkspacePath(root, "linked/new/nested.ts", true),
    ).rejects.toThrow(/outside|escape|workspace/i);
  });

  it("checks canonical symlink targets against exclusions", async () => {
    const root = await workspace();
    await writeFile(path.join(root, ".env"), "PASSWORD=value");
    await symlink(path.join(root, ".env"), path.join(root, "innocent.txt"));
    await expect(resolveWorkspacePath(root, "innocent.txt")).rejects.toThrow(
      /excluded/i,
    );
  });

  it("resolves a missing target through its nearest existing ancestor", async () => {
    const root = await workspace();
    await mkdir(path.join(root, "src"));
    await expect(
      resolveWorkspacePath(root, "src/new/deep/file.ts"),
    ).rejects.toThrow(/exist|found/i);
    expect(await resolveWorkspacePath(root, "src/new/deep/file.ts", true)).toBe(
      path.join(root, "src/new/deep/file.ts"),
    );
  });

  it("rejects dangling symlinks when creating files", async () => {
    const root = await workspace();
    await symlink(
      path.join(root, "missing"),
      path.join(root, "dangling"),
      "dir",
    );
    await expect(
      resolveWorkspacePath(root, "dangling/file.ts", true),
    ).rejects.toThrow(/symlink/i);
  });

  it("allows safe source names that contain dots or the word secret", () => {
    expect(isExcluded("src/secretMask.ts")).toBe(false);
    expect(isExcluded("src/foo..bar.ts")).toBe(false);
    expect(isExcluded("docs/configuration.md")).toBe(false);
  });
});
