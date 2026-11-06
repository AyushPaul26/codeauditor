import * as vscode from "vscode";
import path from "node:path";
import {
  stat,
  realpath,
  writeFile,
  link,
  unlink,
  mkdir,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type {
  DocumentSnapshot,
  WorkspaceAdapter,
  WorkspaceChange,
} from "../contracts";
import { resolveWorkspacePath, isExcluded } from "./paths";
import { prepareWorkspaceChanges } from "./transaction";

/** Host-only IO. The model sees MCP tools, never this adapter or approval receipts. */
export class VscodeWorkspace implements WorkspaceAdapter {
  constructor(readonly root: string) {}
  async listFiles(): Promise<string[]> {
    const uris = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.root, "**/*"),
      "**/{.git,node_modules,.venv,venv,__pycache__,.pytest_cache,dist,out,build}/**",
      5000,
    );
    return uris
      .map((uri) =>
        path.relative(this.root, uri.fsPath).split(path.sep).join("/"),
      )
      .filter((p) => !isExcluded(p));
  }
  async read(relative: string): Promise<DocumentSnapshot> {
    const full = await resolveWorkspacePath(this.root, relative, true),
      uri = vscode.Uri.file(full);
    let information;
    try {
      information = await stat(full);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { path: relative, text: "", version: "missing" };
      throw error;
    }
    if (information.size > 2 * 1024 * 1024)
      throw new Error(
        `File exceeds the 2 MiB workspace read limit: ${relative}`,
      );
    if (!information.isFile())
      throw new Error("Only regular source files can be read.");
    const doc = await vscode.workspace.openTextDocument(uri),
      text = doc.getText();
    if (text.includes("\0"))
      throw new Error("Binary files are not available to the agent.");
    return {
      path: relative,
      text,
      version: `${doc.version}:${createHash("sha256").update(text).digest("hex")}`,
    };
  }
  async apply(
    changes: WorkspaceChange[],
    preCommit?: () => void,
  ): Promise<void> {
    const prepared = await prepareWorkspaceChanges(this, changes);
    // Resource operations are intentionally single-file. VS Code only guarantees
    // all-or-nothing application for an edit consisting entirely of text edits.
    if (prepared.length === 1 && prepared[0].before.version === "missing") {
      const { change } = prepared[0];
      if (change.delete) throw new Error("Cannot delete a missing file.");
      const full = await resolveWorkspacePath(this.root, change.path, true);
      await mkdir(path.dirname(full), { recursive: true });
      // Revalidate after directory creation. Hard-link installs a complete file
      // exclusively, so a concurrent existing file is never overwritten.
      await resolveWorkspacePath(this.root, change.path, true);
      const temporary = path.join(
        path.dirname(full),
        `.codeauditor-${randomUUID()}.tmp`,
      );
      try {
        await writeFile(temporary, change.text, { flag: "wx" });
        preCommit?.();
        await link(temporary, full);
      } finally {
        await unlink(temporary).catch(() => {});
      }
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    const checkedDocuments: Array<{
      doc: vscode.TextDocument;
      change: WorkspaceChange;
    }> = [];
    for (const { change } of prepared) {
      const full = await resolveWorkspacePath(this.root, change.path),
        uri = vscode.Uri.file(full);
      if (change.delete) {
        edit.deleteFile(uri, { ignoreIfNotExists: false });
        continue;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      // Compare the final text/version again after async path/document resolution.
      const current = {
        path: change.path,
        text: doc.getText(),
        version: `${doc.version}:${createHash("sha256").update(doc.getText()).digest("hex")}`,
      };
      if (current.version !== change.expectedVersion)
        throw new Error(`Document changed during review: ${change.path}`);
      checkedDocuments.push({ doc, change });
      edit.replace(
        uri,
        new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(current.text.length),
        ),
        change.text,
      );
    }
    // There are deliberately no awaits between this complete version recheck
    // and submitting the edit. Earlier documents may have changed while opening
    // later documents in the asynchronous preflight above.
    for (const { doc, change } of checkedDocuments) {
      const current = `${doc.version}:${createHash("sha256").update(doc.getText()).digest("hex")}`;
      if (current !== change.expectedVersion)
        throw new Error(`Document changed during review: ${change.path}`);
    }
    preCommit?.();
    if (!(await vscode.workspace.applyEdit(edit, { isRefactoring: true })))
      throw new Error(
        "VS Code rejected the edit. Your proposal remains available for review.",
      );
  }
}
