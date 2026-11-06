import path from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execute = promisify(execFile);
const PINNED_FLASK = "22d924701a6ae2e4cd01e9a15bbaf3946094af65";
export interface PublicFixture {
  path: string;
  text: string;
}
/** This accepts public test data only; it never reads a live workspace .env. */
export function validatePublicFixtures(
  value: unknown,
  expectedCommit: string,
): PublicFixture[] {
  const data = value as {
    version?: number;
    commit?: string;
    source?: { repository?: string; ref?: string };
    files?: PublicFixture[];
  };
  if (
    !data ||
    data.version !== 1 ||
    data.commit !== expectedCommit ||
    data.source?.repository !== "https://github.com/pallets/flask.git" ||
    data.source.ref !== "3.1.3" ||
    !Array.isArray(data.files) ||
    data.files.length > 20
  )
    throw new Error(
      "Invalid public test-fixture provenance. Rerun fixtures:prepare.",
    );
  const seen = new Set<string>();
  let bytes = 0;
  for (const item of data.files) {
    if (
      !item ||
      typeof item.path !== "string" ||
      typeof item.text !== "string" ||
      !/^tests\/(?:[\w.-]+\/)*\.env(?:\.[\w.-]+)?$/.test(item.path) ||
      item.path.split("/").includes("..") ||
      seen.has(item.path)
    )
      throw new Error("Invalid public test-fixture path.");
    seen.add(item.path);
    bytes += Buffer.byteLength(item.text);
    if (bytes > 65536 || item.text.includes("\0"))
      throw new Error("Public test-fixture data exceeds safe limits.");
  }
  return data.files.map((item) => ({ ...item }));
}
export async function loadPublicFixtures(
  workspaceRoot: string,
  runtimeRoot: string,
): Promise<PublicFixture[]> {
  const name = path.basename(workspaceRoot),
    expectedRoot = path.join(runtimeRoot, "fixtures", name);
  let marker: { commit?: string; name?: string };
  try {
    if ((await realpath(workspaceRoot)) !== (await realpath(expectedRoot)))
      return [];
    marker = JSON.parse(
      await readFile(
        path.join(workspaceRoot, ".git", "codeauditor-managed.json"),
        "utf8",
      ),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  if (marker.commit !== PINNED_FLASK || name !== `flask-${marker.name}`)
    throw new Error(
      "Managed fixture marker mismatch. Prepare a fresh fixture.",
    );
  const metadata = path.join(runtimeRoot, "fixture-data", `${name}.json`);
  if ((await stat(metadata)).size > 100000)
    throw new Error("Public test-fixture metadata is too large.");
  const files = validatePublicFixtures(
    JSON.parse(await readFile(metadata, "utf8")),
    marker.commit,
  );
  const git = (args: string[]) =>
    execute("git", ["--no-replace-objects", "-C", workspaceRoot, ...args], {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 100000,
    }).then((r) => r.stdout);
  if ((await git(["rev-parse", "HEAD"])).trim() !== marker.commit)
    throw new Error(
      "Managed fixture HEAD changed. Prepare a fresh fixture before using public test data.",
    );
  // Check the metadata bytes against the immutable committed Git object, not
  // any current .env file. A later real secret is never copied from disk.
  for (const fixture of files)
    if (
      (await git(["show", `${marker.commit}:${fixture.path}`])) !== fixture.text
    )
      throw new Error(
        "Public fixture bytes do not match the pinned Git object.",
      );
  return files;
}
