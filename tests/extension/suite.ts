import * as vscode from "vscode";
import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { VscodeWorkspace } from "../../src/workspace/vscodeAdapter";
import { ProposalStore } from "../../src/edits/proposalStore";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension(
    "AyushPaul26.codeauditor-local",
  );
  assert(extension, "Extension was not installed/activated.");
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const id of [
    "codeauditor.open",
    "codeauditor.inlineEdit",
    "codeauditor.cancel",
    "codeauditor.undo",
  ])
    assert(commands.includes(id), `Command missing: ${id}`);
  await vscode.commands.executeCommand("codeauditor.open");
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert(root, "Test workspace missing.");
  const adapter = new VscodeWorkspace(root),
    store = new ProposalStore(adapter),
    original = await adapter.read("sample.py");
  const proposal = await store.stage("editor-test", [
    { path: "sample.py", oldText: "FIRST = 1", newText: "FIRST = 10" },
    { path: "sample.py", oldText: "SECOND = 2", newText: "SECOND = 20" },
  ]);
  assert.equal(
    await readFile(path.join(root, "sample.py"), "utf8"),
    original.text,
    "Staging changed disk.",
  );
  store.review(proposal.id, {
    [proposal.hunks[0].id]: "accept",
    [proposal.hunks[1].id]: "reject",
  });
  await store.apply(proposal.id);
  assert.equal(
    (await adapter.read("sample.py")).text,
    "FIRST = 10\n\nSECOND = 2\n",
  );
  assert.equal(
    await readFile(path.join(root, "sample.py"), "utf8"),
    original.text,
    "Applying editor edits silently saved disk.",
  );
  await store.undoLast();
  assert.equal((await adapter.read("sample.py")).text, original.text);
  const stale = await store.stage("stale-test", [
    { path: "sample.py", oldText: "FIRST = 1", newText: "FIRST = 3" },
  ]);
  store.review(stale.id, { [stale.hunks[0].id]: "accept" });
  const userEdit = new vscode.WorkspaceEdit();
  userEdit.insert(
    vscode.Uri.file(path.join(root, "sample.py")),
    new vscode.Position(0, 0),
    "# user work\n",
  );
  await vscode.workspace.applyEdit(userEdit);
  await assert.rejects(() => store.apply(stale.id), /stale|conflict/i);
  assert((await adapter.read("sample.py")).text.startsWith("# user work"));
  const cancelled = await store.stage("cancel-test", [
    { path: "sample.py", oldText: "SECOND = 2", newText: "SECOND = 99" },
  ]);
  store.review(cancelled.id, { [cancelled.hunks[0].id]: "accept" });
  store.cancelRun("cancel-test");
  await assert.rejects(() => store.apply(cancelled.id), /cancel/i);
  const newFile = await store.stage("new-file", [
    { path: "new_module.py", oldText: "", newText: "VALUE = 1\n" },
  ]);
  store.review(newFile.id, { [newFile.hunks[0].id]: "accept" });
  await store.apply(newFile.id);
  assert.equal((await adapter.read("new_module.py")).text, "VALUE = 1\n");
  await store.undoLast();
  assert.equal((await adapter.read("new_module.py")).version, "missing");
  console.log(
    "CodeAuditor native extension checks passed: activation, commands, per-hunk edits, unchanged disk before save, undo, stale conflict, cancellation, new-file undo.",
  );
}
