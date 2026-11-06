import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk" with { "resolution-mode": "import" };
import type { WorkspaceAdapter, WorkspaceChange } from "../../src/contracts";
import { ProposalStore } from "../../src/edits/proposalStore";
import { startWorkspaceServer } from "../../src/mcp/server";
import { TrueForgeClient, type AgentEvent } from "../../src/trueforge/client";

type Tool = {
  type: string;
  function: { name: string; description?: string; parameters?: unknown };
};
type ChatRequest = {
  model: string;
  stream?: boolean;
  tools?: Tool[];
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
};
type Runtime = { harness: { url: string }; mcp: { token: string } };
const original = "alpha=1\nkeep-middle-line\nbeta=2\n";
const tools = [
  "read_file",
  "search_workspace",
  "retrieve_context",
  "stage_patch",
  "request_apply",
  "run_command",
];

function toolName(request: ChatRequest, name: string): string {
  const tool = request.tools?.find(
    (tool) =>
      tool.function.name === name ||
      tool.function.name.endsWith(`__${name}`) ||
      tool.function.name.endsWith(`_${name}`),
  );
  if (!tool)
    throw new Error(
      `Controlled protocol provider did not receive the ${name} schema.`,
    );
  return tool.function.name;
}

function finish(
  response: ServerResponse,
  data: { text?: string; name?: string; args?: unknown; callId?: string },
) {
  const choice = data.name
    ? {
        delta: {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: data.callId,
              type: "function",
              function: {
                name: data.name,
                arguments: JSON.stringify(data.args),
              },
            },
          ],
        },
        finish_reason: null,
      }
    : { delta: { role: "assistant", content: data.text }, finish_reason: null };
  const responseId = `chatcmpl-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (choices: unknown[], usage?: unknown) => ({
    id: responseId,
    object: "chat.completion.chunk",
    created,
    model: "controlled-protocol-fixture",
    choices,
    ...(usage ? { usage } : {}),
  });
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify(chunk([{ index: 0, ...choice }]))}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify(chunk([{ index: 0, delta: {}, finish_reason: data.name ? "tool_calls" : "stop" }]))}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify(chunk([], { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }))}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function deepObject(
  value: unknown,
  predicate: (record: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return deepObject(JSON.parse(value), predicate);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const match = deepObject(item, predicate);
      if (match) return match;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (predicate(record)) return record;
  for (const item of Object.values(record)) {
    const match = deepObject(item, predicate);
    if (match) return match;
  }
  return undefined;
}

async function collect(events: AsyncIterable<AgentEvent>) {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

async function smokeFixture(preloadAll: boolean, mode: "read" | "review") {
  let runtime: Runtime;
  try {
    const runtimeApi = await import(
      pathToFileURL(path.resolve("scripts/runtime.mjs")).href
    );
    runtime = process.env.CODEAUDITOR_RUNTIME_FILE
      ? JSON.parse(await readFile(process.env.CODEAUDITOR_RUNTIME_FILE, "utf8"))
      : await runtimeApi.loadConfig();
  } catch {
    throw new Error(
      "Harness protocol prerequisites missing: set CODEAUDITOR_DATA_DIR to an existing configured runtime.",
    );
  }
  const { TrueForge } = await import("@truefoundry/trueforge-sdk");
  const sdk = new TrueForge({
    baseUrl: runtime.harness.url,
    maxRetries: 0,
    timeoutInSeconds: 15,
  });
  const root = await mkdtemp(
    path.join(tmpdir(), "codeauditor-harness-protocol-"),
  );
  const cleanup: Array<() => Promise<unknown>> = [
    () => rm(root, { recursive: true, force: true }),
  ];
  const requests: ChatRequest[] = [];
  const providerErrors: string[] = [];
  const toolEvents: Array<{ name: string; result: unknown }> = [];
  let connectorName = "";
  let writes = 0;
  const runId = `protocol-${randomUUID()}`;
  await writeFile(path.join(root, "sample.txt"), original);
  const checkedPath = (name: string) => {
    if (name !== "sample.txt")
      throw new Error("Protocol fixture permits sample.txt only.");
    return path.join(root, name);
  };
  const read = async (name: string) => {
    const text = await readFile(checkedPath(name), "utf8");
    return {
      path: name,
      text,
      version: createHash("sha256").update(text).digest("hex"),
    };
  };
  const adapter: WorkspaceAdapter = {
    root,
    listFiles: () => readdir(root),
    read,
    apply: async (changes: WorkspaceChange[]) => {
      for (const change of changes)
        if ((await read(change.path)).version !== change.expectedVersion)
          throw new Error("Protocol fixture version conflict.");
      writes++;
      for (const change of changes)
        await writeFile(checkedPath(change.path), change.text);
    },
  };
  const proposals = new ProposalStore(adapter);
  const close = async () => {
    const errors: unknown[] = [];
    for (const operation of cleanup.reverse()) {
      try {
        await operation();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length)
      throw new Error(
        `Protocol fixture cleanup failed for ${errors.length} temporary resources.`,
      );
  };
  try {
    const bridge = await startWorkspaceServer({
      adapter,
      proposals,
      token: runtime.mcp.token,
      port: 0,
      getRunId: () => runId,
      onTool: (name, result) => toolEvents.push({ name, result }),
    });
    cleanup.push(() => bridge.close());
    const provider = createServer(async (request, response) => {
      try {
        if (request.url !== "/v1/chat/completions") {
          response.writeHead(404).end();
          return;
        }
        let raw = "";
        for await (const chunk of request) raw += chunk;
        const body: ChatRequest = JSON.parse(raw);
        requests.push(body);
        const results = body.messages.filter(
          (message) => message.role === "tool",
        );
        if (mode === "read") {
          if (!results.length)
            finish(response, {
              name: toolName(body, "read_file"),
              args: { path: "sample.txt" },
              callId: "protocol-read",
            });
          else
            finish(response, {
              text: `Controlled protocol fixture received actual workspace result: ${JSON.stringify(results.at(-1)?.content)}`,
            });
        } else {
          const staged = deepObject(
            results,
            (record) =>
              typeof record.id === "string" && Array.isArray(record.hunks),
          );
          const applied = deepObject(
            results,
            (record) =>
              typeof record.proposalId === "string" &&
              Array.isArray(record.acceptedIds),
          );
          if (applied)
            finish(response, {
              text: `Controlled protocol fixture received reviewed apply result: ${JSON.stringify(applied)}`,
            });
          else if (staged) {
            if (preloadAll)
              finish(response, {
                name: toolName(body, "request_apply"),
                args: { proposalId: staged.id },
                callId: "protocol-apply",
              });
            else if (
              !results.some(
                (message) => message.tool_call_id === "protocol-list",
              )
            )
              finish(response, {
                name: toolName(body, "list_tools"),
                args: { mcp_server: connectorName },
                callId: "protocol-list",
              });
            else if (
              !results.some(
                (message) => message.tool_call_id === "protocol-info",
              )
            )
              finish(response, {
                name: toolName(body, "get_tool_info"),
                args: { mcp_server: connectorName, tool_name: "request_apply" },
                callId: "protocol-info",
              });
            else
              finish(response, {
                name: toolName(body, "call_tool"),
                args: {
                  mcp_server: connectorName,
                  tool_name: "request_apply",
                  input: { proposalId: staged.id },
                },
                callId: "protocol-apply",
              });
          } else
            finish(response, {
              name: toolName(body, "stage_patch"),
              args: {
                changes: [
                  {
                    path: "sample.txt",
                    oldText: "alpha=1",
                    newText: "alpha=10",
                  },
                  { path: "sample.txt", oldText: "beta=2", newText: "beta=20" },
                ],
              },
              callId: "protocol-stage",
            });
        }
      } catch (error) {
        providerErrors.push(
          error instanceof Error
            ? error.message
            : "Controlled provider failed.",
        );
        if (!response.headersSent)
          response.writeHead(500, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "Controlled protocol provider failed." },
          }),
        );
      }
    });
    provider.listen(0, "127.0.0.1");
    await once(provider, "listening");
    cleanup.push(async () => {
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    });
    const address = provider.address();
    if (!address || typeof address === "string")
      throw new Error("Controlled provider did not bind a loopback port.");
    const name = `protocol-${randomUUID().slice(0, 8)}`;
    const providerName = `${name}-provider`;
    connectorName = `${name}-workspace`;
    await sdk.settings.modelProviders.create({
      manifest: {
        type: "custom",
        name: providerName,
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        models: [
          {
            name: "fixture",
            modelId: "controlled-protocol-fixture",
            properties: { contextLength: 4096, maxOutputTokens: 1024 },
          },
        ],
      },
    });
    cleanup.push(() => sdk.settings.modelProviders.delete(providerName));
    await sdk.settings.mcpServers.create({
      manifest: {
        type: "remote",
        name: connectorName,
        description: "Temporary controlled protocol fixture workspace.",
        url: bridge.url,
        auth: {
          type: "header",
          headers: { Authorization: `Bearer ${runtime.mcp.token}` },
        },
      },
    });
    cleanup.push(() => sdk.settings.mcpServers.delete(connectorName));
    const manifest: TrueForgeApi.AgentSpec = {
      model: {
        name: `${providerName}/fixture`,
        params: { maxTokens: 1024, temperature: 0, parallelToolCalls: false },
      },
      instructions:
        "This is an explicitly controlled protocol fixture. Use workspace tools and respect tool approval. Do not infer real model capability from this run.",
      mcpServers: [
        {
          name: connectorName,
          enableTools: tools,
          preloadTools: preloadAll ? tools : tools.slice(0, 4),
          requireApprovalForTools: ["request_apply", "run_command"],
        },
      ],
      config: {
        iterationLimit: 8,
        sandbox: { enabled: false },
        webSearch: { enabled: false },
        memory: { enabled: false },
        contextManagement: {
          compaction: { enabled: false },
          largeToolResponse: { enabled: false },
        },
      },
    };
    const { data: agent } = await sdk.agents.create({
      name,
      description:
        "Temporary controlled protocol fixture; not model intelligence.",
      manifest,
    });
    cleanup.push(() => sdk.agents.delete(agent.id));
    const client = new TrueForgeClient({
      baseUrl: runtime.harness.url,
      agentId: name,
      timeoutMs: 20_000,
      cancellationTimeoutMs: 2_000,
    });
    cleanup.push(async () => {
      if (client.sessionId) await sdk.sessions.delete(client.sessionId);
    });
    return {
      root,
      adapter,
      proposals,
      client,
      sdk,
      requests,
      providerErrors,
      toolEvents,
      runId,
      writes: () => writes,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

// These tests use an actual harness and MCP transport but a scripted provider, so they prove protocol wiring only.
describe.runIf(process.env.CODEAUDITOR_HARNESS_SMOKE === "1")(
  "actual TrueForge harness with controlled protocol provider",
  () => {
    it("streams an actual MCP read result back through the provider with selected schemas preloaded", async () => {
      const fixture = await smokeFixture(false, "read");
      try {
        const events = await collect(
          fixture.client.run("Protocol fixture: read sample.txt."),
        );
        expect(fixture.providerErrors).toEqual([]);
        expect(events.filter((event) => event.type === "error")).toEqual([]);
        expect(fixture.toolEvents).toContainEqual(
          expect.objectContaining({
            name: "read_file",
            result: expect.objectContaining({
              path: "sample.txt",
              text: original,
            }),
          }),
        );
        expect(fixture.requests.length).toBeGreaterThanOrEqual(2);
        expect(JSON.stringify(fixture.requests.at(-1)?.messages)).toContain(
          "keep-middle-line",
        );
        expect(
          events.some(
            (event) =>
              event.type === "text" &&
              event.delta &&
              event.text.includes("keep-middle-line"),
          ),
        ).toBe(true);
        expect(events.at(-1)).toMatchObject({
          type: "done",
          status: "done",
          awaitingApproval: false,
        });
        expect(
          fixture.requests[0].tools?.some((tool) =>
            /read_file$/.test(tool.function.name),
          ),
        ).toBe(true);
        expect(
          fixture.requests[0].tools?.some((tool) =>
            /request_apply$|run_command$/.test(tool.function.name),
          ),
        ).toBe(false);
        expect(fixture.writes()).toBe(0);
        expect(
          await readFile(path.join(fixture.root, "sample.txt"), "utf8"),
        ).toBe(original);
      } finally {
        await fixture.close();
      }
    });

    it.each([
      { preloadAll: true, label: "eager schemas" },
      { preloadAll: false, label: "deferred discovery" },
    ])(
      "pauses actual request_apply with $label until host review, then applies only the accepted hunk and supports undo",
      async ({ preloadAll }) => {
        const fixture = await smokeFixture(preloadAll, "review");
        try {
          const initial = await collect(
            fixture.client.run(
              "Protocol fixture: stage two sample.txt hunks and request review.",
            ),
          );
          expect(fixture.providerErrors).toEqual([]);
          expect(initial.filter((event) => event.type === "error")).toEqual([]);
          const approvals = initial.filter(
            (event) => event.type === "approval",
          );
          expect(approvals).toHaveLength(1);
          expect(approvals[0].toolName).toBe("request_apply");
          expect(initial.at(-1)).toMatchObject({
            type: "done",
            awaitingApproval: true,
          });
          expect(fixture.writes()).toBe(0);
          expect(
            await readFile(path.join(fixture.root, "sample.txt"), "utf8"),
          ).toBe(original);
          expect(fixture.toolEvents.map((event) => event.name)).toEqual([
            "stage_patch",
          ]);
          const proposal = fixture.proposals.list(fixture.runId)[0];
          expect(proposal.hunks).toHaveLength(2);
          expect(approvals[0].args).toEqual({ proposalId: proposal.id });
          fixture.proposals.review(proposal.id, {
            [proposal.hunks[0].id]: "accept",
            [proposal.hunks[1].id]: "reject",
          });
          const resumed = await collect(
            fixture.client.approve([
              { toolCallId: approvals[0].toolCallId, allow: true },
            ]),
          );
          expect(fixture.providerErrors).toEqual([]);
          expect(resumed.filter((event) => event.type === "error")).toEqual([]);
          expect(resumed.at(-1)).toMatchObject({
            type: "done",
            status: "done",
            awaitingApproval: false,
          });
          expect(fixture.toolEvents.map((event) => event.name)).toEqual([
            "stage_patch",
            "request_apply",
          ]);
          expect(fixture.writes()).toBe(1);
          expect(
            await readFile(path.join(fixture.root, "sample.txt"), "utf8"),
          ).toBe("alpha=10\nkeep-middle-line\nbeta=2\n");
          expect(JSON.stringify(fixture.requests.at(-1)?.messages)).toContain(
            proposal.hunks[1].id,
          );
          await fixture.proposals.undoLast();
          expect(
            await readFile(path.join(fixture.root, "sample.txt"), "utf8"),
          ).toBe(original);
        } finally {
          await fixture.close();
        }
      },
    );

    it("reduces actual initial schema payload with selective preloading while deferred tools remain discoverable", async () => {
      const selective = await smokeFixture(false, "read");
      let eager: Awaited<ReturnType<typeof smokeFixture>> | undefined;
      try {
        eager = await smokeFixture(true, "read");
        const selectedEvents = await collect(
          selective.client.run("Read sample.txt."),
        );
        const eagerEvents = await collect(eager.client.run("Read sample.txt."));
        expect(selectedEvents.at(-1)).toMatchObject({
          type: "done",
          status: "done",
        });
        expect(eagerEvents.at(-1)).toMatchObject({
          type: "done",
          status: "done",
        });
        const selectedTools = selective.requests[0].tools ?? [];
        const eagerTools = eager.requests[0].tools ?? [];
        expect(
          selectedTools.some((tool) =>
            /request_apply$|run_command$/.test(tool.function.name),
          ),
        ).toBe(false);
        expect(
          eagerTools.some((tool) => /request_apply$/.test(tool.function.name)),
        ).toBe(true);
        expect(
          selectedTools.some((tool) => /list_tools$/.test(tool.function.name)),
        ).toBe(true);
        const selectedBytes = Buffer.byteLength(JSON.stringify(selectedTools));
        const eagerBytes = Buffer.byteLength(JSON.stringify(eagerTools));
        expect(selectedBytes).toBeLessThan(eagerBytes);
        console.info(
          `Controlled protocol fixture schema payload: selective ${selectedBytes} bytes; eager ${eagerBytes} bytes. These are JSON bytes, not tokenizer counts.`,
        );
      } finally {
        await Promise.all([selective.close(), eager?.close()]);
      }
    });
  },
);
