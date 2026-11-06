import { describe, expect, it } from "vitest";
import { TrueForgeClient, type AgentEvent } from "../../src/trueforge/client";

/** Real inference only. An enabled test fails on missing prerequisites; it never substitutes a fixture stream. */
describe.runIf(process.env.CODEAUDITOR_LIVE === "1")(
  "live TrueForge and configured local model",
  () => {
    it("executes a workspace read through the harness and reaches a streamed terminal reply", async () => {
      const client = new TrueForgeClient({
        baseUrl: process.env.TRUEFORGE_BASE_URL ?? "http://127.0.0.1:8790",
        agentId: process.env.TRUEFORGE_AGENT_ID ?? "codeauditor-primary",
        apiKey: process.env.TRUEFORGE_TOKEN,
        timeoutMs: 300_000,
      });
      const events: AgentEvent[] = [];
      for await (const event of client.run(
        "Use the workspace search/read tools to inspect one existing source or documentation file. Report the actual path and one observed fact from its contents. Do not stage edits or run commands.",
      ))
        events.push(event);
      expect(events.filter((event) => event.type === "error")).toEqual([]);
      expect(
        events.some(
          (event) =>
            event.type === "tool" &&
            event.status === "done" &&
            /read|search|retrieve/.test(event.toolName),
        ),
      ).toBe(true);
      expect(
        events.some((event) => event.type === "text" && event.text.length > 0),
      ).toBe(true);
      expect(events.at(-1)).toMatchObject({
        type: "done",
        status: "done",
        awaitingApproval: false,
      });
      expect(client.sessionId).toBeTruthy();
    });
  },
);
