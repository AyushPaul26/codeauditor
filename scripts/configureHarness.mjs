import { readFile } from "node:fs/promises";
import { TrueForge } from "@truefoundry/trueforge-sdk";
import {
  ensureRuntime,
  isMain,
  reportFailure,
  saveConfig,
} from "./runtime.mjs";

export async function agentManifest(modelName) {
  const manifest = JSON.parse(
    await readFile(
      new URL("../agents/codeauditor.json", import.meta.url),
      "utf8",
    ),
  );
  manifest.model.name = modelName;
  return manifest;
}
export function providerManifest(model, slot) {
  return {
    name: `codeauditor-local-${slot}`,
    type: "custom",
    baseUrl: `http://127.0.0.1:${model.port}/v1`,
    models: [
      {
        name: "local-model",
        modelId: model.modelId,
        properties: { contextLength: 4096, maxOutputTokens: 1024 },
      },
    ],
  };
}
export function mcpManifest(mcp) {
  return {
    name: "codeauditor-workspace",
    type: "remote",
    description:
      "Trusted VS Code workspace reads, staged review and approved commands.",
    url: `http://127.0.0.1:${mcp.port}/mcp`,
    auth: { type: "header", headers: { Authorization: `Bearer ${mcp.token}` } },
  };
}
export async function configureHarness() {
  const config = await ensureRuntime();
  const client = new TrueForge({
    baseUrl: config.harness.url,
    timeoutInSeconds: 15,
    maxRetries: 0,
  });
  try {
    await client.settings.mcpServers.createOrUpdate({
      manifest: mcpManifest(config.mcp),
    });
    for (const slot of ["primary", "fallback"]) {
      const model = config[slot];
      if (!model) continue;
      const provider = providerManifest(model, slot);
      await client.settings.modelProviders.createOrUpdate({
        manifest: provider,
      });
      const manifest = await agentManifest(
        `${provider.name}/${provider.models[0].name}`,
      );
      const idKey = slot === "primary" ? "agentId" : "fallbackAgentId";
      const agentName = `codeauditor-${slot}`;
      const registry = await client.agents.list({ agentName });
      const existingId = registry.data.find(
        (agent) => agent.name === agentName,
      )?.id;
      const response = existingId
        ? await client.agents.update(existingId, {
            manifest,
            description: "Review-first local coding agent.",
          })
        : await client.agents.create({
            name: agentName,
            description: "Review-first local coding agent.",
            manifest,
          });
      // Sessions resolve the registry name; update/get use the immutable ID.
      config.harness[idKey] = response.data.name;
      await saveConfig(config);
      console.log(`Registered ${slot} agent ${response.data.name}.`);
    }
  } catch (error) {
    throw new Error(
      "TrueForge configuration failed. Start npm run harness:start, confirm its URL, then check the TrueForge Settings page. Private request details were omitted.",
      { cause: error },
    );
  }
  console.log(
    "Workspace connector registered. Open the trusted fixture in the extension host to start MCP, then verify a real read tool call.",
  );
  return config;
}
if (isMain(import.meta.url)) configureHarness().catch(reportFailure);
