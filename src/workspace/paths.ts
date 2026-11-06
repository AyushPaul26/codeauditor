import path from "node:path";
import { lstat, realpath, stat } from "node:fs/promises";

const excludedDirectories = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".cache",
  ".next",
  ".nuxt",
  ".turbo",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".gradle",
  ".idea",
  ".ssh",
  ".aws",
  ".azure",
  ".gnupg",
  ".kube",
  ".config",
  ".codeauditor",
  ".docker",
  ".npm",
  "secrets",
  ".secrets",
  "credentials",
]);
const excludedNames = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  ".git-credentials",
  "credentials",
  "credentials.json",
  "secrets.json",
  "secrets.yaml",
  "secrets.yml",
  "auth.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "uv.lock",
  "cargo.lock",
  "composer.lock",
]);
const excludedExtension =
  /(?:\.(?:png|jpe?g|gif|webp|ico|bmp|tiff?|avif|pdf|zip|gz|bz2|xz|7z|rar|tar|exe|dll|so|dylib|bin|class|jar|war|pyc|pyo|wasm|woff2?|ttf|eot|otf|mp[34]|mov|avi|wav|ogg|flac|sqlite3?|db|gguf|safetensors|pt|pth|pem|key|p12|pfx|jks|keystore|crt|cer|der|tfstate|tfvars|log|map)|\.min\.(?:js|css))$/i;

function normalizeRelative(candidate: string): string {
  if (
    typeof candidate !== "string" ||
    !candidate ||
    candidate.length > 4096 ||
    /[\0-\x1f]/.test(candidate)
  ) {
    throw new Error("Workspace path must be a nonempty relative path.");
  }
  if (
    path.posix.isAbsolute(candidate) ||
    path.win32.isAbsolute(candidate) ||
    /^[a-z]:/i.test(candidate)
  ) {
    throw new Error("Workspace path must be relative.");
  }
  const segments = candidate.replace(/\\/g, "/").split("/");
  if (
    segments.some(
      (segment) =>
        segment === ".." ||
        /[:]/.test(segment) ||
        (/[. ]$/.test(segment) && segment !== ".") ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment),
    )
  ) {
    throw new Error("Workspace path contains an unsafe path component.");
  }
  const relative = segments
    .filter((segment) => segment && segment !== ".")
    .join("/");
  if (!relative)
    throw new Error("Workspace path must identify a workspace file.");
  return relative;
}

/** Shared deny policy for reads, searches, edits, and workspace copies. */
export function isExcluded(candidate: string): boolean {
  let relative: string;
  try {
    relative = normalizeRelative(candidate);
  } catch {
    return true;
  }
  const parts = relative.toLowerCase().split("/");
  return (
    parts.some(
      (part) =>
        excludedDirectories.has(part) ||
        excludedNames.has(part) ||
        /^\.env(?:rc)?(?:\.|$)/.test(part) ||
        /^(?:credentials|secrets)(?:[._-].+)?\.(?:json|ya?ml|toml|ini)$/.test(
          part,
        ),
    ) || excludedExtension.test(parts.at(-1)!)
  );
}

function assertContained(root: string, target: string) {
  const relative = path.relative(root, target);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Workspace path escapes outside the workspace.");
  }
  if (!relative || isExcluded(relative))
    throw new Error("Workspace path is excluded.");
}

/** Resolve existing files or a new file through its nearest existing real ancestor. */
export async function resolveWorkspacePath(
  root: string,
  candidate: string,
  allowMissing = false,
): Promise<string> {
  const relative = normalizeRelative(candidate);
  if (isExcluded(relative)) throw new Error("Workspace path is excluded.");
  const canonicalRoot = await realpath(root).catch(() => {
    throw new Error("Workspace root does not exist or is unavailable.");
  });
  if (!(await stat(canonicalRoot)).isDirectory())
    throw new Error("Workspace root must be a directory.");
  const target = path.resolve(canonicalRoot, relative);
  assertContained(canonicalRoot, target);
  let ancestor = target;
  const missing: string[] = [];
  while (true) {
    try {
      const resolved = await realpath(ancestor);
      const canonicalTarget = path.join(resolved, ...missing);
      assertContained(canonicalRoot, canonicalTarget);
      if (missing.length && !(await stat(resolved)).isDirectory())
        throw new Error("Workspace path ancestor must be a directory.");
      return canonicalTarget;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      // A dangling link is not a missing normal file and must not be followed on creation.
      const entry = await lstat(ancestor).catch(
        (failure: NodeJS.ErrnoException) => {
          if (failure.code === "ENOENT") return undefined;
          throw failure;
        },
      );
      if (entry?.isSymbolicLink())
        throw new Error("Workspace path contains an unresolved symlink.");
      if (!allowMissing) throw new Error("Workspace file does not exist.");
      if (ancestor === canonicalRoot)
        throw new Error("Workspace root is unavailable.");
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
}
