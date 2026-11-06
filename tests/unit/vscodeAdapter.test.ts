import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const host = vi.hoisted(() => ({
  docs: new Map<string, any>(),
  onOpen: undefined as undefined | ((file: string) => void),
  onText: undefined as undefined | (() => void),
  apply: vi.fn(async () => true),
}));
vi.mock("vscode", () => ({
  Uri: { file: (file: string) => ({ fsPath: file }) },
  Range: class {
    constructor(
      public start: unknown,
      public end: unknown,
    ) {}
  },
  WorkspaceEdit: class {
    deleteFile() {}
    replace() {}
  },
  workspace: {
    openTextDocument: async (uri: { fsPath: string }) => {
      host.onOpen?.(uri.fsPath);
      return host.docs.get(uri.fsPath);
    },
    applyEdit: host.apply,
  },
}));
import { VscodeWorkspace } from "../../src/workspace/vscodeAdapter";
let root: string;
function document(file: string, text: string) {
  const doc = {
    version: 1,
    getText: () => {
      const current = text;
      host.onText?.();
      return current;
    },
    positionAt: (offset: number) => offset,
    setText: (next: string) => {
      text = next;
      doc.version++;
    },
  };
  host.docs.set(path.join(root, file), doc);
  return doc;
}
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "codeauditor-adapter-"));
  host.docs.clear();
  host.onOpen = undefined;
  host.onText = undefined;
  host.apply.mockClear();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
describe("native adapter final commit guards", () => {
  it("does not delete a new file if user work appears after undo preflight", async () => {
    await writeFile(path.join(root, "new.py"), "AGENT = 1\n");
    const doc = document("new.py", "AGENT = 1\n"),
      adapter = new VscodeWorkspace(root),
      base = await adapter.read("new.py");
    host.onText = () => {
      host.onText = undefined;
      queueMicrotask(() => {
        doc.setText("AGENT = 1\nUSER = 2\n");
        writeFileSync(path.join(root, "new.py"), doc.getText());
      });
    };
    await expect(
      adapter.apply([
        {
          path: "new.py",
          text: "",
          expectedVersion: base.version,
          delete: true,
        },
      ]),
    ).rejects.toThrow(/changed|conflict|version/i);
    expect(host.apply).not.toHaveBeenCalled();
    expect(doc.getText()).toContain("USER = 2");
  });
  it("rechecks an earlier file after awaiting a later document", async () => {
    await writeFile(path.join(root, "a.py"), "A = 1");
    await writeFile(path.join(root, "b.py"), "B = 1");
    const a = document("a.py", "A = 1");
    document("b.py", "B = 1");
    const adapter = new VscodeWorkspace(root),
      av = await adapter.read("a.py"),
      bv = await adapter.read("b.py");
    let openedB = 0;
    host.onOpen = (file) => {
      if (file.endsWith("b.py") && ++openedB === 2) a.setText("USER = 3");
    };
    await expect(
      adapter.apply([
        { path: "a.py", text: "A = 2", expectedVersion: av.version },
        { path: "b.py", text: "B = 2", expectedVersion: bv.version },
      ]),
    ).rejects.toThrow(/changed/i);
    expect(host.apply).not.toHaveBeenCalled();
  });
  it("checks cancellation immediately before installing a new file", async () => {
    const adapter = new VscodeWorkspace(root);
    await expect(
      adapter.apply(
        [{ path: "new.py", text: "VALUE = 1", expectedVersion: "missing" }],
        () => {
          throw new Error("Cancelled before commit");
        },
      ),
    ).rejects.toThrow(/cancelled/i);
    await expect(stat(path.join(root, "new.py"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
