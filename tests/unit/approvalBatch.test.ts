import { describe, it, expect } from "vitest";
import { completeApprovalBatch } from "../../src/approvals";
describe("host approval batch", () => {
  it("does not resume two tool calls with a partial decision", () => {
    expect(
      completeApprovalBatch(
        [{ toolCallId: "a" }, { toolCallId: "b" }],
        new Map([["a", { toolCallId: "a", allow: true }]]),
      ),
    ).toBeUndefined();
  });
  it("returns all decisions in pending order, preserving rejection", () => {
    expect(
      completeApprovalBatch(
        [{ toolCallId: "a" }, { toolCallId: "b" }],
        new Map([
          ["b", { toolCallId: "b", allow: false }],
          ["a", { toolCallId: "a", allow: true }],
        ]),
      ),
    ).toEqual([
      { toolCallId: "a", allow: true },
      { toolCallId: "b", allow: false },
    ]);
  });
  it("ignores unrelated decisions and never resumes an empty batch", () => {
    expect(completeApprovalBatch([], new Map())).toBeUndefined();
    expect(
      completeApprovalBatch(
        [{ toolCallId: "a" }],
        new Map([["other", { toolCallId: "other", allow: true }]]),
      ),
    ).toBeUndefined();
  });
});
