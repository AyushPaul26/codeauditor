import * as vscode from "vscode";
import path from "node:path";
import { access } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readRuntime, localRuntimeDir, type LocalRuntime } from "./config";
import { loadPublicFixtures } from "./workspace/publicFixtures";
import { VscodeWorkspace } from "./workspace/vscodeAdapter";
import { ProposalStore, type ReviewDecision } from "./edits/proposalStore";
import { CommandRunner } from "./mcp/commandRunner";
import { startWorkspaceServer } from "./mcp/server";
import {
  TrueForgeClient,
  validateTrueForgeUrl,
  type AgentEvent,
} from "./trueforge/client";
import { AgentPanel } from "./ui/agentPanel";
import { DiffReview } from "./ui/diffReview";
import type { WorkspaceAdapter } from "./contracts";
import { completeApprovalBatch, type HostApprovalDecision } from "./approvals";

type Approval = Extract<AgentEvent, { type: "approval" }>;
export class Application implements vscode.Disposable {
  readonly panel: AgentPanel;
  readonly diff = new DiffReview();
  private adapter?: VscodeWorkspace;
  private proposals?: ProposalStore;
  private commands?: CommandRunner;
  private server?: Awaited<ReturnType<typeof startWorkspaceServer>>;
  private client?: TrueForgeClient;
  private config?: LocalRuntime;
  private runId?: string;
  private controller?: AbortController;
  private pending: Approval[] = [];
  private approvalDecisions = new Map<string, HostApprovalDecision>();
  private readonly reviewed = new Set<string>();
  private commandPermits: string[] = [];
  private booting?: Promise<void>;
  private streaming = false;
  private starting = false;
  private messages = new Map<string, string>();
  constructor(private readonly context: vscode.ExtensionContext) {
    this.panel = new AgentPanel(context.extensionUri, (message) =>
      this.dispatch(message),
    );
  }
  async boot(): Promise<void> {
    if (this.booting) return this.booting;
    this.booting = this.initialize().finally(() => (this.booting = undefined));
    return this.booting;
  }
  private async initialize(): Promise<void> {
    if (this.panel.state.busy)
      throw new Error("Stop the current task before reconnecting.");
    await this.server?.close();
    this.server = undefined;
    if (!vscode.workspace.isTrusted)
      throw new Error("Trust this project before enabling workspace tools.");
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder)
      throw new Error(
        "Open a local project folder, then use Check connection.",
      );
    this.config = await readRuntime();
    this.adapter = new VscodeWorkspace(folder.uri.fsPath);
    this.proposals = new ProposalStore(this.adapter);
    const source = this.adapter,
      store = this.proposals;
    const overlayAdapter: WorkspaceAdapter = {
      root: source.root,
      read: (p) => store.readOverlay(p, this.runId),
      apply: (e, preCommit) => source.apply(e, preCommit),
      listFiles: async () => [
        ...new Set([
          ...(await source.listFiles()),
          ...store
            .list(this.runId)
            .filter((p) => p.status === "pending" || p.status === "reviewed")
            .flatMap((p) => p.hunks.map((h) => h.path)),
        ]),
      ],
    };
    const setting = vscode.workspace.getConfiguration("codeauditor");
    let pythonPath =
      setting.get<string>("pythonPath") || this.config.pythonPath;
    if (!pythonPath) {
      const candidate = path.join(
        localRuntimeDir(),
        "venvs",
        path.basename(source.root),
        process.platform === "win32" ? "Scripts" : "bin",
        process.platform === "win32" ? "python.exe" : "python",
      );
      try {
        await access(candidate);
        pythonPath = candidate;
      } catch {
        /* use the configured system Python */
      }
    }
    const publicFixtures = await loadPublicFixtures(
      source.root,
      localRuntimeDir(),
    );
    this.commands = new CommandRunner(overlayAdapter, {
      pythonPath,
      publicFixtures,
    });
    this.server = await startWorkspaceServer({
      adapter: source,
      proposals: store,
      commands: this.commands,
      token: this.config.mcp.token,
      port: this.config.mcp.port,
      getRunId: () => this.runId,
      getSignal: () => this.controller?.signal,
      consumeCommandPermission: (args) => {
        const key = JSON.stringify([args.executable, args.args]),
          index = this.commandPermits.indexOf(key);
        if (index < 0) return false;
        this.commandPermits.splice(index, 1);
        return true;
      },
      contextTokens: setting.get<number>("contextTokens", 4096),
      onTool: (name, result) => {
        if (name === "retrieve_context") {
          const selected = result as {
            snippets: Array<{
              path: string;
              startLine: number;
              endLine: number;
              reason: string;
            }>;
            usedTokens: number;
            inputBudget: number;
          };
          this.panel.update({
            context: selected.snippets,
            contextBudget: `~${selected.usedTokens} estimated snippet tokens / ${selected.inputBudget} input allocation`,
          });
        }
        if (name === "stage_patch" || name === "request_apply")
          this.syncProposals();
      },
    });
    this.panel.update({
      error: undefined,
      status: `Workspace tools ready · ${path.basename(source.root)}`,
    });
  }
  private newClient(): TrueForgeClient {
    const setting = vscode.workspace.getConfiguration("codeauditor");
    const agentId =
      setting.get<string>("agentId") || this.config?.harness.agentId;
    if (!agentId)
      throw new Error(
        "No TrueForge agent configured. Run npm run harness:configure after starting the harness.",
      );
    const explicit = setting.inspect<string>("trueforgeUrl");
    return new TrueForgeClient({
      baseUrl:
        explicit?.workspaceFolderValue ??
        explicit?.workspaceValue ??
        explicit?.globalValue ??
        this.config!.harness.url,
      agentId,
      fallbackAgentId:
        setting.get<string>("fallbackAgentId") ||
        this.config?.harness.fallbackAgentId,
    });
  }
  async start(instruction: string): Promise<void> {
    if (this.starting)
      throw new Error(
        "A task is already starting. Wait for it before sending another.",
      );
    this.starting = true;
    try {
      if (this.streaming)
        throw new Error(
          "The previous response is still stopping. Wait a moment before starting another task.",
        );
      if (this.panel.state.busy)
        throw new Error(
          "A task is already running or waiting for review. Stop it first.",
        );
      if (!this.server) await this.boot();
      if (
        this.proposals
          ?.list(this.runId)
          .some((p) => p.status === "pending" || p.status === "reviewed")
      ) {
        const choice = await vscode.window.showWarningMessage(
          "Starting another task discards unapproved proposals. Applied edits are kept.",
          { modal: true },
          "Discard proposals",
        );
        if (choice !== "Discard proposals") {
          this.panel.update({
            busy: false,
            status: "Previous proposals kept",
            error: undefined,
          });
          this.syncProposals();
          return;
        }
      }
      if (this.runId) this.proposals?.cancelRun(this.runId);
      this.runId = randomUUID();
      this.controller = new AbortController();
      this.pending = [];
      this.approvalDecisions.clear();
      this.reviewed.clear();
      this.commandPermits = [];
      this.messages.clear();
      this.client = this.newClient();
      this.panel.update({
        busy: true,
        error: undefined,
        status: "Connecting to TrueForge…",
        text: "",
        activity: [],
        context: [],
        proposals: [],
        command: undefined,
      });
      await this.consume(
        this.client.run(instruction, { signal: this.controller.signal }),
      );
    } finally {
      this.starting = false;
    }
  }
  private async consume(events: AsyncGenerator<AgentEvent>): Promise<void> {
    if (this.streaming)
      throw new Error("Wait for the current stream before resuming.");
    this.streaming = true;
    const id = this.runId;
    try {
      for await (const event of events) {
        if (id !== this.runId || this.controller?.signal.aborted) continue;
        if (event.type === "text") {
          this.messages.set(
            event.messageId,
            event.delta
              ? (this.messages.get(event.messageId) ?? "") + event.text
              : event.text,
          );
          this.panel.update({
            text: [...this.messages.values()].join("\n\n").slice(-80000),
          });
        }
        if (event.type === "session")
          this.panel.activity(`TrueForge session ${event.sessionId}`);
        if (event.type === "tool")
          this.panel.activity(
            `${event.status === "running" ? "→" : event.status === "failed" ? "×" : "✓"} ${event.toolName}${event.status === "failed" ? " · failed" : ""}`,
          );
        if (event.type === "approval") {
          this.pending.push(event);
          this.panel.update({ status: "Waiting for your review" });
          if (event.toolName === "run_command") {
            this.panel.update({
              command: {
                executable: String(event.args.executable ?? ""),
                args: Array.isArray(event.args.args)
                  ? event.args.args.map(String)
                  : [],
              },
            });
          }
          this.syncProposals();
        }
        if (event.type === "status")
          this.panel.update({ status: event.message });
        if (event.type === "error") {
          this.panel.update({
            error: event.message,
            status: "Task stopped",
            busy: false,
          });
          this.revokeRun();
        }
        if (event.type === "done") {
          if (event.status === "cancelled") this.revokeRun();
          this.panel.update({
            busy: event.awaitingApproval,
            status:
              event.status === "cancelled"
                ? "Cancelled · no unapproved edits applied"
                : event.awaitingApproval
                  ? "Waiting for your review"
                  : "Task complete · review and save any accepted edits",
          });
        }
      }
    } catch (error) {
      this.revokeRun();
      this.panel.fail(error);
      this.panel.update({ busy: false, status: "Task stopped" });
    } finally {
      this.streaming = false;
      this.syncProposals();
    }
    // A user may have reviewed before the model requested application. Resume
    // only those exact reviewed proposal IDs, never infer consent from model text.
    for (const a of this.pending)
      if (
        a.toolName === "request_apply" &&
        this.reviewed.has(String(a.args.proposalId))
      )
        this.approvalDecisions.set(a.toolCallId, {
          toolCallId: a.toolCallId,
          allow: true,
        });
    await this.resumeApprovals();
  }
  private revokeRun(): void {
    this.controller?.abort();
    if (this.runId) {
      this.proposals?.cancelRun(this.runId);
      this.commands?.cancel(this.runId);
    }
    this.pending = [];
    this.approvalDecisions.clear();
    this.commandPermits = [];
    this.panel.update({ command: undefined });
  }
  private async resumeApprovals(): Promise<void> {
    if (this.streaming || this.controller?.signal.aborted) return;
    const batch = completeApprovalBatch(this.pending, this.approvalDecisions);
    if (!batch) {
      const command = this.pending.find(
        (a) =>
          a.toolName === "run_command" &&
          !this.approvalDecisions.has(a.toolCallId),
      );
      this.panel.update({
        command: command
          ? {
              executable: String(command.args.executable ?? ""),
              args: Array.isArray(command.args.args)
                ? command.args.args.map(String)
                : [],
            }
          : undefined,
      });
      return;
    }
    this.pending = [];
    this.approvalDecisions.clear();
    this.panel.update({ command: undefined, busy: true });
    await this.consume(this.client!.approve(batch));
  }
  async cancel(): Promise<void> {
    const id = this.runId;
    if (!id) return;
    this.controller?.abort();
    this.proposals?.cancelRun(id);
    this.commands?.cancel(id);
    this.pending = [];
    this.approvalDecisions.clear();
    this.commandPermits = [];
    this.panel.update({
      busy: true,
      status: "Stopping · approved edits are kept",
      command: undefined,
    });
    this.syncProposals();
    try {
      await this.client?.cancel();
    } finally {
      this.panel.update({
        busy: false,
        status: "Cancelled · approved edits are kept",
      });
    }
  }
  private syncProposals(): void {
    this.panel.update({
      proposals:
        this.proposals?.list(this.runId).map((p) => ({
          ...p,
          approvalPending: this.pending.some(
            (a) => a.toolName === "request_apply" && a.args.proposalId === p.id,
          ),
        })) ?? [],
    });
  }
  async dispatch(message: unknown): Promise<void> {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    const m = message as Record<string, unknown>;
    if (m.type === "run") {
      if (
        typeof m.instruction !== "string" ||
        !m.instruction.trim() ||
        m.instruction.length > 10000
      )
        throw new Error("Enter a task under 10,000 characters.");
      await this.start(m.instruction);
    } else if (m.type === "cancel") await this.cancel();
    else if (m.type === "status") await this.status();
    else if (m.type === "undo") {
      await this.proposals?.undoLast();
      this.panel.update({ status: "Last applied change undone" });
      this.syncProposals();
    } else if (m.type === "diff") {
      const p = this.proposals?.get(String(m.proposalId));
      if (p && this.adapter) await this.diff.open(p, this.adapter);
    } else if (m.type === "review") {
      if (this.streaming)
        throw new Error(
          "Wait for the current response to finish before applying review.",
        );
      if (!this.client || !this.controller || this.controller.signal.aborted)
        throw new Error("This run is no longer active. Start a new task.");
      const id = String(m.proposalId),
        proposal = this.proposals?.get(id);
      if (!proposal || proposal.runId !== this.runId)
        throw new Error("Unknown proposal for this run.");
      this.proposals!.review(id, m.decisions as Record<string, ReviewDecision>);
      this.reviewed.add(id);
      const approval = this.pending.find(
        (a) => a.toolName === "request_apply" && a.args.proposalId === id,
      );
      this.panel.update({ busy: true, error: undefined });
      if (approval) {
        this.approvalDecisions.set(approval.toolCallId, {
          toolCallId: approval.toolCallId,
          allow: true,
        });
        await this.resumeApprovals();
      } else {
        if (this.pending.length)
          throw new Error(
            "Finish the pending tool approvals before requesting another proposal application.",
          );
        await this.consume(
          this.client.run(
            `The user has reviewed proposal ${id}. Call request_apply with that proposalId now. Do not restage or change the proposal.`,
            {
              sessionId: this.client.sessionId,
              signal: this.controller.signal,
            },
          ),
        );
      }
    } else if (m.type === "command") {
      const approval = this.pending.find(
        (a) =>
          a.toolName === "run_command" &&
          !this.approvalDecisions.has(a.toolCallId),
      );
      if (!approval || this.streaming)
        throw new Error("No command is ready for approval.");
      const allow = m.allow === true;
      if (allow)
        this.commandPermits.push(
          JSON.stringify([approval.args.executable, approval.args.args]),
        );
      this.approvalDecisions.set(approval.toolCallId, {
        toolCallId: approval.toolCallId,
        allow,
        reason: allow ? undefined : "User rejected command.",
      });
      await this.resumeApprovals();
    }
  }
  async status(): Promise<void> {
    if (!this.server) await this.boot();
    const explicit = vscode.workspace
      .getConfiguration("codeauditor")
      .inspect<string>("trueforgeUrl");
    const url =
      explicit?.workspaceFolderValue ??
      explicit?.workspaceValue ??
      explicit?.globalValue ??
      this.config!.harness.url;
    validateTrueForgeUrl(url);
    const response = await fetch(`${url.replace(/\/$/, "")}/healthz`, {
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        "TrueForge did not report healthy. Start npm run harness:start.",
      );
    this.panel.update({
      error: undefined,
      status:
        "TrueForge and workspace bridge ready · model verified when a task runs",
    });
  }
  async inline(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty)
      throw new Error("Select a region of code first.");
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) throw new Error("Open a project folder first.");
    const relative = path
      .relative(folder.uri.fsPath, editor.document.uri.fsPath)
      .split(path.sep)
      .join("/");
    const text = editor.document.getText(editor.selection);
    if (text.length > 8000)
      throw new Error(
        "Select a smaller region (under 8,000 characters) for the local model.",
      );
    const instruction = await vscode.window.showInputBox({
      title: "CodeAuditor · edit selection",
      prompt: "Describe the change to this region",
      ignoreFocusOut: true,
    });
    if (!instruction?.trim()) return;
    await vscode.commands.executeCommand("codeauditor.agent.focus");
    await this.start(
      `${instruction}\n\nSelected region in @file:${JSON.stringify(relative)}, lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}. Read the file before staging an exact replacement.\n<selected_code>\n${text}\n</selected_code>`,
    );
  }
  dispose(): void {
    this.controller?.abort();
    if (this.runId) {
      this.proposals?.cancelRun(this.runId);
      this.commands?.cancel(this.runId);
    }
    void this.client?.cancel();
    void this.server?.close();
    this.panel.dispose();
    this.diff.dispose();
  }
}
let application: Application | undefined;
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  application = new Application(context);
  const app = application;
  context.subscriptions.push(
    app,
    vscode.window.registerWebviewViewProvider("codeauditor.agent", app.panel),
    vscode.workspace.registerTextDocumentContentProvider(
      "codeauditor-preview",
      app.diff,
    ),
  );
  const command = (name: string, action: () => PromiseLike<unknown>) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(name, () =>
        Promise.resolve(action()).catch((error) => app.panel.fail(error)),
      ),
    );
  command("codeauditor.open", () =>
    vscode.commands.executeCommand("codeauditor.agent.focus"),
  );
  command("codeauditor.inlineEdit", () => app.inline());
  command("codeauditor.cancel", () => app.cancel());
  command("codeauditor.status", () => app.status());
  command("codeauditor.review", () =>
    vscode.commands.executeCommand("codeauditor.agent.focus"),
  );
  command("codeauditor.undo", () => app.dispatch({ type: "undo" }));
  await app.boot().catch((error) => app.panel.fail(error));
}
export function deactivate(): void {
  application?.dispose();
  application = undefined;
}
