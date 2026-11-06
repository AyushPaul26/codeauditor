import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import type { WorkspaceAdapter } from "../contracts";
import type { Proposal } from "../edits/proposalStore";
export class DiffReview
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly documents = new Map<string, string>();
  provideTextDocumentContent(uri: vscode.Uri): string {
    return (
      this.documents.get(uri.toString()) ??
      "This preview expired. Open the proposal again."
    );
  }
  async open(proposal: Proposal, adapter: WorkspaceAdapter): Promise<void> {
    const paths = [...new Set(proposal.hunks.map((h) => h.path))];
    for (const path of paths) {
      const before = await adapter.read(path);
      if (before.version !== proposal.baseVersions[path])
        throw new Error(
          `The proposal for ${path} is stale. Request a new proposal before reviewing.`,
        );
      let after = before.text;
      for (const hunk of proposal.hunks
        .filter((h) => h.path === path)
        .sort((a, b) => b.start - a.start))
        after = after.slice(0, hunk.start) + hunk.after + after.slice(hunk.end);
      const id = randomUUID(),
        left = vscode.Uri.parse(
          `codeauditor-preview:/before/${id}/${encodeURIComponent(path)}`,
        ),
        right = vscode.Uri.parse(
          `codeauditor-preview:/after/${id}/${encodeURIComponent(path)}`,
        );
      this.documents.set(left.toString(), before.text);
      this.documents.set(right.toString(), after);
      while (this.documents.size > 60)
        this.documents.delete(this.documents.keys().next().value!);
      await vscode.commands.executeCommand(
        "vscode.diff",
        left,
        right,
        `${path} · proposed changes`,
        { preview: false },
      );
    }
  }
  dispose(): void {
    this.documents.clear();
  }
}
