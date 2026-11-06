import { describe, expect, it } from "vitest";
import {
  createRunState,
  reduceAgentEvent,
} from "../../src/trueforge/eventReducer";

describe("TrueForge run event reducer", () => {
  it("merges deltas by message id and replaces complete snapshots", () => {
    let state = createRunState("run-1", "session-1");
    state = reduceAgentEvent(state, {
      type: "text",
      sessionId: "session-1",
      messageId: "one",
      text: "Hello",
      delta: true,
      eventId: "a",
    });
    state = reduceAgentEvent(state, {
      type: "text",
      sessionId: "session-1",
      messageId: "two",
      text: "Other",
      delta: true,
      eventId: "b",
    });
    state = reduceAgentEvent(state, {
      type: "text",
      sessionId: "session-1",
      messageId: "one",
      text: " world",
      delta: true,
      eventId: "c",
    });
    state = reduceAgentEvent(state, {
      type: "text",
      sessionId: "session-1",
      messageId: "one",
      text: "Hello world",
      delta: false,
      eventId: "d",
    });
    expect(state.messages).toEqual([
      { id: "one", text: "Hello world" },
      { id: "two", text: "Other" },
    ]);
  });

  it("ignores late events for a cancelled run and events from other sessions", () => {
    const original = createRunState("run-1", "session-1");
    expect(
      reduceAgentEvent(original, {
        type: "text",
        sessionId: "session-2",
        messageId: "one",
        text: "wrong",
        delta: true,
      }),
    ).toBe(original);
    const cancelled = reduceAgentEvent(original, {
      type: "status",
      sessionId: "session-1",
      state: "cancelled",
      message: "Cancelled",
    });
    expect(
      reduceAgentEvent(cancelled, {
        type: "text",
        sessionId: "session-1",
        messageId: "one",
        text: "late",
        delta: true,
      }),
    ).toBe(cancelled);
    expect(
      reduceAgentEvent(cancelled, {
        type: "done",
        sessionId: "session-1",
        status: "done",
        awaitingApproval: false,
      }),
    ).toBe(cancelled);
  });

  it("deduplicates event ids without losing legitimate repeated text", () => {
    let state = createRunState("run-1", "session-1");
    const first = {
      type: "text" as const,
      sessionId: "session-1",
      messageId: "one",
      text: "ha",
      delta: true,
      eventId: "1",
    };
    state = reduceAgentEvent(state, first);
    state = reduceAgentEvent(state, first);
    state = reduceAgentEvent(state, { ...first, eventId: "2" });
    expect(state.messages).toEqual([{ id: "one", text: "haha" }]);
  });

  it("retains approval details after the paused turn completes", () => {
    let state = createRunState("run-1", "session-1");
    state = reduceAgentEvent(state, {
      type: "approval",
      sessionId: "session-1",
      toolCallId: "call-1",
      toolName: "request_apply",
      args: { proposalId: "p" },
      threadId: "main",
      sourceEventId: "model-1",
      eventId: "approval-1",
    });
    state = reduceAgentEvent(state, {
      type: "done",
      sessionId: "session-1",
      status: "done",
      awaitingApproval: true,
    });
    expect(state.state).toBe("awaiting-review");
    expect(state.approvals[0]).toMatchObject({
      toolCallId: "call-1",
      args: { proposalId: "p" },
    });
  });
});
