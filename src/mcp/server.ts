import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { WorkspaceAdapter } from "../contracts";
import type { ProposalStore } from "../edits/proposalStore";
import { retrieveContext, searchWorkspace } from "../context/retrieve";
import type { CommandRunner } from "./commandRunner";

interface ServerOptions {
  adapter: WorkspaceAdapter;
  proposals: ProposalStore;
  token: string;
  port: number;
  commands?: CommandRunner;
  getRunId?: () => string | undefined;
  getSignal?: () => AbortSignal | undefined;
  consumeCommandPermission?: (args: {
    executable: string;
    args: string[];
  }) => boolean;
  onTool?: (name: string, result: unknown) => void;
  contextTokens?: number;
}
const textResult = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});

export async function startWorkspaceServer(
  options: ServerOptions,
): Promise<{ url: string; close(): Promise<void> }> {
  if (options.token.length < 32)
    throw new Error("Workspace MCP token must contain at least 32 characters.");
  const transports = new Set<StreamableHTTPServerTransport>();
  const requireRun = () => {
    const id = options.getRunId?.();
    if (!id || options.getSignal?.()?.aborted)
      throw new Error("No active CodeAuditor run.");
    return id;
  };
  const toolServer = () => {
    const mcp = new McpServer({
      name: "codeauditor-workspace",
      version: "0.1.0",
    });
    const wrap =
      (name: string, fn: (args: any) => Promise<unknown>) =>
      async (args: any) => {
        try {
          const result = await fn(args);
          options.onTool?.(name, result);
          return textResult(result);
        } catch (error) {
          return {
            ...textResult({
              error:
                error instanceof Error
                  ? error.message
                  : "Workspace tool failed.",
            }),
            isError: true,
          };
        }
      };
    mcp.registerTool(
      "read_file",
      {
        description:
          "Read current editor text for exact stage_patch context. Includes unsaved changes. Set includeStaged only to inspect proposed content; oldText for new proposals must match the original editor text.",
        inputSchema: {
          path: z.string().max(500),
          startLine: z.number().int().min(1).optional(),
          maxLines: z.number().int().min(1).max(200).optional(),
          includeStaged: z.boolean().optional(),
        },
        annotations: { readOnlyHint: true },
      },
      wrap(
        "read_file",
        async ({
          path,
          startLine = 1,
          maxLines = 120,
          includeStaged = false,
        }) => {
          const snapshot = includeStaged
            ? await options.proposals.readOverlay(path, options.getRunId?.())
            : await options.adapter.read(path);
          const lines = snapshot.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
          return {
            path,
            startLine,
            endLine: Math.min(lines.length, startLine + maxLines - 1),
            text: lines
              .slice(startLine - 1, startLine - 1 + maxLines)
              .join("")
              .slice(0, 24000),
            version: snapshot.version,
            totalLines: lines.length,
          };
        },
      ),
    );
    mcp.registerTool(
      "search_workspace",
      {
        description:
          "Search project filenames and source text. Discover code, tests and documentation without guessing paths.",
        inputSchema: {
          query: z.string().min(1).max(500),
          maxResults: z.number().int().min(1).max(40).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      wrap("search_workspace", ({ query, maxResults }) =>
        searchWorkspace(options.adapter, query, maxResults),
      ),
    );
    mcp.registerTool(
      "retrieve_context",
      {
        description:
          "Find task-relevant source, tests and docs under a small context budget. Return paths, line ranges and selection reasons; respects @file and @symbol mentions.",
        inputSchema: { instruction: z.string().min(1).max(10000) },
        annotations: { readOnlyHint: true },
      },
      wrap("retrieve_context", ({ instruction }) =>
        retrieveContext(
          options.adapter,
          instruction,
          options.contextTokens ?? 4096,
        ),
      ),
    );
    mcp.registerTool(
      "stage_patch",
      {
        description:
          "Propose exact text replacements; no writes occur. Each oldText must match uniquely. For a new file use oldText empty. Returns an immutable proposal ID for request_apply.",
        inputSchema: {
          changes: z
            .array(
              z.object({
                path: z.string().max(500),
                oldText: z.string().max(120000),
                newText: z.string().max(120000),
              }),
            )
            .min(1)
            .max(30),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      wrap("stage_patch", ({ changes }) =>
        options.proposals.stage(requireRun(), changes),
      ),
    );
    mcp.registerTool(
      "request_apply",
      {
        description:
          "Request human review of a staged proposal. Requires TrueForge approval and per-hunk decisions in VS Code. Only accepted hunks can be applied; rejected hunks stay rejected.",
        inputSchema: { proposalId: z.string() },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      wrap("request_apply", async ({ proposalId }) => {
        const runId = requireRun();
        const proposal = options.proposals.get(proposalId);
        if (!proposal || proposal.runId !== runId)
          throw new Error("Proposal does not belong to this active run.");
        return options.proposals.apply(proposalId);
      }),
    );
    mcp.registerTool(
      "run_command",
      {
        description:
          "Run a user-approved bounded Python check in a temporary project copy, never a shell. Supported: python -m pytest, flask help/config/routes, py_compile. No arbitrary python -c or shell.",
        inputSchema: {
          executable: z.string().max(300),
          args: z.array(z.string().max(1000)).max(40),
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
      },
      wrap("run_command", async (args) => {
        const runId = requireRun();
        if (!options.commands || !options.consumeCommandPermission?.(args))
          throw new Error("Command needs explicit approval in CodeAuditor.");
        const result = await options.commands.run(
          { ...args, runId },
          options.getSignal?.(),
        );
        if (result.changes.length && !options.getSignal?.()?.aborted) {
          const proposal = await options.proposals.stage(runId, result.changes);
          return { ...result, generatedProposalId: proposal.id };
        }
        return result;
      }),
    );
    return mcp;
  };
  const server: Server = createServer(async (req, res) => {
    const supplied = req.headers.authorization ?? "";
    const expected = `Bearer ${options.token}`;
    if (
      Buffer.byteLength(supplied) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    ) {
      res.writeHead(401).end("Authentication required.");
      return;
    }
    if (req.headers.origin) {
      try {
        const origin = new URL(req.headers.origin);
        if (!["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
          throw new Error();
      } catch {
        res.writeHead(403).end("Origin denied.");
        return;
      }
    }
    const host = req.headers.host?.split(":")[0];
    if (!host || !["127.0.0.1", "localhost"].includes(host)) {
      res.writeHead(403).end("Host denied.");
      return;
    }
    if (req.url !== "/mcp") {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    let transport: StreamableHTTPServerTransport | undefined;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1048576) {
          res.writeHead(413).end("Request too large.");
          return;
        }
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const mcp = toolServer();
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      transports.add(transport);
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      await mcp.close();
    } catch {
      if (!res.headersSent)
        res
          .writeHead(400, { "Content-Type": "application/json" })
          .end(JSON.stringify({ error: "Invalid MCP request." }));
    } finally {
      if (transport) {
        transports.delete(transport);
        await transport.close();
      }
    }
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Cannot start workspace MCP.");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: async () => {
      for (const transport of transports) await transport.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
