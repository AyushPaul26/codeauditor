import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProposalStore } from "../../src/edits/proposalStore";
import type {
  DocumentSnapshot,
  WorkspaceAdapter,
  WorkspaceChange,
} from "../../src/contracts";
import { createCommandCopy } from "../../src/workspace/commandCopy";

class MemoryWorkspace implements WorkspaceAdapter {
  readonly root = "/project";
  readonly documents = new Map<string, DocumentSnapshot>();
  beforeCommit?: () => void;
  constructor(files: Record<string, string>) {
    for (const [path, text] of Object.entries(files))
      this.documents.set(path, { path, text, version: "1" });
  }
  async listFiles() {
    return [...this.documents.keys()];
  }
  async read(path: string) {
    const document = this.documents.get(path);
    if (!document)
      throw Object.assign(new Error("File not found"), { code: "ENOENT" });
    return { ...document };
  }
  async apply(edits: WorkspaceChange[]) {
    this.beforeCommit?.();
    for (const edit of edits) {
      const version = this.documents.get(edit.path)?.version ?? "missing";
      if (version !== edit.expectedVersion)
        throw new Error("Document version conflict");
    }
    for (const edit of edits) {
      if (edit.delete) {
        this.documents.delete(edit.path);
        continue;
      }
      const version = this.documents.get(edit.path)?.version;
      this.documents.set(edit.path, {
        path: edit.path,
        text: edit.text,
        version: String(Number(version ?? 0) + 1),
      });
    }
  }
  userEdit(path: string, text: string) {
    const old = this.documents.get(path)!;
    this.documents.set(path, {
      path,
      text,
      version: String(Number(old.version) + 1),
    });
  }
}

class GatedWorkspace extends MemoryWorkspace {
  private notifyWaiting!: () => void;
  private releaseCommit!: () => void;
  readonly waitingToCommit = new Promise<void>((resolve) => {
    this.notifyWaiting = resolve;
  });

  async apply(edits: WorkspaceChange[], preCommit?: () => void) {
    this.notifyWaiting();
    await new Promise<void>((resolve) => {
      this.releaseCommit = resolve;
    });
    preCommit?.();
    await super.apply(edits);
  }

  continueCommit() {
    this.releaseCommit();
  }
}

describe("reviewed proposal edits", () => {
  it("stages changes in an immutable overlay without changing the workspace", async () => {
    const workspace = new MemoryWorkspace({
      "a.ts": "user work\nconst a = 1;\n",
    });
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      { path: "a.ts", oldText: "const a = 1;", newText: "const a = 2;" },
    ]);
    expect((await workspace.read("a.ts")).text).toBe(
      "user work\nconst a = 1;\n",
    );
    expect((await store.readOverlay("a.ts", "run")).text).toBe(
      "user work\nconst a = 2;\n",
    );
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(proposal.hunks[0])).toBe(true);
    expect(store.list("other")).toEqual([]);
    expect(store.get(proposal.id)?.baseVersions).toEqual({ "a.ts": "1" });
  });

  it("requires a complete host review and applies only the accepted line hunks", async () => {
    const workspace = new MemoryWorkspace({ "a.ts": "alpha\nkeep\nomega\n" });
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      {
        path: "a.ts",
        oldText: "alpha\nkeep\nomega\n",
        newText: "ALPHA\nkeep\nOMEGA\n",
      },
    ]);
    expect(proposal.hunks).toHaveLength(2);
    await expect(store.apply(proposal.id)).rejects.toThrow(/review/i);
    expect(() =>
      store.review(proposal.id, { [proposal.hunks[0]!.id]: "accept" }),
    ).toThrow(/complete|missing/i);
    expect(() => store.review(proposal.id, { fake: "accept" })).toThrow(
      /unknown|hunk/i,
    );
    store.review(proposal.id, {
      [proposal.hunks[0]!.id]: "accept",
      [proposal.hunks[1]!.id]: "reject",
    });
    const result = await store.apply(proposal.id);
    expect((await workspace.read("a.ts")).text).toBe("ALPHA\nkeep\nomega\n");
    expect(result.acceptedIds).toEqual([proposal.hunks[0]!.id]);
    expect(result.rejectedIds).toEqual([proposal.hunks[1]!.id]);
    await expect(store.apply(proposal.id)).rejects.toThrow(/applied|replay/i);
  });

  it("rejects stale multi-file changes as a group", async () => {
    const workspace = new MemoryWorkspace({ "a.ts": "one", "b.ts": "two" });
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "ONE" },
      { path: "b.ts", oldText: "two", newText: "TWO" },
    ]);
    store.review(
      proposal.id,
      Object.fromEntries(proposal.hunks.map((h) => [h.id, "accept"])),
    );
    workspace.userEdit("b.ts", "dirty user buffer");
    await expect(store.apply(proposal.id)).rejects.toThrow(
      /stale|conflict|version/i,
    );
    expect((await workspace.read("a.ts")).text).toBe("one");
    expect((await workspace.read("b.ts")).text).toBe("dirty user buffer");
  });

  it("preserves CRLF and earlier user work through accepted changes and undo", async () => {
    const workspace = new MemoryWorkspace({
      "a.ts": "// earlier user edit\r\nconst a = 1;\r\n",
    });
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      {
        path: "a.ts",
        oldText: "const a = 1;",
        newText: "const a = 2;\nconst b = 3;",
      },
    ]);
    store.review(proposal.id, { [proposal.hunks[0]!.id]: "accept" });
    await store.apply(proposal.id);
    expect((await workspace.read("a.ts")).text).toBe(
      "// earlier user edit\r\nconst a = 2;\r\nconst b = 3;\r\n",
    );
    await store.undoLast();
    expect((await workspace.read("a.ts")).text).toBe(
      "// earlier user edit\r\nconst a = 1;\r\n",
    );
  });

  it("refuses undo after a subsequent user change", async () => {
    const workspace = new MemoryWorkspace({ "a.ts": "one" });
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "two" },
    ]);
    store.review(proposal.id, { [proposal.hunks[0]!.id]: "accept" });
    await store.apply(proposal.id);
    workspace.userEdit("a.ts", "two plus later user work");
    await expect(store.undoLast()).rejects.toThrow(/stale|conflict|version/i);
    expect((await workspace.read("a.ts")).text).toBe(
      "two plus later user work",
    );
  });

  it("cancels pending proposals and rejects late staging and application", async () => {
    const workspace = new MemoryWorkspace({ "a.ts": "one" });
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "two" },
    ]);
    store.review(proposal.id, { [proposal.hunks[0]!.id]: "accept" });
    store.cancelRun("run");
    await expect(store.apply(proposal.id)).rejects.toThrow(/cancel/i);
    await expect(
      store.stage("run", [{ path: "a.ts", oldText: "one", newText: "three" }]),
    ).rejects.toThrow(/cancel/i);
    expect((await workspace.read("a.ts")).text).toBe("one");
    expect((await store.readOverlay("a.ts", "run")).text).toBe("one");
  });

  it("requires unique exact context and never treats empty old text as existing-file replacement", async () => {
    const workspace = new MemoryWorkspace({ "a.ts": "same same" });
    const store = new ProposalStore(workspace);
    await expect(
      store.stage("run", [
        { path: "a.ts", oldText: "same", newText: "changed" },
      ]),
    ).rejects.toThrow(/unique|ambiguous/i);
    await expect(
      store.stage("run", [
        { path: "a.ts", oldText: "missing", newText: "changed" },
      ]),
    ).rejects.toThrow(/context|match/i);
    await expect(
      store.stage("run", [
        { path: "a.ts", oldText: "", newText: "replacement" },
      ]),
    ).rejects.toThrow(/exist|create/i);
    await expect(
      store.stage("run", [
        { path: "../outside", oldText: "", newText: "created" },
      ]),
    ).rejects.toThrow(/path|outside/i);
    expect(store.list()).toEqual([]);
  });

  it("allows reviewed exact-context emptying of a file and restores its content on undo", async () => {
    const workspace = new MemoryWorkspace({
      "a.ts": "delete this reviewed content\n",
    });
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      { path: "a.ts", oldText: "delete this reviewed content\n", newText: "" },
    ]);
    expect((await workspace.read("a.ts")).text).toBe(
      "delete this reviewed content\n",
    );
    store.review(proposal.id, { [proposal.hunks[0]!.id]: "accept" });
    await store.apply(proposal.id);
    expect((await workspace.read("a.ts")).text).toBe("");
    await store.undoLast();
    expect((await workspace.read("a.ts")).text).toBe(
      "delete this reviewed content\n",
    );
  });

  it("creates a missing file only after review and safely removes it on undo", async () => {
    const workspace = new MemoryWorkspace({});
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      {
        path: "new.ts",
        oldText: "",
        newText: "export const created = true;\n",
      },
    ]);
    expect(workspace.documents.has("new.ts")).toBe(false);
    expect((await store.readOverlay("new.ts", "run")).text).toBe(
      "export const created = true;\n",
    );
    store.review(proposal.id, { [proposal.hunks[0]!.id]: "accept" });
    await store.apply(proposal.id);
    expect((await workspace.read("new.ts")).text).toBe(
      "export const created = true;\n",
    );
    await store.undoLast();
    expect(workspace.documents.has("new.ts")).toBe(false);
  });

  it("includes staged new files in command copies without changing their missing apply base", async () => {
    const workspace = new MemoryWorkspace({});
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      {
        path: "tests/new_test.py",
        oldText: "",
        newText: "def test_new():\n    assert True\n",
      },
    ]);
    const stagedWorkspace: WorkspaceAdapter = {
      root: workspace.root,
      listFiles: async () => ["tests/new_test.py"],
      read: workspace.read.bind(workspace),
      apply: workspace.apply.bind(workspace),
    };
    const copy = await createCommandCopy(stagedWorkspace, (path) =>
      store.readOverlay(path, "run"),
    );
    try {
      expect(await readFile(join(copy.root, "tests/new_test.py"), "utf8")).toBe(
        "def test_new():\n    assert True\n",
      );
      expect(proposal.baseVersions["tests/new_test.py"]).toBe("missing");
      expect(workspace.documents.has("tests/new_test.py")).toBe(false);
      const snapshot = await store.readOverlay("tests/new_test.py", "run");
      expect(snapshot.version).not.toBe("missing");
      expect(
        (await store.readOverlay("tests/new_test.py", "run")).version,
      ).toBe(snapshot.version);
      store.review(proposal.id, { [proposal.hunks[0]!.id]: "reject" });
      expect(
        (await store.readOverlay("tests/new_test.py", "run")).version,
      ).toBe("missing");
    } finally {
      await copy.cleanup();
    }
  });

  it("copies host decisions so modifying their input cannot forge acceptance", async () => {
    const workspace = new MemoryWorkspace({ "a.ts": "one" });
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "two" },
    ]);
    const decisions: Record<string, "accept" | "reject"> = {
      [proposal.hunks[0]!.id]: "reject",
    };
    store.review(proposal.id, decisions);
    decisions[proposal.hunks[0]!.id] = "accept";
    const result = await store.apply(proposal.id);
    expect(result.acceptedIds).toEqual([]);
    expect((await workspace.read("a.ts")).text).toBe("one");
  });

  it("does not apply an obsolete review when the host changes decisions during preflight", async () => {
    const workspace = new MemoryWorkspace({ "a.ts": "one" });
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "two" },
    ]);
    store.review(proposal.id, { [proposal.hunks[0]!.id]: "accept" });
    const applying = store.apply(proposal.id);
    queueMicrotask(() =>
      store.review(proposal.id, { [proposal.hunks[0]!.id]: "reject" }),
    );
    await expect(applying).rejects.toThrow(/review.*chang|obsolete/i);
    expect((await workspace.read("a.ts")).text).toBe("one");
  });

  it("treats insertion and deletion hunks independently at original document offsets", async () => {
    const workspace = new MemoryWorkspace({ "a.ts": "alpha\nkeep\nomega\n" });
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      {
        path: "a.ts",
        oldText: "alpha\nkeep\nomega\n",
        newText: "insert\nalpha\nkeep\n",
      },
    ]);
    expect(proposal.hunks).toHaveLength(2);
    const insertion = proposal.hunks.find((hunk) => hunk.before === "")!;
    const deletion = proposal.hunks.find((hunk) => hunk.after === "")!;
    store.review(proposal.id, {
      [insertion.id]: "accept",
      [deletion.id]: "reject",
    });
    await store.apply(proposal.id);
    expect((await workspace.read("a.ts")).text).toBe(
      "insert\nalpha\nkeep\nomega\n",
    );
  });

  it("allows sequential undos while retaining work that preceded every proposal", async () => {
    const workspace = new MemoryWorkspace({ "a.ts": "// user\none" });
    const store = new ProposalStore(workspace);
    for (const [oldText, newText] of [
      ["one", "two"],
      ["two", "three"],
    ]) {
      const proposal = await store.stage("run", [
        { path: "a.ts", oldText: oldText!, newText: newText! },
      ]);
      store.review(proposal.id, { [proposal.hunks[0]!.id]: "accept" });
      await store.apply(proposal.id);
    }
    await store.undoLast();
    await store.undoLast();
    expect((await workspace.read("a.ts")).text).toBe("// user\none");
  });

  it("invalidates asynchronous staging before it can publish a cancelled proposal", async () => {
    const workspace = new MemoryWorkspace({ "a.ts": "one" });
    const store = new ProposalStore(workspace);
    const staging = store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "two" },
    ]);
    store.cancelRun("run");
    await expect(staging).rejects.toThrow(/cancel/i);
    expect(store.list()).toEqual([]);
    expect((await workspace.read("a.ts")).text).toBe("one");
  });

  it("checks cancellation again after asynchronous apply preflight", async () => {
    const workspace = new MemoryWorkspace({ "a.ts": "one" });
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "two" },
    ]);
    store.review(proposal.id, { [proposal.hunks[0]!.id]: "accept" });
    const applying = store.apply(proposal.id);
    queueMicrotask(() => store.cancelRun("run"));
    await expect(applying).rejects.toThrow(/cancel/i);
    expect((await workspace.read("a.ts")).text).toBe("one");
  });

  it("cancels before commit even when adapter preflight has already started", async () => {
    const workspace = new GatedWorkspace({ "a.ts": "one" });
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "two" },
    ]);
    store.review(proposal.id, { [proposal.hunks[0]!.id]: "accept" });
    const applying = store.apply(proposal.id);
    await workspace.waitingToCommit;
    store.cancelRun("run");
    workspace.continueCommit();
    await expect(applying).rejects.toThrow(/cancel/i);
    expect((await workspace.read("a.ts")).text).toBe("one");
  });

  it("rejects an obsolete review immediately before the adapter commits", async () => {
    const workspace = new GatedWorkspace({ "a.ts": "one" });
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "two" },
    ]);
    store.review(proposal.id, { [proposal.hunks[0]!.id]: "accept" });
    const applying = store.apply(proposal.id);
    await workspace.waitingToCommit;
    store.review(proposal.id, { [proposal.hunks[0]!.id]: "reject" });
    workspace.continueCommit();
    await expect(applying).rejects.toThrow(/review.*chang|obsolete/i);
    expect((await workspace.read("a.ts")).text).toBe("one");
  });

  it("uses atomic adapter comparisons to catch changes after preflight without partial writes", async () => {
    const workspace = new MemoryWorkspace({ "a.ts": "one", "b.ts": "two" });
    const store = new ProposalStore(workspace);
    const proposal = await store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "ONE" },
      { path: "b.ts", oldText: "two", newText: "TWO" },
    ]);
    store.review(
      proposal.id,
      Object.fromEntries(proposal.hunks.map((hunk) => [hunk.id, "accept"])),
    );
    workspace.beforeCommit = () =>
      workspace.userEdit("b.ts", "last-moment user work");
    await expect(store.apply(proposal.id)).rejects.toThrow(/conflict|version/i);
    expect((await workspace.read("a.ts")).text).toBe("one");
    expect((await workspace.read("b.ts")).text).toBe("last-moment user work");
  });

  it("rejects overlapping staged proposals before they poison the run overlay", async () => {
    const workspace = new MemoryWorkspace({ "a.ts": "one\nkeep\ntwo\n" });
    const store = new ProposalStore(workspace);
    await store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "ONE" },
    ]);
    await expect(
      store.stage("run", [{ path: "a.ts", oldText: "one", newText: "again" }]),
    ).rejects.toThrow(/overlap/i);
    await store.stage("run", [
      { path: "a.ts", oldText: "two", newText: "TWO" },
    ]);
    expect((await store.readOverlay("a.ts", "run")).text).toBe(
      "ONE\nkeep\nTWO\n",
    );
    expect(store.list()).toHaveLength(2);
  });

  it("invalidates sibling bases after applying while allowing fresh staging and unrelated reviews", async () => {
    const workspace = new MemoryWorkspace({
      "a.ts": "one\nkeep\ntwo\n",
      "b.ts": "unrelated",
    });
    const store = new ProposalStore(workspace);
    const first = await store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "ONE" },
    ]);
    const sibling = await store.stage("run", [
      { path: "a.ts", oldText: "two", newText: "TWO" },
    ]);
    const otherRunSibling = await store.stage("another-run", [
      { path: "a.ts", oldText: "one", newText: "another proposal" },
    ]);
    const unrelated = await store.stage("run", [
      { path: "b.ts", oldText: "unrelated", newText: "UNRELATED" },
    ]);
    for (const proposal of [first, sibling, unrelated])
      store.review(proposal.id, { [proposal.hunks[0]!.id]: "accept" });

    const result = await store.apply(first.id);
    expect(store.get(sibling.id)?.status).toBe("cancelled");
    expect(store.get(otherRunSibling.id)?.status).toBe("cancelled");
    expect(result.invalidatedProposalIds).toEqual([
      sibling.id,
      otherRunSibling.id,
    ]);
    expect(result.message).toMatch(/read.*stag/i);
    expect(store.get(first.id)?.status).toBe("applied");
    expect(store.get(unrelated.id)?.status).toBe("reviewed");
    await expect(store.apply(sibling.id)).rejects.toThrow(/cancel/i);
    expect(() =>
      store.review(sibling.id, { [sibling.hunks[0]!.id]: "accept" }),
    ).toThrow(/cancel/i);
    expect((await store.readOverlay("a.ts", "run")).text).toBe(
      "ONE\nkeep\ntwo\n",
    );

    const fresh = await store.stage("run", [
      { path: "a.ts", oldText: "two", newText: "TWO" },
    ]);
    expect((await store.readOverlay("a.ts", "run")).text).toBe(
      "ONE\nkeep\nTWO\n",
    );
    store.review(fresh.id, { [fresh.hunks[0]!.id]: "accept" });
    expect((await store.apply(fresh.id)).invalidatedProposalIds).toEqual([]);
    await store.apply(unrelated.id);
    expect((await workspace.read("b.ts")).text).toBe("UNRELATED");
  });

  it("invalidates sibling bases even when a later user edit prevents safe undo capture", async () => {
    class PostCommitEditWorkspace extends MemoryWorkspace {
      async apply(edits: WorkspaceChange[], preCommit?: () => void) {
        preCommit?.();
        await super.apply(edits);
        this.userEdit("a.ts", "later user work");
      }
    }
    const workspace = new PostCommitEditWorkspace({ "a.ts": "one\ntwo\n" });
    const store = new ProposalStore(workspace);
    const first = await store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "ONE" },
    ]);
    const sibling = await store.stage("run", [
      { path: "a.ts", oldText: "two", newText: "TWO" },
    ]);
    for (const proposal of [first, sibling])
      store.review(proposal.id, { [proposal.hunks[0]!.id]: "accept" });
    await expect(store.apply(first.id)).rejects.toThrow(/applied.*undo/i);
    expect(store.get(first.id)?.status).toBe("applied");
    expect(store.get(sibling.id)?.status).toBe("cancelled");
    await expect(store.apply(sibling.id)).rejects.toThrow(/cancel/i);
    expect((await store.readOverlay("a.ts", "run")).text).toBe(
      "later user work",
    );
  });

  it("marks committed proposals applied and invalidates siblings before reading undo snapshots", async () => {
    class PostCommitReadFailureWorkspace extends MemoryWorkspace {
      private failNextRead = false;
      async read(path: string) {
        if (this.failNextRead) {
          this.failNextRead = false;
          throw new Error("Snapshot unavailable after commit");
        }
        return super.read(path);
      }
      async apply(edits: WorkspaceChange[], preCommit?: () => void) {
        preCommit?.();
        await super.apply(edits);
        this.failNextRead = true;
      }
    }
    const workspace = new PostCommitReadFailureWorkspace({
      "a.ts": "one\ntwo\n",
    });
    const store = new ProposalStore(workspace);
    const first = await store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "ONE" },
    ]);
    const sibling = await store.stage("run", [
      { path: "a.ts", oldText: "two", newText: "TWO" },
    ]);
    store.review(first.id, { [first.hunks[0]!.id]: "accept" });
    await expect(store.apply(first.id)).rejects.toThrow(
      /snapshot unavailable/i,
    );
    expect(store.get(first.id)?.status).toBe("applied");
    expect(store.get(sibling.id)?.status).toBe("cancelled");
    await expect(store.apply(first.id)).rejects.toThrow(/applied|replay/i);
    expect((await store.readOverlay("a.ts", "run")).text).toBe("ONE\ntwo\n");
  });

  it("invalidates proposals based on undone text while preserving unrelated pending proposals and earlier user work", async () => {
    const workspace = new MemoryWorkspace({
      "a.ts": "// earlier user work\none\n",
      "b.ts": "other",
    });
    const store = new ProposalStore(workspace);
    const applied = await store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "ONE" },
    ]);
    store.review(applied.id, { [applied.hunks[0]!.id]: "accept" });
    await store.apply(applied.id);
    const invalidated = await store.stage("run", [
      { path: "a.ts", oldText: "ONE", newText: "TWO" },
    ]);
    store.review(invalidated.id, { [invalidated.hunks[0]!.id]: "accept" });
    const unrelated = await store.stage("run", [
      { path: "b.ts", oldText: "other", newText: "OTHER" },
    ]);

    await store.undoLast();
    expect((await workspace.read("a.ts")).text).toBe(
      "// earlier user work\none\n",
    );
    expect(store.get(invalidated.id)?.status).toBe("cancelled");
    await expect(store.apply(invalidated.id)).rejects.toThrow(/cancel/i);
    expect(store.get(unrelated.id)?.status).toBe("pending");
    expect((await store.readOverlay("b.ts", "run")).text).toBe("OTHER");
    await store.stage("run", [
      { path: "a.ts", oldText: "one", newText: "fresh" },
    ]);
    expect((await store.readOverlay("a.ts", "run")).text).toBe(
      "// earlier user work\nfresh\n",
    );
  });
});
