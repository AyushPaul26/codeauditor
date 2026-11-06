import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DocumentSnapshot, WorkspaceAdapter } from "../contracts";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_COPY_BYTES = 32 * 1024 * 1024;
const MAX_FILES = 10000;
const excludedDirectories = new Set([
  ".git",
  ".svn",
  ".hg",
  ".venv",
  "venv",
  "env",
  "node_modules",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".nox",
  ".cache",
  "dist",
  "build",
  "coverage",
  ".aws",
  ".ssh",
  ".codex",
  ".agents",
]);
const sourceExtensions = new Set([
  ".py",
  ".pyi",
  ".md",
  ".rst",
  ".txt",
  ".toml",
  ".ini",
  ".cfg",
  ".json",
  ".yaml",
  ".yml",
  ".html",
  ".htm",
  ".jinja",
  ".jinja2",
  ".css",
  ".scss",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".sql",
  ".xml",
  ".svg",
  ".csv",
  ".lock",
]);

/** Reject traversal on both host platforms, before touching the filesystem. */
export function commandRelativePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    !value ||
    value.includes("\0") ||
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(
      "Supported checks require project-relative paths without parent traversal.",
    );
  }
  return path.posix.normalize(normalized).replace(/^\.\//, "");
}

function permitted(value: string): boolean {
  const parts = value.split("/");
  const basename = parts.at(-1)!.toLowerCase();
  return (
    !parts.some((part) => excludedDirectories.has(part.toLowerCase())) &&
    !/(?:^\.env(?:\.|$)|^\.netrc$|^\.npmrc$|^\.pypirc$|^id_(?:rsa|ed25519)|(?:^|[._-])(?:secrets?|credentials?)(?:[._-]|$)|\.(?:pem|key|p12|pfx|pyc|pyo|log|sqlite|db)$)/i.test(
      basename,
    )
  );
}

function ordinarySource(value: string): boolean {
  return (
    permitted(value) &&
    (sourceExtensions.has(path.posix.extname(value).toLowerCase()) ||
      /^(?:LICENSE|NOTICE|README|CHANGELOG|AUTHORS|CONTRIBUTING|Makefile|Dockerfile|MANIFEST\.in|\.gitignore|\.gitattributes|\.editorconfig|\.coveragerc|\.python-version)$/i.test(
        path.posix.basename(value),
      ))
  );
}

export interface CommandChange {
  path: string;
  oldText: string;
  newText: string;
}
export interface CommandCopy {
  readonly root: string;
  collectChanges(): Promise<CommandChange[]>;
  cleanup(): Promise<void>;
}

/** Explicit public test data supplied from a pinned fixture, never live .env files. */
export interface PublicCommandFixture {
  readonly path: string;
  readonly text: string;
}

function validatePublicFixtures(
  fixtures: ReadonlyArray<PublicCommandFixture>,
): PublicCommandFixture[] {
  if (!Array.isArray(fixtures) || fixtures.length > MAX_FILES)
    throw new Error("Public command fixtures exceed the file limit.");
  const seen = new Set<string>();
  let bytes = 0;
  return fixtures.map((fixture) => {
    if (
      !fixture ||
      typeof fixture.path !== "string" ||
      typeof fixture.text !== "string"
    )
      throw new Error(
        "Public command fixtures require relative paths and text.",
      );
    const relative = commandRelativePath(fixture.path);
    const parts = relative.split("/");
    if (
      !/^(?:tests|test|__tests__)\//.test(relative) ||
      !/^\.env(?:\..+)?$/.test(parts.at(-1)!) ||
      /[\x00-\x1f<>:"|?*]/.test(relative) ||
      parts.some(
        (part) =>
          excludedDirectories.has(part.toLowerCase()) ||
          /[. ]$/.test(part) ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
    )
      throw new Error(
        "Public command fixtures must be dotenv files under tests/, test/, or __tests__/ with safe relative paths.",
      );
    const identity = relative.toLowerCase();
    if (seen.has(identity))
      throw new Error(`Duplicate public command fixture path: ${relative}`);
    seen.add(identity);
    const size = Buffer.byteLength(fixture.text);
    if (fixture.text.includes("\0"))
      throw new Error(`Public command fixture must be text: ${relative}`);
    if (size > MAX_FILE_BYTES)
      throw new Error(`Public command fixture exceeds 1 MiB: ${relative}`);
    bytes += size;
    if (bytes > MAX_COPY_BYTES)
      throw new Error("Public command fixtures exceed the 32 MiB copy limit.");
    return { path: relative, text: fixture.text };
  });
}

/**
 * Isolates ordinary project outputs, not hostile code. Trusted Python tests can
 * still access absolute paths or the network; this is not an OS security sandbox.
 */
export async function createCommandCopy(
  adapter: WorkspaceAdapter,
  overlay?: (path: string) => Promise<DocumentSnapshot>,
  publicFixtures: ReadonlyArray<PublicCommandFixture> = [],
): Promise<CommandCopy> {
  const fixtures = validatePublicFixtures(publicFixtures);
  const root = await mkdtemp(path.join(tmpdir(), "codeauditor-check-"));
  const baseline = new Map<string, string>();
  try {
    let totalBytes = fixtures.reduce(
      (sum, fixture) => sum + Buffer.byteLength(fixture.text),
      0,
    );
    const files = await adapter.listFiles();
    if (files.length + fixtures.length > MAX_FILES)
      throw new Error(
        "Project check copy exceeds 10,000 files. Narrow the trusted project first.",
      );
    for (const candidate of files) {
      const relative = commandRelativePath(candidate);
      if (relative === "." || !permitted(relative)) continue;
      const document = await (overlay
        ? overlay(candidate)
        : adapter.read(candidate));
      if (document.version === "missing") continue;
      const bytes = Buffer.byteLength(document.text);
      if (document.text.includes("\0")) continue;
      if (bytes > MAX_FILE_BYTES)
        throw new Error(`Project check file exceeds 1 MiB: ${relative}`);
      totalBytes += bytes;
      if (totalBytes > MAX_COPY_BYTES)
        throw new Error(
          "Project check copy exceeds 32 MiB. Narrow the trusted project first.",
        );
      const destination = path.join(root, ...relative.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, document.text, { flag: "wx", mode: 0o600 });
      baseline.set(relative, document.text);
    }
    for (const fixture of fixtures) {
      const destination = path.join(root, ...fixture.path.split("/"));
      await mkdir(path.dirname(destination), { recursive: true });
      // Never overwrite ordinary project data. These fixtures remain excluded
      // from source collection by the unchanged dotenv filtering policy.
      await writeFile(destination, fixture.text, { flag: "wx", mode: 0o600 });
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  return {
    root,
    async collectChanges() {
      const after = new Map<string, string>();
      let bytesRead = 0;
      let entriesRead = 0;
      async function walk(directory: string, prefix = ""): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          if (++entriesRead > MAX_FILES)
            throw new Error(
              "Command produced too many files to review safely.",
            );
          const relative = `${prefix}${entry.name}`;
          if (!permitted(relative) || entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) {
            await walk(path.join(directory, entry.name), `${relative}/`);
          } else if (entry.isFile() && ordinarySource(relative)) {
            const absolute = path.join(root, ...relative.split("/"));
            const stat = await lstat(absolute);
            if (stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES)
              throw new Error(
                `Command output cannot be reviewed safely: ${relative}`,
              );
            bytesRead += stat.size;
            if (bytesRead > MAX_COPY_BYTES)
              throw new Error(
                "Command source output exceeds the review limit.",
              );
            const buffer = await readFile(absolute);
            let text: string;
            try {
              text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
            } catch {
              throw new Error(
                `Command produced binary source that cannot be reviewed: ${relative}`,
              );
            }
            if (text.includes("\0"))
              throw new Error(
                `Command produced binary source that cannot be reviewed: ${relative}`,
              );
            after.set(relative, text);
          }
        }
      }
      await walk(root);
      const changes: CommandChange[] = [];
      for (const relative of new Set([...baseline.keys(), ...after.keys()])) {
        if (!ordinarySource(relative)) continue;
        const oldText = baseline.get(relative) ?? "";
        const newText = after.get(relative) ?? "";
        if (oldText !== newText)
          changes.push({ path: relative, oldText, newText });
      }
      return changes.sort((a, b) => a.path.localeCompare(b.path));
    },
    cleanup: () =>
      rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}
