import {
  configPath,
  ensureRuntime,
  isMain,
  reportFailure,
  runtimeDir,
} from "./runtime.mjs";
import { ensureUv } from "./prepareFixture.mjs";

export async function setupLocal() {
  const dir = runtimeDir();
  const config = await ensureRuntime({ dir });
  console.log(
    `Private runtime ready: ${dir}\nConfiguration: ${configPath({ dir })}`,
  );
  console.log(
    "Existing configuration and authentication were preserved. Do not share runtime.json.",
  );
  console.log(
    "Select trusted llama.cpp CUDA and Qwen3-1.7B Q4_K_M GGUF files; set absolute paths and published expected SHA-256 hashes in primary. Model assets are not downloaded automatically. See docs/windows-setup.md.",
  );
  await ensureUv({ dir });
  console.log(
    "Pinned uv is ready. Next: npm run model:start; npm run harness:start; npm run harness:configure. Use separate terminals.",
  );
  if (!config.fallback)
    console.log(
      "Fallback is optional until resilience testing: add a separately served model in fallback (port 8081).",
    );
  return config;
}
if (isMain(import.meta.url)) setupLocal().catch(reportFailure);
