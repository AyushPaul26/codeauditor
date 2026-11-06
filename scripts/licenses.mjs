import path from "node:path";
import { readFile, writeFile, readdir, access } from "node:fs/promises";
/** Preserve the licence/notice text of every dependency actually in the bundle. */
export async function writeBundleLicenses(metafile) {
  const packages = new Map();
  for (const input of Object.keys(metafile.inputs)) {
    if (!input.includes("node_modules/")) continue;
    let directory = path.dirname(path.resolve(input));
    while (directory !== path.dirname(directory)) {
      try {
        const pkg = JSON.parse(
          await readFile(path.join(directory, "package.json"), "utf8"),
        );
        if (pkg.name) {
          packages.set(directory, pkg);
          break;
        }
      } catch {
        /* walk to the owning package */
      }
      directory = path.dirname(directory);
    }
  }
  const sections = [
    "Third-party runtime licences included by the CodeAuditor bundle. Generated from installed, locked dependencies.\n",
  ];
  for (const [directory, pkg] of [...packages].sort((a, b) =>
    a[1].name.localeCompare(b[1].name),
  )) {
    const names = (await readdir(directory)).filter((name) =>
      /^(licen[cs]e|notice|copying)([.\-_]|$)/i.test(name),
    );
    if (!names.length)
      throw new Error(
        `Missing licence text for bundled dependency ${pkg.name}. Inspect before packaging.`,
      );
    sections.push(
      `\n${"=".repeat(72)}\n${pkg.name} ${pkg.version} (${pkg.license ?? "see licence"})\n`,
    );
    for (const name of names) {
      const file = path.join(directory, name);
      try {
        sections.push(`\n--- ${name} ---\n${await readFile(file, "utf8")}\n`);
      } catch (error) {
        if (error.code !== "EISDIR") throw error;
      }
    }
  }
  await writeFile("THIRD_PARTY_LICENSES.txt", sections.join(""));
}
