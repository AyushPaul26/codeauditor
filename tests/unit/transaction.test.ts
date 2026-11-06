import { describe, it, expect } from "vitest";
import { prepareWorkspaceChanges } from "../../src/workspace/transaction";
import type { WorkspaceAdapter } from "../../src/contracts";
const adapter: WorkspaceAdapter = {
  root: "/tmp",
  listFiles: async () => ["a"],
  read: async (path) =>
    path === "new"
      ? { path, text: "", version: "missing" }
      : { path, text: "old", version: "one" },
  apply: async () => {},
};
describe("editor transaction preflight", () => {
  it("rejects a stale version without committing any file", async () => {
    await expect(
      prepareWorkspaceChanges(adapter, [
        { path: "a", text: "new", expectedVersion: "stale" },
      ]),
    ).rejects.toThrow(/changed|conflict|version/i);
  });
  it("allows multiple existing-file edits and returns their bases", async () => {
    const changes = await prepareWorkspaceChanges(adapter, [
      { path: "a", text: "new", expectedVersion: "one" },
      { path: "b", text: "next", expectedVersion: "one" },
    ]);
    expect(changes).toHaveLength(2);
    expect(changes[0].before.text).toBe("old");
  });
  it("refuses a mixed resource transaction rather than risk a half-apply", async () => {
    await expect(
      prepareWorkspaceChanges(adapter, [
        { path: "a", text: "new", expectedVersion: "one" },
        { path: "new", text: "next", expectedVersion: "missing" },
      ]),
    ).rejects.toThrow(/separate/i);
  });
  it("rejects duplicate paths", async () => {
    await expect(
      prepareWorkspaceChanges(adapter, [
        { path: "a", text: "one", expectedVersion: "one" },
        { path: "a", text: "two", expectedVersion: "one" },
      ]),
    ).rejects.toThrow(/duplicate/i);
  });
});
