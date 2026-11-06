import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import { panelHtml } from "./html";
export interface PanelState {
  busy: boolean;
  status: string;
  error?: string;
  text: string;
  activity: string[];
  context: Array<{
    path: string;
    startLine: number;
    endLine: number;
    reason: string;
  }>;
  contextBudget?: string;
  proposals: Array<{
    id: string;
    status: string;
    approvalPending: boolean;
    hunks: ReadonlyArray<{
      id: string;
      path: string;
      before: string;
      after: string;
    }>;
  }>;
  command?: { executable: string; args: string[] };
}
export class AgentPanel
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  private view?: vscode.WebviewView;
  private timer?: ReturnType<typeof setTimeout>;
  readonly state: PanelState = {
    busy: false,
    status: "Open a trusted project to start",
    text: "",
    activity: [],
    context: [],
    proposals: [],
  };
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly receive: (message: unknown) => Promise<void>,
  ) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    const css = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "panel.css"),
    );
    const js = view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "panel.js"),
    );
    view.webview.html = panelHtml(
      randomBytes(24).toString("hex"),
      css.toString(),
      js.toString(),
      view.webview.cspSource,
    );
    view.webview.onDidReceiveMessage((message) => {
      if (message?.type === "ready") this.flush();
      else void this.receive(message).catch((error) => this.fail(error));
    });
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    this.flush();
  }
  update(patch: Partial<PanelState>): void {
    Object.assign(this.state, patch);
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, 40);
  }
  activity(text: string): void {
    this.update({ activity: [...this.state.activity, text].slice(-40) });
  }
  fail(error: unknown): void {
    this.update({
      error:
        error instanceof Error
          ? error.message
          : "CodeAuditor could not complete the action.",
    });
  }
  private flush(): void {
    void this.view?.webview.postMessage({ type: "state", state: this.state });
  }
  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
