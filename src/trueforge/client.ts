import type {
  TrueForge,
  TrueForgeApi,
  mergeEventDelta,
} from "@truefoundry/trueforge-sdk" with { "resolution-mode": "import" };

export type FailureKind =
  | "connection"
  | "authentication"
  | "rate-limit"
  | "timeout"
  | "protocol"
  | "tool"
  | "unknown";
type EventContext = { sessionId: string; turnId?: string; eventId?: string };
export type AgentEvent = EventContext &
  (
    | { type: "session"; agentId: string }
    | { type: "text"; messageId: string; text: string; delta: boolean }
    | {
        type: "tool";
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        status: "running" | "done" | "failed";
        result?: string;
      }
    | {
        type: "approval";
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        threadId: string;
        sourceEventId: string;
      }
    | {
        type: "status";
        state: "running" | "awaiting-review" | "cancelled" | "retrying";
        message: string;
      }
    | { type: "done"; status: "done" | "cancelled"; awaitingApproval: boolean }
    | { type: "error"; kind: FailureKind; message: string; retryable: boolean }
  );

export interface TrueForgeConfig {
  baseUrl: string;
  /** SDK registry name, as accepted by sessions.create({ agent: { name } }). */
  agentId: string;
  fallbackAgentId?: string;
  apiKey?: string;
  timeoutMs?: number;
  cancellationTimeoutMs?: number;
}
export type ApprovalDecision = {
  toolCallId: string;
  allow: boolean;
  reason?: string;
};
type PendingApproval = Extract<AgentEvent, { type: "approval" }>;
type ActiveTurn = {
  controller: AbortController;
  cancelled: boolean;
  sessionId?: string;
  turnId?: string;
  terminal: boolean;
  startedTurn: boolean;
  sawTools: boolean;
  externalSignal?: AbortSignal;
  removeListener?: () => void;
  cancelRequest?: Promise<void>;
};

class RunFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** Loopback only; never include URL credentials or query tokens in diagnostics. */
export function validateTrueForgeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TrueForge requires an HTTP loopback URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("TrueForge requires an HTTP loopback URL.");
  }
  if (url.username || url.password)
    throw new Error("TrueForge URL credentials are not allowed.");
  if (url.search || url.hash)
    throw new Error(
      "TrueForge URL query parameters and fragments are not allowed.",
    );
  return url.toString().replace(/\/$/, "");
}

function classifyFailure(error: unknown): RunFailure {
  if (error instanceof RunFailure) return error;
  const status =
    typeof error === "object" && error !== null && "statusCode" in error
      ? Number(error.statusCode)
      : undefined;
  const text = error instanceof Error ? error.message : String(error);
  if (
    error instanceof Error &&
    ["ParseError", "SyntaxError"].includes(error.name)
  )
    return new RunFailure(
      "protocol",
      "TrueForge returned a malformed stream payload.",
    );
  if (
    status === 401 ||
    status === 403 ||
    /unauthori[sz]ed|authentication|api.?key|invalid.?token/i.test(text)
  ) {
    return new RunFailure(
      "authentication",
      "TrueForge authentication failed. Check the configured credential.",
    );
  }
  if (status === 429 || /rate.?limit/i.test(text))
    return new RunFailure("rate-limit", "TrueForge rate limit reached.", true);
  if (/timeout|timed out|TimeoutError/i.test(text))
    return new RunFailure(
      "timeout",
      "TrueForge stopped responding within the configured time limit.",
      true,
    );
  if (
    /model.*(?:missing|unavailable|not found)|(?:missing|unavailable).*model/i.test(
      text,
    )
  ) {
    return new RunFailure(
      "unknown",
      "The configured TrueForge model is unavailable. Check the agent model and endpoint configuration.",
    );
  }
  if (status === 400 || status === 404 || status === 422)
    return new RunFailure(
      "protocol",
      "TrueForge rejected the agent or tool configuration. Check the configured agent name and tool support.",
    );
  if (/fetch|ECONN|ENOTFOUND|network|connect/i.test(text))
    return new RunFailure(
      "connection",
      "Cannot connect to the local TrueForge service.",
      true,
    );
  return new RunFailure(
    "unknown",
    "TrueForge could not complete the turn. Check the local harness and model configuration.",
  );
}

function finiteTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value < 1 || value > 3_600_000)
    throw new Error(
      "TrueForge timeout must be between 1 and 3600000 milliseconds.",
    );
  return value;
}

/** Race SDK work against cancellation and an explicit wall-clock deadline. */
async function bounded<T>(
  promise: PromiseLike<T>,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<T> {
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new RunFailure(
                "timeout",
                "TrueForge stopped responding within the configured time limit.",
                true,
              ),
            ),
          timeoutMs,
        );
        abort = () => reject(new DOMException("Cancelled", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

function modelText(content: TrueForgeApi.ModelMessageEvent["content"]): string {
  if (typeof content === "string") return content;
  return (
    content?.map((part) => (part.type === "text" ? part.text : "")).join("") ??
    ""
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parsedCall(call: TrueForgeApi.ToolCall): {
  toolName: string;
  args: Record<string, unknown>;
} {
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments);
  } catch {
    throw new RunFailure(
      "protocol",
      "TrueForge returned malformed tool arguments. No approval was issued.",
    );
  }
  if (!isRecord(args))
    throw new RunFailure(
      "protocol",
      "TrueForge returned invalid tool arguments. No approval was issued.",
    );
  const info = call.toolInfo;
  const deferred =
    (info?.type === "truefoundry-system" && info.name === "call_tool") ||
    (call.function.name === "call_tool" &&
      info?.type === "mcp" &&
      info.name !== "call_tool");
  if (deferred) {
    if (
      typeof args.mcp_server !== "string" ||
      !args.mcp_server.trim() ||
      typeof args.tool_name !== "string" ||
      !args.tool_name.trim() ||
      !isRecord(args.input)
    ) {
      throw new RunFailure(
        "protocol",
        "TrueForge returned an invalid deferred tool envelope. No approval was issued.",
      );
    }
    if (
      info.type === "mcp" &&
      (info.name !== args.tool_name || info.serverName !== args.mcp_server)
    ) {
      throw new RunFailure(
        "protocol",
        "TrueForge deferred tool metadata did not match its arguments. No approval was issued.",
      );
    }
    // Display and review the underlying operation; approval still uses the original SDK call and thread references.
    return { toolName: args.tool_name, args: args.input };
  }
  return {
    toolName: info?.type === "mcp" ? info.name : call.function.name,
    args,
  };
}

/** The only SDK wire-to-application translation boundary. */
class EventAdapter {
  readonly messages = new Map<string, TrueForgeApi.ModelMessageEvent>();
  readonly pending = new Map<string, PendingApproval>();
  private readonly seenSequence = new Set<string>();
  private readonly seenEvents = new Set<string>();
  private readonly announcedTools = new Set<string>();
  constructor(
    private readonly context: ActiveTurn,
    private readonly merge: typeof mergeEventDelta,
  ) {}

  translate(
    event: TrueForgeApi.TurnStreamingEvent,
    sequence?: string,
  ): AgentEvent[] {
    if (
      !event ||
      typeof event !== "object" ||
      typeof event.type !== "string" ||
      typeof event.id !== "string"
    ) {
      throw new RunFailure(
        "protocol",
        "TrueForge returned an invalid stream event.",
      );
    }
    if (sequence) {
      if (this.seenSequence.has(sequence)) return [];
      this.seenSequence.add(sequence);
    } else if (event.type !== "model.message.delta") {
      const key = `${event.type}:${event.id}`;
      if (this.seenEvents.has(key)) return [];
      this.seenEvents.add(key);
    }
    const context: EventContext = {
      sessionId: this.context.sessionId!,
      turnId: this.context.turnId,
      eventId: sequence ? `sse:${sequence}` : event.id,
    };
    if (event.type === "turn.created") {
      this.context.turnId = event.turnId;
      return [
        {
          ...context,
          turnId: event.turnId,
          type: "status",
          state: "running",
          message: "TrueForge is running.",
        },
      ];
    }
    if (
      event.type === "model.message" ||
      event.type === "model.message.delta"
    ) {
      const output: AgentEvent[] = [];
      let message: TrueForgeApi.ModelMessageEvent;
      if (event.type === "model.message") {
        message = structuredClone(event);
        this.messages.set(event.id, message);
        const text = modelText(event.content);
        if (text && event.threadId === "main")
          output.push({
            ...context,
            type: "text",
            messageId: event.id,
            text,
            delta: false,
          });
      } else {
        message = this.messages.get(event.id) ?? {
          type: "model.message",
          id: event.id,
          threadId: event.threadId,
          createdAt: event.createdAt ?? new Date().toISOString(),
          content: "",
        };
        this.messages.set(event.id, message);
        this.merge(message, event);
        if (event.content && event.threadId === "main")
          output.push({
            ...context,
            type: "text",
            messageId: event.id,
            text: event.content,
            delta: true,
          });
      }
      for (const call of message.toolCalls ?? []) {
        this.context.sawTools = true;
        if (this.announcedTools.has(call.id)) continue;
        let parsed: ReturnType<typeof parsedCall>;
        try {
          parsed = parsedCall(call);
        } catch (error) {
          if (event.type === "model.message.delta" && !event.finishReason)
            continue;
          throw error;
        }
        this.announcedTools.add(call.id);
        output.push({
          ...context,
          type: "tool",
          toolCallId: call.id,
          ...parsed,
          status: "running",
        });
      }
      return output;
    }
    if (event.type === "tool.response") {
      this.context.sawTools = true;
      const call = [...this.messages.values()]
        .flatMap((message) => message.toolCalls ?? [])
        .find((item) => item.id === event.toolCallId);
      let failed = false;
      try {
        failed = JSON.parse(event.content)?.isError === true;
      } catch {
        /* Plain-text tool results are valid. */
      }
      return [
        {
          ...context,
          type: "tool",
          toolCallId: event.toolCallId,
          ...(call ? parsedCall(call) : { toolName: "tool", args: {} }),
          status: failed ? "failed" : "done",
          result: event.content,
        },
      ];
    }
    if (event.type === "tool.approval_required") {
      const output: AgentEvent[] = [];
      for (const ref of event.toolCalls) {
        if (this.pending.has(ref.id)) continue;
        const source = this.messages.get(ref.sourceEventId);
        const call = source?.toolCalls?.find((item) => item.id === ref.id);
        if (!call || source?.threadId !== event.threadId)
          throw new RunFailure(
            "protocol",
            "TrueForge approval references an unavailable tool call. No approval was issued.",
          );
        const approval: PendingApproval = {
          ...context,
          eventId: event.id,
          type: "approval",
          toolCallId: ref.id,
          ...parsedCall(call),
          threadId: event.threadId,
          sourceEventId: ref.sourceEventId,
        };
        this.pending.set(ref.id, approval);
        output.push(approval);
      }
      if (output.length)
        output.push({
          ...context,
          type: "status",
          state: "awaiting-review",
          message: "Review the proposed tool operation before continuing.",
        });
      return output;
    }
    if (event.type === "turn.done") {
      if (
        !event.state ||
        !["done", "error", "cancelled"].includes(event.state.status)
      )
        throw new RunFailure(
          "protocol",
          "TrueForge returned an invalid terminal turn state.",
        );
      this.context.terminal = true;
      if (event.state.status === "error") {
        const failure = classifyFailure(new Error(event.state.message));
        if (failure.kind === "connection")
          throw new RunFailure(
            "connection",
            "The TrueForge turn could not connect to its configured model or tool endpoint.",
            true,
          );
        throw failure;
      }
      if (event.state.status === "cancelled") {
        this.context.cancelled = true;
        this.pending.clear();
        return [
          {
            ...context,
            type: "done",
            status: "cancelled",
            awaitingApproval: false,
          },
        ];
      }
      const output: AgentEvent[] = [];
      for (const action of event.state.requiredActions) {
        if (action.type === "tool.approval_required")
          output.push(...this.translate(action));
        else
          throw new RunFailure(
            "protocol",
            "TrueForge requires an unsupported client action. Check the MCP and agent configuration.",
          );
      }
      if (event.state.output && !this.messages.has(event.state.output.id))
        output.push(...this.translate(event.state.output));
      output.push({
        ...context,
        type: "done",
        status: "done",
        awaitingApproval: this.pending.size > 0,
      });
      return output;
    }
    if (
      event.type === "tool.response_required" ||
      event.type === "mcp.auth_required"
    )
      throw new RunFailure(
        "protocol",
        "TrueForge requires an unsupported client action. Check the MCP and agent configuration.",
      );
    return [];
  }
}

/** Thin session/turn client: all model calls and tool execution remain in TrueForge. */
export class TrueForgeClient {
  private readonly sdk: Promise<TrueForge>;
  private readonly merge: Promise<typeof mergeEventDelta>;
  private readonly timeoutMs: number;
  private readonly cancellationTimeoutMs: number;
  private active?: ActiveTurn;
  private pending = new Map<string, PendingApproval>();
  private _sessionId?: string;
  private currentAgent: string;
  private streaming = false;

  constructor(private readonly config: TrueForgeConfig) {
    const baseUrl = validateTrueForgeUrl(config.baseUrl);
    if (!config.agentId.trim())
      throw new Error("A configured TrueForge agent name is required.");
    this.currentAgent = config.agentId;
    this.timeoutMs = finiteTimeout(config.timeoutMs, 120_000);
    this.cancellationTimeoutMs = finiteTimeout(
      config.cancellationTimeoutMs,
      5_000,
    );
    const sdkModule = import("@truefoundry/trueforge-sdk");
    this.sdk = sdkModule.then(
      ({ TrueForge }) =>
        new TrueForge({
          baseUrl,
          token: config.apiKey,
          timeoutInSeconds: this.timeoutMs / 1000,
          maxRetries: 0,
          stream: { reconnectionEnabled: false },
          fetch: (input, init) => fetch(input, { ...init, redirect: "error" }),
        }),
    );
    this.merge = sdkModule.then((module) => module.mergeEventDelta);
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  async *run(
    instruction: string,
    options: { signal?: AbortSignal; sessionId?: string } = {},
  ): AsyncGenerator<AgentEvent> {
    if (this.streaming || this.pending.size > 0) {
      yield this.errorEvent(
        new RunFailure(
          "protocol",
          "Finish or cancel the current TrueForge run before starting another.",
        ),
      );
      return;
    }
    this.streaming = true;
    this.active?.removeListener?.();
    this.pending.clear();
    const context = this.newContext(options.signal);
    this.active = context;
    let agent = this.currentAgent;
    let reuseSession = options.sessionId ?? this._sessionId;
    const candidates = [
      agent,
      ...(this.config.fallbackAgentId && this.config.fallbackAgentId !== agent
        ? [this.config.fallbackAgentId]
        : []),
    ];
    try {
      const sdk = await this.sdk;
      for (let index = 0; index < candidates.length; index++) {
        agent = candidates[index];
        if (context.cancelled || options.signal?.aborted) {
          yield* this.cancelledEvents(context);
          return;
        }
        try {
          context.terminal = false;
          context.startedTurn = false;
          context.sawTools = false;
          context.turnId = undefined;
          context.controller = new AbortController();
          if (!reuseSession) {
            const { data: session } = await bounded(
              sdk.sessions.create(
                { agent: { name: agent } },
                this.requestOptions(context),
              ),
              context.controller.signal,
              this.timeoutMs,
            );
            context.sessionId = session.id;
          } else context.sessionId = reuseSession;
          this._sessionId = context.sessionId;
          this.currentAgent = agent;
          if (context.cancelled) {
            await this.requestCancel(context);
            yield* this.cancelledEvents(context);
            return;
          }
          yield {
            type: "session",
            sessionId: context.sessionId!,
            agentId: agent,
          };
          const content =
            index === 0
              ? instruction
              : `The previous TrueForge session failed before any tool activity. Start a new reviewed attempt; do not replay prior tool calls or approvals.\n\nOriginal task:\n${instruction.slice(0, 32_000)}`;
          yield* this.turn(context, [{ type: "user.message", content }]);
          return;
        } catch (error) {
          if (context.cancelled || options.signal?.aborted) {
            yield* this.cancelledEvents(context);
            return;
          }
          const failure = classifyFailure(error);
          const stopped =
            !context.startedTurn ||
            context.terminal ||
            (await this.confirmStopped(context));
          if (context.cancelled || options.signal?.aborted) {
            yield* this.cancelledEvents(context);
            return;
          }
          if (!stopped) {
            yield this.errorEvent(
              new RunFailure(
                "protocol",
                "TrueForge cancellation could not be confirmed. No fallback was started; check the primary session before retrying.",
              ),
              context,
            );
            return;
          }
          if (context.sawTools || index === candidates.length - 1) {
            this.pending.clear();
            yield this.errorEvent(failure, context);
            return;
          }
          yield {
            type: "status",
            sessionId: context.sessionId ?? "",
            turnId: context.turnId,
            state: "retrying",
            message: `${failure.message} Starting the configured fallback agent.`,
          };
          reuseSession = undefined;
          context.sessionId = undefined;
          context.cancelRequest = undefined;
          this.pending.clear();
        }
      }
    } finally {
      this.streaming = false;
      if (!this.pending.size) context.removeListener?.();
    }
  }

  async *approve(decisions: ApprovalDecision[]): AsyncGenerator<AgentEvent> {
    const previous = this.active;
    if (previous?.cancelled || previous?.externalSignal?.aborted) {
      yield* this.cancelledEvents(previous);
      return;
    }
    if (this.streaming || !this._sessionId || !previous || !decisions.length) {
      yield this.errorEvent(
        new RunFailure(
          "protocol",
          "There is no paused TrueForge approval to resume.",
        ),
      );
      return;
    }
    const ids = new Set(decisions.map((decision) => decision.toolCallId));
    if (
      ids.size !== decisions.length ||
      ids.size !== this.pending.size ||
      decisions.some((decision) => !this.pending.has(decision.toolCallId))
    ) {
      yield this.errorEvent(
        new RunFailure(
          "protocol",
          "Every pending tool call needs exactly one explicit approval decision.",
        ),
      );
      return;
    }
    const input: TrueForgeApi.TurnInputItem[] = decisions.map((decision) => ({
      type: "user.tool_approval",
      threadId: this.pending.get(decision.toolCallId)!.threadId,
      toolCallId: decision.toolCallId,
      approval: decision.allow
        ? { status: "allow" }
        : {
            status: "deny",
            ...(decision.reason ? { reason: decision.reason } : {}),
          },
    }));
    previous.removeListener?.();
    const context = this.newContext(previous.externalSignal);
    context.sessionId = this._sessionId;
    this.active = context;
    this.streaming = true;
    this.pending.clear();
    try {
      yield* this.turn(context, input);
    } catch (error) {
      if (context.cancelled || context.externalSignal?.aborted)
        yield* this.cancelledEvents(context);
      else {
        if (!context.terminal) await this.confirmStopped(context);
        yield this.errorEvent(classifyFailure(error), context);
      }
    } finally {
      this.streaming = false;
      if (!this.pending.size) context.removeListener?.();
    }
  }

  /** Invalidate synchronously, then send a separate SDK cancellation request. */
  async cancel(): Promise<void> {
    const context = this.active;
    if (!context) return;
    context.cancelled = true;
    context.controller.abort();
    this.pending.clear();
    await this.requestCancel(context);
    context.removeListener?.();
  }

  private newContext(signal?: AbortSignal): ActiveTurn {
    const context: ActiveTurn = {
      controller: new AbortController(),
      cancelled: signal?.aborted ?? false,
      terminal: false,
      startedTurn: false,
      sawTools: false,
      externalSignal: signal,
    };
    const abort = () => {
      context.cancelled = true;
      context.controller.abort();
      this.pending.clear();
      void this.requestCancel(context).catch(() => {
        /* cancel() reports request failures to its caller. */
      });
    };
    signal?.addEventListener("abort", abort, { once: true });
    context.removeListener = () => signal?.removeEventListener("abort", abort);
    return context;
  }

  private requestOptions(context: ActiveTurn) {
    return {
      abortSignal: context.controller.signal,
      maxRetries: 0,
      timeoutInSeconds: this.timeoutMs / 1000,
      stream: { reconnectionEnabled: false },
    };
  }

  private async requestCancel(context: ActiveTurn): Promise<void> {
    if (!context.sessionId || !context.startedTurn) return;
    if (!context.cancelRequest) {
      context.cancelRequest = (async () => {
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(),
          this.cancellationTimeoutMs,
        );
        try {
          await (
            await this.sdk
          ).sessions.cancel(
            context.sessionId!,
            {},
            {
              maxRetries: 0,
              abortSignal: controller.signal,
              timeoutInSeconds: this.cancellationTimeoutMs / 1000,
            },
          );
        } catch (error) {
          throw new Error(classifyFailure(error).message);
        } finally {
          clearTimeout(timer);
        }
      })();
    }
    await context.cancelRequest;
  }

  private async confirmStopped(context: ActiveTurn): Promise<boolean> {
    context.controller.abort();
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.cancellationTimeoutMs,
    );
    try {
      const sdk = await this.sdk;
      await this.requestCancel(context);
      const deadline = Date.now() + this.cancellationTimeoutMs;
      while (!controller.signal.aborted && !context.cancelled) {
        if (context.turnId) {
          const { data: turn } = await bounded(
            sdk.sessions.getTurn(context.sessionId!, context.turnId, {
              maxRetries: 0,
              abortSignal: controller.signal,
              timeoutInSeconds: this.cancellationTimeoutMs / 1000,
            }),
            controller.signal,
            Math.max(1, deadline - Date.now()),
          );
          if (
            turn.state.status === "done" ||
            turn.state.status === "error" ||
            turn.state.status === "cancelled"
          ) {
            context.terminal = true;
            return true;
          }
        } else {
          const { data: session } = await bounded(
            sdk.sessions.get(context.sessionId!, {
              maxRetries: 0,
              abortSignal: controller.signal,
              timeoutInSeconds: this.cancellationTimeoutMs / 1000,
            }),
            controller.signal,
            Math.max(1, deadline - Date.now()),
          );
          if (!session.lastTurnDetails) return true;
          context.turnId = session.lastTurnDetails.id;
          if (
            session.lastTurnDetails.state.status === "done" ||
            session.lastTurnDetails.state.status === "error" ||
            session.lastTurnDetails.state.status === "cancelled"
          ) {
            context.terminal = true;
            return true;
          }
        }
        await bounded(
          new Promise<void>((resolve) => setTimeout(resolve, 100)),
          controller.signal,
          Math.max(1, deadline - Date.now()),
        );
      }
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
    return false;
  }

  private async *turn(
    context: ActiveTurn,
    input: TrueForgeApi.TurnInputItem[],
  ): AsyncGenerator<AgentEvent> {
    if (context.cancelled || context.externalSignal?.aborted) {
      yield* this.cancelledEvents(context);
      return;
    }
    context.startedTurn = true;
    const adapter = new EventAdapter(context, await this.merge);
    let stream: Awaited<ReturnType<TrueForge["sessions"]["createTurnStream"]>>;
    try {
      stream = await bounded(
        (await this.sdk).sessions.createTurnStream(
          context.sessionId!,
          { input },
          this.requestOptions(context),
        ),
        context.controller.signal,
        this.timeoutMs,
      );
    } catch (error) {
      // A definitive 4xx response rejected turn creation; there is no new live turn to cancel.
      const status =
        typeof error === "object" && error !== null && "statusCode" in error
          ? Number(error.statusCode)
          : undefined;
      if (status && status >= 400 && status < 500) context.startedTurn = false;
      throw error;
    }
    const iterator = stream.withMetadata()[Symbol.asyncIterator]();
    try {
      while (!context.cancelled) {
        const next = await bounded(
          iterator.next(),
          context.controller.signal,
          this.timeoutMs,
        );
        if (context.cancelled) break;
        if (next.done) {
          if (!context.terminal)
            throw new RunFailure(
              "protocol",
              "TrueForge stream ended before a terminal turn event.",
            );
          break;
        }
        for (const event of adapter.translate(next.value.data, next.value.id)) {
          if (
            context.cancelled &&
            !(event.type === "done" && event.status === "cancelled")
          )
            break;
          if (event.type === "approval")
            this.pending.set(event.toolCallId, event);
          if (event.type === "done" && event.status === "cancelled")
            this.pending.clear();
          yield this.redactEvent(event);
        }
        if (context.terminal) break;
      }
      if (context.cancelled && !context.terminal)
        yield* this.cancelledEvents(context);
    } finally {
      // An SDK iterator can still be waiting on a stalled response. Never block Cancel on iterator cleanup.
      void iterator.return?.().catch(() => undefined);
    }
  }

  private *cancelledEvents(context: ActiveTurn): Generator<AgentEvent> {
    const common = {
      sessionId: context.sessionId ?? this._sessionId ?? "",
      turnId: context.turnId,
    };
    yield {
      ...common,
      type: "status",
      state: "cancelled",
      message: "Run cancelled. TrueForge cancellation was requested.",
    };
    yield {
      ...common,
      type: "done",
      status: "cancelled",
      awaitingApproval: false,
    };
  }

  private errorEvent(failure: RunFailure, context = this.active): AgentEvent {
    return {
      type: "error",
      sessionId: context?.sessionId ?? this._sessionId ?? "",
      turnId: context?.turnId,
      kind: failure.kind,
      message: failure.message,
      retryable: failure.retryable,
    };
  }

  private redactEvent(event: AgentEvent): AgentEvent {
    const secret = this.config.apiKey;
    if (!secret) return event;
    const redact = (value: unknown): unknown => {
      if (typeof value === "string")
        return value.split(secret).join("[REDACTED]");
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object")
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [key, redact(item)]),
        );
      return value;
    };
    return redact(event) as AgentEvent;
  }
}
