import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { TrueForgeClient, type AgentEvent } from "../../src/trueforge/client";

const timestamp = "2026-11-07T00:00:00Z";
type Request = {
  method: string;
  path: string;
  body: Record<string, unknown>;
  authorization?: string;
};
type Handler = (request: Request, response: ServerResponse) => void;
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function endpoint(handler: Handler) {
  const requests: Request[] = [];
  const server = createServer(async (request: IncomingMessage, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const parsed: Request = {
      method: request.method ?? "GET",
      path: request.url ?? "/",
      body: raw ? JSON.parse(raw) : {},
      authorization: request.headers.authorization,
    };
    requests.push(parsed);
    handler(parsed, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No loopback port");
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}
function json(response: ServerResponse, data: unknown, status = 200) {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(data));
}
function session(response: ServerResponse, id = "session-1") {
  json(response, {
    data: {
      id,
      agent: { type: "reference", id: "agent-id", name: "primary" },
      created_at: timestamp,
      updated_at: timestamp,
      created_by_subject: {
        subject_display_name: "Local",
        subject_id: "local",
        subject_type: "user",
      },
      last_turn_details: null,
      metadata: {},
      metrics: { total_duration_ms: 0, total_turns: 0 },
      shared: false,
      source: null,
      title: null,
    },
  });
}
function created(id = "turn-1") {
  return {
    type: "turn.created",
    id: `created-${id}`,
    turn_id: id,
    thread_id: null,
    previous_turn_id: null,
    state: { status: "running" },
    created_at: timestamp,
  };
}
function message(id: string, content: string, toolCalls: unknown[] = []) {
  return {
    type: "model.message",
    id,
    thread_id: "main",
    created_at: timestamp,
    content,
    tool_calls: toolCalls,
  };
}
function call(args = '{"proposalId":"proposal-1"}') {
  return {
    id: "call-1",
    type: "function",
    function: { name: "request_apply", arguments: args },
    tool_info: {
      type: "mcp",
      name: "request_apply",
      server_id: "workspace",
      server_name: "workspace",
    },
  };
}
function done(
  state: Record<string, unknown> = {
    status: "done",
    output: null,
    required_actions: [],
  },
) {
  return {
    type: "turn.done",
    id: "done-1",
    thread_id: null,
    created_at: timestamp,
    state: { completed_at: timestamp, ...state },
  };
}
function writeEvent(
  response: ServerResponse,
  event: unknown,
  id: string | number,
) {
  response.write(`id: ${id}\ndata: ${JSON.stringify(event)}\n\n`);
}
function sse(response: ServerResponse, events: unknown[]) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  events.forEach((event, index) => writeEvent(response, event, index + 1));
  response.end();
}
async function collect(source: AsyncIterable<AgentEvent>) {
  const result: AgentEvent[] = [];
  for await (const event of source) result.push(event);
  return result;
}

describe("TrueForge SDK against a controlled loopback HTTP contract server (not live inference)", () => {
  it("creates a named session, merges streaming messages, and exposes a genuine SDK tool response", async () => {
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      sse(response, [
        created(),
        message("model-1", ""),
        {
          type: "model.message.delta",
          id: "model-1",
          thread_id: "main",
          content: "Hello ",
        },
        {
          type: "model.message.delta",
          id: "model-1",
          thread_id: "main",
          content: "world",
        },
        message("model-2", "", [call()]),
        {
          type: "tool.response",
          id: "tool-1",
          thread_id: "main",
          created_at: timestamp,
          tool_call_id: "call-1",
          content: '{"text":"read data"}',
        },
        done(),
      ]);
    });
    const client = new TrueForgeClient({
      baseUrl: api.baseUrl,
      agentId: "local-qwen",
      apiKey: "test-token",
    });
    const events = await collect(client.run("Inspect the project"));
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("Hello world");
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool",
        toolName: "request_apply",
        status: "done",
        result: '{"text":"read data"}',
      }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "done",
      status: "done",
      awaitingApproval: false,
    });
    expect(api.requests.map((request) => [request.path, request.body])).toEqual(
      [
        ["/api/v1/sessions", { agent: { name: "local-qwen" } }],
        [
          "/api/v1/sessions/session-1/turns",
          {
            input: [{ type: "user.message", content: "Inspect the project" }],
            stream: true,
          },
        ],
      ],
    );
    expect(api.requests[0].authorization).toBe("Bearer test-token");
  });

  it("resolves approval references and resumes the same session with explicit decisions", async () => {
    let turns = 0;
    const approval = {
      type: "tool.approval_required",
      id: "approval-1",
      thread_id: "main",
      created_at: timestamp,
      tool_calls: [{ id: "call-1", source_event_id: "model-1" }],
    };
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      turns++;
      sse(
        response,
        turns === 1
          ? [
              created(),
              message("model-1", "", [call()]),
              approval,
              done({
                status: "done",
                output: null,
                required_actions: [approval],
              }),
            ]
          : [created("turn-2"), message("reply", "Reviewed"), done()],
      );
    });
    const client = new TrueForgeClient({
      baseUrl: api.baseUrl,
      agentId: "primary",
    });
    const events = await collect(client.run("Edit carefully"));
    expect(events.filter((event) => event.type === "approval")).toEqual([
      expect.objectContaining({
        toolCallId: "call-1",
        toolName: "request_apply",
        args: { proposalId: "proposal-1" },
        threadId: "main",
        sourceEventId: "model-1",
        eventId: "approval-1",
      }),
    ]);
    expect(events.at(-1)).toMatchObject({ awaitingApproval: true });
    const resumed = await collect(
      client.approve([
        { toolCallId: "call-1", allow: false, reason: "Rejected hunk" },
      ]),
    );
    expect(resumed.at(-1)).toMatchObject({ type: "done", status: "done" });
    expect(api.requests.at(-1)?.body).toEqual({
      input: [
        {
          type: "user.tool_approval",
          thread_id: "main",
          tool_call_id: "call-1",
          approval: { status: "deny", reason: "Rejected hunk" },
        },
      ],
      stream: true,
    });
    expect(
      api.requests.filter((request) => request.path === "/api/v1/sessions"),
    ).toHaveLength(1);
  });

  it("unwraps SDK deferred call_tool approvals and activity while retaining the original API references", async () => {
    let turns = 0;
    const deferred = {
      id: "deferred-call",
      type: "function",
      function: {
        name: "call_tool",
        arguments:
          '{"mcp_server":"workspace","tool_name":"request_apply","input":{"proposalId":"proposal-1"}}',
      },
      tool_info: { type: "truefoundry-system", name: "call_tool" },
    };
    const approval = {
      type: "tool.approval_required",
      id: "approval-deferred",
      thread_id: "main",
      created_at: timestamp,
      tool_calls: [{ id: "deferred-call", source_event_id: "model-deferred" }],
    };
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      turns++;
      sse(
        response,
        turns === 1
          ? [
              created(),
              message("model-deferred", "", [deferred]),
              approval,
              done({
                status: "done",
                output: null,
                required_actions: [approval],
              }),
            ]
          : [created("turn-2"), done()],
      );
    });
    const client = new TrueForgeClient({
      baseUrl: api.baseUrl,
      agentId: "primary",
    });
    const events = await collect(client.run("Edit"));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool",
        toolCallId: "deferred-call",
        toolName: "request_apply",
        args: { proposalId: "proposal-1" },
        status: "running",
      }),
    );
    expect(events.filter((event) => event.type === "approval")).toEqual([
      expect.objectContaining({
        toolCallId: "deferred-call",
        toolName: "request_apply",
        args: { proposalId: "proposal-1" },
        threadId: "main",
        sourceEventId: "model-deferred",
        eventId: "approval-deferred",
      }),
    ]);
    await collect(
      client.approve([{ toolCallId: "deferred-call", allow: true }]),
    );
    expect(api.requests.at(-1)?.body).toEqual({
      input: [
        {
          type: "user.tool_approval",
          tool_call_id: "deferred-call",
          thread_id: "main",
          approval: { status: "allow" },
        },
      ],
      stream: true,
    });
  });

  it.each([
    { mcp_server: "workspace", tool_name: "request_apply" },
    { mcp_server: "", tool_name: "request_apply", input: {} },
    { mcp_server: 1, tool_name: "request_apply", input: {} },
    { mcp_server: "workspace", tool_name: null, input: {} },
    { mcp_server: "workspace", tool_name: "", input: {} },
    { mcp_server: "workspace", tool_name: "request_apply", input: null },
    { mcp_server: "workspace", tool_name: "request_apply", input: [] },
    {
      mcp_server: "workspace",
      tool_name: "request_apply",
      input: "not-an-object",
    },
  ])(
    "rejects malformed deferred tool envelope %j without issuing approval",
    async (args) => {
      const deferred = {
        id: "deferred-call",
        type: "function",
        function: { name: "call_tool", arguments: JSON.stringify(args) },
        tool_info: { type: "truefoundry-system", name: "call_tool" },
      };
      const approval = {
        type: "tool.approval_required",
        id: "approval-deferred",
        thread_id: "main",
        created_at: timestamp,
        tool_calls: [
          { id: "deferred-call", source_event_id: "model-deferred" },
        ],
      };
      const api = await endpoint((request, response) => {
        if (request.path === "/api/v1/sessions") return session(response);
        if (request.path.endsWith("/cancel")) return json(response, {});
        if (request.method === "GET")
          return json(response, {
            data: {
              id: "turn-1",
              created_at: timestamp,
              session_id: "session-1",
              previous_turn_id: null,
              state: {
                status: "cancelled",
                completed_at: timestamp,
                reason: "client-cancelled",
              },
            },
          });
        sse(response, [
          created(),
          message("model-deferred", "", [deferred]),
          approval,
          done({ status: "done", output: null, required_actions: [approval] }),
        ]);
      });
      const events = await collect(
        new TrueForgeClient({ baseUrl: api.baseUrl, agentId: "primary" }).run(
          "Edit",
        ),
      );
      expect(events.filter((event) => event.type === "approval")).toHaveLength(
        0,
      );
      expect(events.at(-1)).toMatchObject({ type: "error", kind: "protocol" });
    },
  );

  it("does not reinterpret an ordinary MCP tool named call_tool as the harness deferred wrapper", async () => {
    const ordinary = {
      id: "ordinary-call",
      type: "function",
      function: {
        name: "call_tool",
        arguments:
          '{"mcp_server":"other","tool_name":"request_apply","input":{"proposalId":"proposal-1"}}',
      },
      tool_info: {
        type: "mcp",
        name: "call_tool",
        server_id: "workspace",
        server_name: "workspace",
      },
    };
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      sse(response, [created(), message("ordinary", "", [ordinary]), done()]);
    });
    const events = await collect(
      new TrueForgeClient({ baseUrl: api.baseUrl, agentId: "primary" }).run(
        "Inspect",
      ),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool",
        toolName: "call_tool",
        args: {
          mcp_server: "other",
          tool_name: "request_apply",
          input: { proposalId: "proposal-1" },
        },
      }),
    );
  });

  it("does not contact TrueForge or fall back after a pre-aborted signal", async () => {
    const api = await endpoint((_request, response) => session(response));
    const controller = new AbortController();
    controller.abort();
    const events = await collect(
      new TrueForgeClient({
        baseUrl: api.baseUrl,
        agentId: "primary",
        fallbackAgentId: "backup",
      }).run("Stop", { signal: controller.signal }),
    );
    expect(events.at(-1)).toMatchObject({ type: "done", status: "cancelled" });
    expect(api.requests).toHaveLength(0);
  });

  it("cancels the SDK session promptly while awaiting the model and ignores late events", async () => {
    const controller = new AbortController();
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      if (request.path.endsWith("/cancel")) return json(response, {});
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      writeEvent(response, created(), 1);
    });
    const client = new TrueForgeClient({
      baseUrl: api.baseUrl,
      agentId: "primary",
      fallbackAgentId: "backup",
    });
    const events: AgentEvent[] = [];
    const started = Date.now();
    for await (const event of client.run("Wait", {
      signal: controller.signal,
    })) {
      events.push(event);
      if (event.type === "status" && event.state === "running" && event.turnId)
        controller.abort();
    }
    expect(Date.now() - started).toBeLessThan(1000);
    expect(events.at(-1)).toMatchObject({ type: "done", status: "cancelled" });
    await client.cancel();
    expect(
      api.requests.some((request) => request.path.endsWith("/cancel")),
    ).toBe(true);
    expect(
      api.requests.filter((request) => request.path === "/api/v1/sessions"),
    ).toHaveLength(1);
    expect(events.filter((event) => event.type === "text")).toHaveLength(0);
  });

  it("starts a distinct configured fallback session only after a terminal primary error", async () => {
    let sessions = 0;
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions")
        return session(response, `session-${++sessions}`);
      sse(
        response,
        request.path.includes("session-1")
          ? [created(), done({ status: "error", message: "model unavailable" })]
          : [created("turn-2"), message("backup", "Recovered"), done()],
      );
    });
    const events = await collect(
      new TrueForgeClient({
        baseUrl: api.baseUrl,
        agentId: "primary",
        fallbackAgentId: "backup",
      }).run("Inspect only"),
    );
    expect(
      api.requests
        .filter((request) => request.path === "/api/v1/sessions")
        .map((request) => request.body),
    ).toEqual([{ agent: { name: "primary" } }, { agent: { name: "backup" } }]);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "status", state: "retrying" }),
    );
    expect(events.at(-1)).toMatchObject({
      type: "done",
      status: "done",
      sessionId: "session-2",
    });
  });

  it("cancels an interrupted primary and proves terminal state before fallback", async () => {
    let sessions = 0;
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions")
        return session(response, `session-${++sessions}`);
      if (request.path.endsWith("/cancel")) return json(response, {});
      if (request.method === "GET")
        return json(response, {
          data: {
            id: "turn-1",
            created_at: timestamp,
            session_id: "session-1",
            previous_turn_id: null,
            state: {
              status: "cancelled",
              completed_at: timestamp,
              reason: "user_cancelled",
            },
          },
        });
      sse(
        response,
        request.path.includes("session-1")
          ? [created(), message("primary", "partial")]
          : [created("turn-2"), done()],
      );
    });
    const events = await collect(
      new TrueForgeClient({
        baseUrl: api.baseUrl,
        agentId: "primary",
        fallbackAgentId: "backup",
      }).run("Inspect only"),
    );
    const paths = api.requests.map(
      (request) => `${request.method} ${request.path}`,
    );
    expect(
      paths.indexOf("POST /api/v1/sessions/session-1/cancel"),
    ).toBeLessThan(paths.lastIndexOf("POST /api/v1/sessions"));
    expect(
      paths.indexOf("GET /api/v1/sessions/session-1/turns/turn-1"),
    ).toBeLessThan(paths.lastIndexOf("POST /api/v1/sessions"));
    expect(events.at(-1)).toMatchObject({ type: "done", status: "done" });
  });

  it("reports terminal failure without credentials or stack traces when both agents fail", async () => {
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      sse(response, [
        created(),
        done({
          status: "error",
          message:
            "Authorization Bearer secret-key\n at privateStack(file.js:1) invalid api key",
        }),
      ]);
    });
    const events = await collect(
      new TrueForgeClient({
        baseUrl: api.baseUrl,
        agentId: "primary",
        fallbackAgentId: "backup",
        apiKey: "secret-key",
      }).run("Inspect"),
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      kind: "authentication",
    });
    expect(JSON.stringify(events)).not.toMatch(
      /secret-key|privateStack|file\.js/,
    );
    expect(
      api.requests.filter((request) => request.path === "/api/v1/sessions"),
    ).toHaveLength(2);
  });

  it("rejects malformed tool arguments and never exposes an approvable mutation", async () => {
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      sse(response, [
        created(),
        message("model-1", "", [call("{invalid")]),
        done(),
      ]);
    });
    const events = await collect(
      new TrueForgeClient({ baseUrl: api.baseUrl, agentId: "primary" }).run(
        "Inspect",
      ),
    );
    expect(events.filter((event) => event.type === "approval")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "error", kind: "protocol" });
  });

  it("stops a stalled stream within its deadline and refuses fallback while primary termination is unconfirmed", async () => {
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      if (request.path.endsWith("/cancel")) return json(response, {});
      if (request.method === "GET")
        return json(response, {
          data: {
            id: "turn-1",
            created_at: timestamp,
            session_id: "session-1",
            previous_turn_id: null,
            state: { status: "running" },
          },
        });
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      writeEvent(response, created(), 1);
    });
    const events = await collect(
      new TrueForgeClient({
        baseUrl: api.baseUrl,
        agentId: "primary",
        fallbackAgentId: "backup",
        timeoutMs: 80,
        cancellationTimeoutMs: 100,
      }).run("Inspect"),
    );
    expect(events.at(-1)).toMatchObject({
      type: "error",
      kind: "protocol",
      message: expect.stringMatching(/cancellation could not be confirmed/i),
    });
    expect(
      api.requests.filter((request) => request.path === "/api/v1/sessions"),
    ).toHaveLength(1);
  });

  it("keeps cancellation set when an approval signal aborts after its turn pauses", async () => {
    const approval = {
      type: "tool.approval_required",
      id: "approval-1",
      thread_id: "main",
      created_at: timestamp,
      tool_calls: [{ id: "call-1", source_event_id: "model-1" }],
    };
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      if (request.path.endsWith("/cancel")) return json(response, {});
      sse(response, [
        created(),
        message("model-1", "", [call()]),
        approval,
        done({ status: "done", output: null, required_actions: [approval] }),
      ]);
    });
    const signal = new AbortController();
    const client = new TrueForgeClient({
      baseUrl: api.baseUrl,
      agentId: "primary",
    });
    await collect(client.run("Edit", { signal: signal.signal }));
    signal.abort();
    await client.cancel();
    const events = await collect(
      client.approve([{ toolCallId: "call-1", allow: true }]),
    );
    expect(events.at(-1)).toMatchObject({ type: "done", status: "cancelled" });
    expect(
      api.requests.filter((request) => request.path.endsWith("/turns")),
    ).toHaveLength(1);
    expect(
      api.requests.some((request) => request.path.endsWith("/cancel")),
    ).toBe(true);
  });

  it("rejects unknown approval decisions without sending another turn", async () => {
    const api = await endpoint((_request, response) => session(response));
    const client = new TrueForgeClient({
      baseUrl: api.baseUrl,
      agentId: "primary",
    });
    expect(
      (
        await collect(client.approve([{ toolCallId: "forged", allow: true }]))
      ).at(-1),
    ).toMatchObject({ type: "error", kind: "protocol" });
    expect(api.requests).toHaveLength(0);
  });

  it("never retries tool activity or replays approved mutations into a fallback session", async () => {
    let turns = 0;
    const approval = {
      type: "tool.approval_required",
      id: "approval-1",
      thread_id: "main",
      created_at: timestamp,
      tool_calls: [{ id: "call-1", source_event_id: "model-1" }],
    };
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      turns++;
      sse(
        response,
        turns === 1
          ? [
              created(),
              message("model-1", "", [call()]),
              approval,
              done({
                status: "done",
                output: null,
                required_actions: [approval],
              }),
            ]
          : [
              created("turn-2"),
              done({ status: "error", message: "model unavailable" }),
            ],
      );
    });
    const client = new TrueForgeClient({
      baseUrl: api.baseUrl,
      agentId: "primary",
      fallbackAgentId: "backup",
    });
    await collect(client.run("Edit"));
    const events = await collect(
      client.approve([{ toolCallId: "call-1", allow: true }]),
    );
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(
      api.requests.filter((request) => request.path === "/api/v1/sessions"),
    ).toHaveLength(1);
    expect(
      api.requests.filter((request) => request.path.endsWith("/turns")),
    ).toHaveLength(2);
  });

  it("deduplicates SSE sequence numbers while preserving equal distinct deltas", async () => {
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      writeEvent(response, created(), 1);
      writeEvent(response, message("model-1", ""), 2);
      const delta = {
        type: "model.message.delta",
        id: "model-1",
        thread_id: "main",
        content: "ha",
      };
      writeEvent(response, delta, 3);
      writeEvent(response, delta, 3);
      writeEvent(response, delta, 4);
      writeEvent(response, done(), 5);
      response.end();
    });
    const events = await collect(
      new TrueForgeClient({ baseUrl: api.baseUrl, agentId: "primary" }).run(
        "Inspect",
      ),
    );
    expect(
      events
        .filter((event) => event.type === "text")
        .map((event) => event.text)
        .join(""),
    ).toBe("haha");
  });

  it("assembles SDK tool-call argument fragments before emitting the approval", async () => {
    const approval = {
      type: "tool.approval_required",
      id: "approval-1",
      thread_id: "main",
      created_at: timestamp,
      tool_calls: [{ id: "call-1", source_event_id: "model-1" }],
    };
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      sse(response, [
        created(),
        message("model-1", ""),
        {
          type: "model.message.delta",
          id: "model-1",
          thread_id: "main",
          tool_calls: [{ ...call('{"proposalId":'), index: 0 }],
        },
        {
          type: "model.message.delta",
          id: "model-1",
          thread_id: "main",
          tool_calls: [{ index: 0, function: { arguments: '"proposal-1"}' } }],
          finish_reason: "tool_calls",
        },
        approval,
        done({ status: "done", output: null, required_actions: [approval] }),
      ]);
    });
    const events = await collect(
      new TrueForgeClient({ baseUrl: api.baseUrl, agentId: "primary" }).run(
        "Edit",
      ),
    );
    expect(events.filter((event) => event.type === "approval")).toEqual([
      expect.objectContaining({
        toolName: "request_apply",
        args: { proposalId: "proposal-1" },
      }),
    ]);
  });

  it("keeps server cancellation terminal and never resumes a pending approval", async () => {
    const approval = {
      type: "tool.approval_required",
      id: "approval-1",
      thread_id: "main",
      created_at: timestamp,
      tool_calls: [{ id: "call-1", source_event_id: "model-1" }],
    };
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      sse(response, [
        created(),
        message("model-1", "", [call()]),
        approval,
        done({ status: "cancelled", reason: "client-cancelled" }),
      ]);
    });
    const client = new TrueForgeClient({
      baseUrl: api.baseUrl,
      agentId: "primary",
    });
    await collect(client.run("Edit"));
    const events = await collect(
      client.approve([{ toolCallId: "call-1", allow: true }]),
    );
    expect(events.at(-1)).toMatchObject({ type: "done", status: "cancelled" });
    expect(
      api.requests.filter((request) => request.path.endsWith("/turns")),
    ).toHaveLength(1);
  });

  it("does not follow TrueForge redirects away from the configured loopback endpoint", async () => {
    const destination = await endpoint((_request, response) =>
      session(response),
    );
    const source = await endpoint((_request, response) => {
      response.writeHead(302, {
        Location: `${destination.baseUrl}/api/v1/sessions`,
      });
      response.end();
    });
    const events = await collect(
      new TrueForgeClient({
        baseUrl: source.baseUrl,
        agentId: "primary",
        apiKey: "test-token",
      }).run("Inspect"),
    );
    expect(events.at(-1)).toMatchObject({ type: "error" });
    expect(destination.requests).toHaveLength(0);
  });

  it("reports rejected turn authentication and can switch agent without polling a nonexistent turn", async () => {
    let sessions = 0;
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions")
        return session(response, `session-${++sessions}`);
      if (request.path.includes("session-1"))
        return json(
          response,
          {
            error: {
              message: "invalid api key secret-key",
              type: "authentication",
            },
          },
          401,
        );
      return sse(response, [created(), done()]);
    });
    const events = await collect(
      new TrueForgeClient({
        baseUrl: api.baseUrl,
        agentId: "primary",
        fallbackAgentId: "backup",
        apiKey: "secret-key",
      }).run("Inspect"),
    );
    expect(events.at(-1)).toMatchObject({
      type: "done",
      status: "done",
      sessionId: "session-2",
    });
    expect(
      api.requests.some(
        (request) =>
          request.method === "GET" || request.path.endsWith("/cancel"),
      ),
    ).toBe(false);
    expect(JSON.stringify(events)).not.toContain("secret-key");
  });

  it("does not start fallback if cancellation arrives with the retry status", async () => {
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      sse(response, [
        created(),
        done({ status: "error", message: "model unavailable" }),
      ]);
    });
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const event of new TrueForgeClient({
      baseUrl: api.baseUrl,
      agentId: "primary",
      fallbackAgentId: "backup",
    }).run("Inspect", { signal: controller.signal })) {
      events.push(event);
      if (event.type === "status" && event.state === "retrying")
        controller.abort();
    }
    expect(events.at(-1)).toMatchObject({ type: "done", status: "cancelled" });
    expect(
      api.requests.filter((request) => request.path === "/api/v1/sessions"),
    ).toHaveLength(1);
  });

  it("distinguishes tool-result errors from model errors without starting fallback", async () => {
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      sse(response, [
        created(),
        message("model-1", "", [call()]),
        {
          type: "tool.response",
          id: "result",
          thread_id: "main",
          tool_call_id: "call-1",
          created_at: timestamp,
          content:
            '{"isError":true,"content":[{"type":"text","text":"stale proposal"}]}',
        },
        done(),
      ]);
    });
    const events = await collect(
      new TrueForgeClient({
        baseUrl: api.baseUrl,
        agentId: "primary",
        fallbackAgentId: "backup",
      }).run("Edit"),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool",
        status: "failed",
        toolCallId: "call-1",
      }),
    );
    expect(
      api.requests.filter((request) => request.path === "/api/v1/sessions"),
    ).toHaveLength(1);
  });

  it("treats invalid terminal payloads as protocol errors", async () => {
    const api = await endpoint((request, response) => {
      if (request.path === "/api/v1/sessions") return session(response);
      if (request.path.endsWith("/cancel")) return json(response, {});
      if (request.method === "GET")
        return json(response, {
          data: {
            id: "turn-1",
            created_at: timestamp,
            session_id: "session-1",
            previous_turn_id: null,
            state: {
              status: "cancelled",
              completed_at: timestamp,
              reason: "client-cancelled",
            },
          },
        });
      sse(response, [created(), done({ status: "mystery" })]);
    });
    const events = await collect(
      new TrueForgeClient({ baseUrl: api.baseUrl, agentId: "primary" }).run(
        "Inspect",
      ),
    );
    expect(events.at(-1)).toMatchObject({ type: "error", kind: "protocol" });
  });

  it.each([
    "https://example.com",
    "http://127.0.0.1.example.com",
    "http://user:password@127.0.0.1",
    "file:///tmp/runtime",
    "http://127.0.0.1?token=secret",
  ])("rejects unsafe TrueForge URL %s", (baseUrl) => {
    expect(() => new TrueForgeClient({ baseUrl, agentId: "primary" })).toThrow(
      /loopback|credentials|query/i,
    );
  });
});
