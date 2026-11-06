import { build, context } from "esbuild";
import { mkdir } from "node:fs/promises";
import { writeBundleLicenses } from "./licenses.mjs";
await mkdir("dist", { recursive: true });
const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  outfile: "dist/extension.cjs",
  sourcemap: true,
  metafile: true,
  logLevel: "info",
};
if (process.argv.includes("--watch")) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  const result = await build(options);
  await writeBundleLicenses(result.metafile);
}
