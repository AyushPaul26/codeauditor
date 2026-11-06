import { describe, it, expect } from "vitest";
import { startWorkspaceServer } from "../../src/mcp/server";
import type { WorkspaceAdapter } from "../../src/contracts";

const adapter: WorkspaceAdapter = {
  root: "/tmp",
  listFiles: async () => ["hello.ts"],
  read: async (path) => ({
    path,
    text: "export const hello = 1;",
    version: "v1",
  }),
  apply: async () => {},
};
const proposals = {
  stage: async () => ({ id: "p1", hunks: [] }),
  apply: async () => {
    throw new Error("No review");
  },
  readOverlay: adapter.read,
};

describe("authenticated workspace MCP", () => {
  it("rejects unauthenticated requests and hostile origins", async () => {
    const server = await startWorkspaceServer({
      adapter,
      proposals: proposals as never,
      token: "test-token-at-least-32-characters-long",
      port: 0,
    });
    try {
      expect((await fetch(server.url, { method: "POST" })).status).toBe(401);
      expect(
        (
          await fetch(server.url, {
            method: "POST",
            headers: {
              Authorization: "Bearer test-token-at-least-32-characters-long",
              Origin: "https://attacker.invalid",
            },
          })
        ).status,
      ).toBe(403);
    } finally {
      await server.close();
    }
  });
  it("initializes and lists real tools over the MCP protocol", async () => {
    const server = await startWorkspaceServer({
      adapter,
      proposals: proposals as never,
      token: "test-token-at-least-32-characters-long",
      port: 0,
    });
    try {
      const { Client } = await import(
        "@modelcontextprotocol/sdk/client/index.js"
      );
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );
      const client = new Client({ name: "test-client", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(server.url), {
          requestInit: {
            headers: {
              Authorization: "Bearer test-token-at-least-32-characters-long",
            },
          },
        }),
      );
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          "read_file",
          "search_workspace",
          "retrieve_context",
          "stage_patch",
          "request_apply",
          "run_command",
        ]),
      );
      const result = await client.callTool({
        name: "read_file",
        arguments: { path: "hello.ts" },
      });
      expect(JSON.stringify(result)).toContain("export const hello = 1;");
      const result2 = await client.callTool({
        name: "request_apply",
        arguments: { proposalId: "p1" },
      });
      expect(result2.isError).toBe(true);
      await client.close();
    } finally {
      await server.close();
    }
  });
});
