import {
  assertPortAvailable,
  foreground,
  isMain,
  loadConfig,
  reportFailure,
  verifyFile,
} from "./runtime.mjs";

export function modelArgs(model, { fallback = false } = {}) {
  return [
    "--model",
    model.modelPath,
    "--alias",
    model.modelId,
    "--host",
    "127.0.0.1",
    "--port",
    String(model.port),
    "--ctx-size",
    "4096",
    "--parallel",
    "1",
    "--n-gpu-layers",
    fallback ? "0" : "99",
    "--jinja",
    "--reasoning-budget",
    "0",
    "--chat-template-kwargs",
    '{"enable_thinking":false}',
    "--temp",
    "0.2",
    "--no-webui",
  ];
}
export async function startModel({
  fallback = process.argv.includes("--fallback"),
} = {}) {
  const config = await loadConfig();
  const model = fallback ? config.fallback : config.primary;
  if (!model)
    throw new Error(
      "No independent fallback configured. Add fallback in runtime.json with its own model file and port 8081.",
    );
  await verifyFile(model.llamaServerPath, model.llamaServerSha256);
  await verifyFile(model.modelPath, model.modelSha256);
  await assertPortAvailable(model.port);
  console.log(
    `Starting ${fallback ? "CPU fallback" : "primary CUDA"} model ${model.modelId}; first readiness may take several minutes.`,
  );
  await foreground(model.llamaServerPath, modelArgs(model, { fallback }), {
    readyUrl: `http://127.0.0.1:${model.port}/health`,
    label: fallback ? "Fallback model" : "Primary model",
  });
}
if (isMain(import.meta.url)) startModel().catch(reportFailure);
