import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import type {
  DocumentSnapshot,
  WorkspaceAdapter,
  WorkspaceChange,
} from "../../src/contracts";
import type {
  AgentEvent,
  TrueForgeClient,
  TrueForgeConfig,
} from "../../src/trueforge/client";
import type { startWorkspaceServer } from "../../src/mcp/server";
import type { Proposal } from "../../src/edits/proposalStore";

type ServerOptions = Parameters<typeof startWorkspaceServer>[0];
const host = vi.hoisted(() => ({
  adapter: undefined as WorkspaceAdapter | undefined,
  servers: [] as ServerOptions[],
  bootGate: undefined as Promise<void> | undefined,
  settings: {} as Record<string, unknown>,
  overrides: {} as Record<string, Record<string, unknown>>,
  runtime: {
    version: 1,
    mcp: { token: "a".repeat(64), port: 8792 },
    harness: {
      url: "http://127.0.0.1:9876",
      agentId: "configured-agent",
      fallbackAgentId: "configured-fallback",
    },
    pythonPath: "/configured/python",
  },
  created: vi.fn<(config: TrueForgeConfig) => void>(),
  run: vi.fn<TrueForgeClient["run"]>(),
  approve: vi.fn<TrueForgeClient["approve"]>(),
  cancel: vi.fn<TrueForgeClient["cancel"]>(),
  close: vi.fn<() => Promise<void>>(),
}));

vi.mock("vscode", () => ({
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: "/project" } }],
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => host.settings[key] ?? fallback,
      inspect: (key: string) => ({
        defaultValue: host.settings[key],
        ...host.overrides[key],
      }),
    }),
  },
  window: { showWarningMessage: vi.fn(async () => undefined) },
}));
vi.mock("../../src/config", () => ({
  readRuntime: vi.fn(async () => host.runtime),
  localRuntimeDir: () => "/unused-runtime",
}));
vi.mock("../../src/workspace/vscodeAdapter", () => ({
  VscodeWorkspace: vi.fn(function () {
    return host.adapter;
  }),
}));
vi.mock("../../src/mcp/server", () => ({
  startWorkspaceServer: vi.fn(async (options: ServerOptions) => {
    host.servers.push(options);
    await host.bootGate;
    return { url: "http://127.0.0.1:8792/mcp", close: host.close };
  }),
}));
vi.mock("../../src/trueforge/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/trueforge/client")>()),
  TrueForgeClient: class {
    readonly sessionId = "session";
    readonly run = host.run;
    readonly approve = host.approve;
    readonly cancel = host.cancel;
    constructor(config: TrueForgeConfig) {
      host.created(config);
    }
  },
}));

import { Application } from "../../src/extension";

class MemoryWorkspace implements WorkspaceAdapter {
  readonly root = "/project";
  private readonly documents = new Map<string, DocumentSnapshot>();
  constructor(files: Record<string, string>) {
    for (const [path, text] of Object.entries(files))
      this.documents.set(path, { path, text, version: "1" });
  }
  async listFiles() {
    return [...this.documents.keys()];
  }
  async read(path: string): Promise<DocumentSnapshot> {
    return {
      ...(this.documents.get(path) ?? { path, text: "", version: "missing" }),
    };
  }
  async apply(edits: WorkspaceChange[], preCommit?: () => void) {
    for (const edit of edits)
      if (
        (this.documents.get(edit.path)?.version ?? "missing") !==
        edit.expectedVersion
      )
        throw new Error("Document version conflict");
    preCommit?.();
    for (const edit of edits) {
      if (edit.delete) this.documents.delete(edit.path);
      else
        this.documents.set(edit.path, {
          path: edit.path,
          text: edit.text,
          version: String(
            Number(this.documents.get(edit.path)?.version ?? 0) + 1,
          ),
        });
    }
  }
}

const done = (awaitingApproval = false): AgentEvent => ({
  type: "done",
  sessionId: "session",
  status: "done",
  awaitingApproval,
});
const approval = (
  toolCallId: string,
  toolName: string,
  args: Record<string, unknown>,
): AgentEvent => ({
  type: "approval",
  sessionId: "session",
  threadId: "thread",
  sourceEventId: `event-${toolCallId}`,
  toolCallId,
  toolName,
  args,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => (resolve = release));
  return { promise, resolve };
}
function bridge(): ServerOptions {
  expect(host.servers).toHaveLength(1);
  return host.servers[0]!;
}
function runId(): string {
  const id = bridge().getRunId?.();
  expect(id).toBeTruthy();
  return id!;
}
function review(proposal: Proposal, rejectedIndex?: number) {
  return {
    type: "review",
    proposalId: proposal.id,
    decisions: Object.fromEntries(
      proposal.hunks.map((hunk, index) => [
        hunk.id,
        index === rejectedIndex ? "reject" : "accept",
      ]),
    ),
  };
}

let app: Application;
let workspace: MemoryWorkspace;
beforeEach(() => {
  vi.clearAllMocks();
  host.servers.length = 0;
  host.bootGate = undefined;
  host.settings = { trueforgeUrl: "http://127.0.0.1:8790" };
  host.overrides = {};
  workspace = new MemoryWorkspace({
    "a.ts": "alpha\nkeep\nomega\n",
    "b.ts": "red\nkeep\nblue\n",
  });
  host.adapter = workspace;
  host.run.mockImplementation(async function* () {
    yield done();
  });
  host.approve.mockImplementation(async function* () {
    yield done();
  });
  host.cancel.mockResolvedValue(undefined);
  host.close.mockResolvedValue(undefined);
  app = new Application({
    extensionUri: { fsPath: "/extension" },
  } as vscode.ExtensionContext);
});
afterEach(() => {
  app.dispose();
  vi.unstubAllGlobals();
});

describe("Application review and lifecycle", () => {
  it("waits for every proposal review, then applies the exact accepted hunks", async () => {
    let first!: Proposal;
    let second!: Proposal;
    host.run.mockImplementation(async function* () {
      first = await bridge().proposals.stage(runId(), [
        {
          path: "a.ts",
          oldText: "alpha\nkeep\nomega\n",
          newText: "ALPHA\nkeep\nOMEGA\n",
        },
      ]);
      second = await bridge().proposals.stage(runId(), [
        {
          path: "b.ts",
          oldText: "red\nkeep\nblue\n",
          newText: "RED\nkeep\nBLUE\n",
        },
      ]);
      yield approval("first", "request_apply", { proposalId: first.id });
      yield approval("second", "request_apply", { proposalId: second.id });
      yield done(true);
    });
    const results: unknown[] = [];
    host.approve.mockImplementation(async function* () {
      results.push(await bridge().proposals.apply(first.id));
      results.push(await bridge().proposals.apply(second.id));
      yield done();
    });

    await app.start("Update both files; I will review each hunk.");
    expect(app.panel.state.busy).toBe(true);
    expect(app.panel.state.proposals).toHaveLength(2);
    expect(first.hunks).toHaveLength(2);
    expect(second.hunks).toHaveLength(2);
    await app.dispatch(review(second, 0));
    expect(host.approve).not.toHaveBeenCalled();
    expect((await workspace.read("a.ts")).text).toBe("alpha\nkeep\nomega\n");
    expect((await workspace.read("b.ts")).text).toBe("red\nkeep\nblue\n");

    await app.dispatch(review(first, 1));
    expect(host.approve).toHaveBeenCalledExactlyOnceWith([
      { toolCallId: "first", allow: true },
      { toolCallId: "second", allow: true },
    ]);
    expect((await workspace.read("a.ts")).text).toBe("ALPHA\nkeep\nomega\n");
    expect((await workspace.read("b.ts")).text).toBe("red\nkeep\nBLUE\n");
    expect(results).toEqual([
      {
        proposalId: first.id,
        acceptedIds: [first.hunks[0]!.id],
        rejectedIds: [first.hunks[1]!.id],
        paths: ["a.ts"],
        invalidatedProposalIds: [],
      },
      {
        proposalId: second.id,
        acceptedIds: [second.hunks[1]!.id],
        rejectedIds: [second.hunks[0]!.id],
        paths: ["b.ts"],
        invalidatedProposalIds: [],
      },
    ]);
    expect(app.panel.state.busy).toBe(false);
  });

  it("accumulates mixed command and edit decisions without losing command rejection", async () => {
    let proposal!: Proposal;
    host.run.mockImplementation(async function* () {
      proposal = await bridge().proposals.stage(runId(), [
        { path: "a.ts", oldText: "alpha", newText: "ALPHA" },
      ]);
      yield approval("pytest", "run_command", {
        executable: "python",
        args: ["-m", "pytest", "-q"],
      });
      yield approval("apply", "request_apply", { proposalId: proposal.id });
      yield approval("compile", "run_command", {
        executable: "python",
        args: ["-m", "py_compile", "a.py"],
      });
      yield done(true);
    });
    await app.start("Check and update the project.");
    await app.dispatch({ type: "command", allow: true });
    expect(host.approve).not.toHaveBeenCalled();
    expect(app.panel.state.command?.args).toEqual(["-m", "py_compile", "a.py"]);
    await app.dispatch(review(proposal));
    expect(host.approve).not.toHaveBeenCalled();
    await app.dispatch({ type: "command", allow: false });

    expect(host.approve).toHaveBeenCalledExactlyOnceWith([
      { toolCallId: "pytest", allow: true, reason: undefined },
      { toolCallId: "apply", allow: true },
      {
        toolCallId: "compile",
        allow: false,
        reason: "User rejected command.",
      },
    ]);
    const consume = bridge().consumeCommandPermission!;
    expect(
      consume({ executable: "python", args: ["-m", "py_compile", "a.py"] }),
    ).toBe(false);
    expect(
      consume({ executable: "python", args: ["-m", "pytest", "-q"] }),
    ).toBe(true);
    expect(
      consume({ executable: "python", args: ["-m", "pytest", "-q"] }),
    ).toBe(false);
  });

  it.each(["cancelled", "error", "stream failure"] as const)(
    "revokes workspace capabilities and unapproved edits after %s",
    async (terminal) => {
      let proposal!: Proposal;
      host.run.mockImplementation(async function* () {
        proposal = await bridge().proposals.stage(runId(), [
          { path: "a.ts", oldText: "alpha", newText: "ALPHA" },
        ]);
        yield approval("command", "run_command", {
          executable: "python",
          args: ["-m", "pytest"],
        });
        yield approval("apply", "request_apply", { proposalId: proposal.id });
        yield done(true);
      });
      host.approve.mockImplementation(async function* () {
        if (terminal === "stream failure") throw new Error("Connection lost");
        if (terminal === "error")
          yield {
            type: "error",
            sessionId: "session",
            kind: "connection",
            message: "Connection lost",
            retryable: false,
          };
        else
          yield {
            type: "done",
            sessionId: "session",
            status: "cancelled",
            awaitingApproval: false,
          };
      });
      await app.start("Update after checks.");
      const signal = bridge().getSignal!();
      expect(signal?.aborted).toBe(false);
      await app.dispatch({ type: "command", allow: true });
      await app.dispatch(review(proposal));

      expect(signal?.aborted).toBe(true);
      expect(bridge().getSignal?.()?.aborted).toBe(true);
      expect(bridge().proposals.get(proposal.id)?.status).toBe("cancelled");
      expect(
        bridge().consumeCommandPermission?.({
          executable: "python",
          args: ["-m", "pytest"],
        }),
      ).toBe(false);
      await expect(bridge().proposals.apply(proposal.id)).rejects.toThrow(
        /cancel/i,
      );
      await expect(
        bridge().proposals.stage(runId(), [
          { path: "a.ts", oldText: "alpha", newText: "late edit" },
        ]),
      ).rejects.toThrow(/cancel/i);
      await expect(app.dispatch(review(proposal))).rejects.toThrow(
        /no longer active/i,
      );
      expect((await workspace.read("a.ts")).text).toBe("alpha\nkeep\nomega\n");
      expect(app.panel.state.busy).toBe(false);
      expect(app.panel.state.command).toBeUndefined();
    },
  );

  it("cancels an active stream and ignores late approval and text events", async () => {
    const streaming = deferred();
    const release = deferred();
    let proposal!: Proposal;
    host.run.mockImplementation(async function* () {
      proposal = await bridge().proposals.stage(runId(), [
        { path: "a.ts", oldText: "alpha", newText: "ALPHA" },
      ]);
      streaming.resolve();
      await release.promise;
      yield approval("late", "request_apply", { proposalId: proposal.id });
      yield {
        type: "text",
        sessionId: "session",
        messageId: "late-text",
        text: "This obsolete response must not appear",
        delta: false,
      };
      yield done(true);
    });
    const starting = app.start("Update the file.");
    await streaming.promise;
    await app.cancel();
    expect(bridge().getSignal?.()?.aborted).toBe(true);
    expect(host.cancel).toHaveBeenCalledTimes(1);
    expect(bridge().proposals.get(proposal.id)?.status).toBe("cancelled");
    release.resolve();
    await starting;
    expect(app.panel.state.text).toBe("");
    expect(app.panel.state.busy).toBe(false);
    expect(host.approve).not.toHaveBeenCalled();
    await expect(app.dispatch(review(proposal))).rejects.toThrow(
      /no longer active/i,
    );
  });

  it("blocks another task while the current task is waiting for review", async () => {
    host.run.mockImplementation(async function* () {
      yield approval("command", "run_command", {
        executable: "python",
        args: ["-m", "pytest"],
      });
      yield done(true);
    });
    await app.start("Check the project.");
    const activeSignal = bridge().getSignal?.();
    await expect(app.start("Start another task.")).rejects.toThrow(
      /already running|waiting for review/i,
    );
    expect(host.run).toHaveBeenCalledTimes(1);
    expect(bridge().getSignal?.()).toBe(activeSignal);
  });

  it("restores the idle sidebar when the user keeps unapproved proposals instead of starting a new task", async () => {
    let proposal!: Proposal;
    host.run.mockImplementation(async function* () {
      proposal = await bridge().proposals.stage(runId(), [
        { path: "a.ts", oldText: "alpha", newText: "ALPHA" },
      ]);
      yield done();
    });
    await app.start("Suggest an edit for me to review.");
    const activeSignal = bridge().getSignal?.();
    const activeRunId = runId();
    const update = vi.spyOn(app.panel, "update");

    // The sidebar sets its own busy state while it sends this request. Dismissing
    // the host's discard prompt must send the existing idle state back to it.
    await app.start("Start a different task.");

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ busy: false }),
    );
    expect(app.panel.state.busy).toBe(false);
    expect(app.panel.state.proposals).toEqual([
      expect.objectContaining({ id: proposal.id, status: "pending" }),
    ]);
    expect(bridge().proposals.get(proposal.id)?.status).toBe("pending");
    expect(bridge().getSignal?.()).toBe(activeSignal);
    expect(activeSignal?.aborted).toBe(false);
    expect(runId()).toBe(activeRunId);
    expect(host.run).toHaveBeenCalledTimes(1);
    expect(host.created).toHaveBeenCalledTimes(1);
  });

  it("blocks simultaneous initial starts before workspace boot finishes", async () => {
    const boot = deferred();
    host.bootGate = boot.promise;
    const stream = deferred();
    host.run.mockImplementation(async function* () {
      await stream.promise;
      yield done();
    });
    const first = app.start("First task.");
    const second = app.start("Second task.");
    const secondResult = second.then(
      () => undefined,
      (error: unknown) => error,
    );
    boot.resolve();
    // Let both callers leave boot; keep the first model stream active.
    await vi.waitFor(() => expect(host.run).toHaveBeenCalled());
    stream.resolve();
    await first;
    expect(await secondResult).toBeInstanceOf(Error);
    expect(host.run).toHaveBeenCalledTimes(1);
    expect(host.created).toHaveBeenCalledTimes(1);
  });

  it("uses the runtime harness URL for tasks and health checks when VS Code only supplies its default", async () => {
    const fetchHealth = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("ok"));
    vi.stubGlobal("fetch", fetchHealth);
    await app.status();
    await app.start("Read the project.");
    expect(fetchHealth).toHaveBeenCalledWith(
      "http://127.0.0.1:9876/healthz",
      expect.objectContaining({
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
    expect(host.created).toHaveBeenCalledExactlyOnceWith({
      baseUrl: "http://127.0.0.1:9876",
      agentId: "configured-agent",
      fallbackAgentId: "configured-fallback",
    });
    expect(app.panel.state.error).toBeUndefined();
  });
});
