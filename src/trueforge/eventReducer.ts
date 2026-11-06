import type { AgentEvent } from "./client";

export type RunStatus =
  | "idle"
  | "running"
  | "awaiting-review"
  | "cancelling"
  | "cancelled"
  | "done"
  | "failed";
export interface RunSnapshot {
  runId: string;
  sessionId?: string;
  state: RunStatus;
  messages: Array<{ id: string; text: string }>;
  tools: Array<Extract<AgentEvent, { type: "tool" }>>;
  approvals: Array<Extract<AgentEvent, { type: "approval" }>>;
  error?: Extract<AgentEvent, { type: "error" }>;
  statusMessage?: string;
  awaitingFallback?: boolean;
  seenEventIds: string[];
}

export function createRunState(runId: string, sessionId?: string): RunSnapshot {
  return {
    runId,
    sessionId,
    state: "idle",
    messages: [],
    tools: [],
    approvals: [],
    seenEventIds: [],
  };
}

/** Pure reducer; a cancelled run cannot be revived by a late SDK event. */
export function reduceAgentEvent(
  state: RunSnapshot,
  event: AgentEvent,
): RunSnapshot {
  if (state.state === "cancelled" || state.state === "cancelling") return state;
  if (
    state.sessionId &&
    event.sessionId &&
    state.sessionId !== event.sessionId
  ) {
    // A fallback is an explicit new session after the visible retrying status.
    if (event.type !== "session" || !state.awaitingFallback) return state;
  }
  const identity =
    "toolCallId" in event
      ? event.toolCallId
      : "messageId" in event
        ? event.messageId
        : "";
  const key = event.eventId
    ? `${event.sessionId}:${event.turnId ?? ""}:${event.type}:${event.eventId}:${identity}`
    : undefined;
  if (key && state.seenEventIds.includes(key)) return state;
  const next = {
    ...state,
    seenEventIds: key ? [...state.seenEventIds, key] : state.seenEventIds,
  };
  switch (event.type) {
    case "session":
      return {
        ...next,
        sessionId: event.sessionId,
        state: "running",
        approvals: [],
        statusMessage: undefined,
        awaitingFallback: false,
      };
    case "text": {
      const index = state.messages.findIndex(
        (message) => message.id === event.messageId,
      );
      const messages = [...state.messages];
      if (index === -1)
        messages.push({ id: event.messageId, text: event.text });
      else
        messages[index] = {
          id: event.messageId,
          text: event.delta ? messages[index].text + event.text : event.text,
        };
      return {
        ...next,
        sessionId: state.sessionId ?? event.sessionId,
        messages,
      };
    }
    case "tool":
      return {
        ...next,
        tools: [
          ...state.tools.filter((tool) => tool.toolCallId !== event.toolCallId),
          event,
        ],
      };
    case "approval":
      return {
        ...next,
        state: "awaiting-review",
        approvals: [
          ...state.approvals.filter(
            (approval) => approval.toolCallId !== event.toolCallId,
          ),
          event,
        ],
      };
    case "status":
      return {
        ...next,
        state: event.state === "retrying" ? "running" : event.state,
        statusMessage: event.message,
        awaitingFallback: event.state === "retrying",
        ...(event.state === "running" ? { approvals: [] } : {}),
      };
    case "done":
      return {
        ...next,
        state:
          event.status === "cancelled"
            ? "cancelled"
            : event.awaitingApproval
              ? "awaiting-review"
              : "done",
      };
    case "error":
      return {
        ...next,
        state: "failed",
        error: event,
        statusMessage: event.message,
      };
  }
}
