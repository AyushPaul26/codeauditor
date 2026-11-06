import type { DocumentSnapshot, WorkspaceAdapter } from "../contracts";
import { isExcluded } from "../workspace/paths";
import { calculateContextBudget, estimateTokens } from "./budget";
import { parseMentions } from "./mentions";

export interface Snippet {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  reason: string;
  /** Includes provenance/header cost; estimates are not exact tokenizer counts. */
  tokenEstimate: number;
}
export interface RetrievalResult {
  snippets: Snippet[];
  usedTokens: number;
  inputBudget: number;
  omittedCount: number;
}
export interface SearchResult {
  path: string;
  line: number;
  text: string;
}

const MAX_FILES = 256;
const MAX_FILE_CHARS = 64 * 1024;
const MAX_SCAN_CHARS = 1024 * 1024;
const MAX_LINES = 4096;
const MAX_LINE_CHARS = 2000;
interface IndexedDocument {
  path: string;
  version: string;
  lines: string[];
  symbols: Map<string, number[]>;
  truncated: boolean;
  characterLimit: number;
}
const indexes = new WeakMap<WorkspaceAdapter, Map<string, IndexedDocument>>();

const aliases: Record<string, string> = {
  configuration: "config",
  configurations: "config",
  configure: "config",
  configured: "config",
  commands: "command",
  tests: "test",
  testing: "test",
  documentation: "doc",
  documents: "doc",
  docs: "doc",
  arguments: "argument",
  options: "option",
  settings: "setting",
};
const stopWords = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "with",
  "please",
  "add",
  "change",
  "explain",
  "find",
  "read",
  "file",
  "symbol",
]);
function words(text: string): string[] {
  return [
    ...new Set(
      (text.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])
        .flatMap((word) => [word, ...word.split(/[_-]/)])
        .map((word) => aliases[word] ?? word)
        .filter((word) => word.length > 1 && !stopWords.has(word)),
    ),
  ].slice(0, 64);
}
function lexicalScore(text: string, terms: string[]): number {
  const textWords = new Set(words(text));
  return terms.reduce(
    (score, term) => score + (textWords.has(term) ? 1 : 0),
    0,
  );
}
function fileKind(file: string): "test" | "doc" | "source" {
  if (
    /(?:^|\/)(?:tests?|checks?|__tests__)(?:\/|$)|(?:^|\/)(?:test[_-]|[^/]+[._-](?:test|spec)\.)/i.test(
      file,
    )
  )
    return "test";
  if (/(?:^|\/)(?:docs?|guide|manual)(?:\/|$)|\.(?:md|rst|adoc)$/i.test(file))
    return "doc";
  return "source";
}
function binaryOrGenerated(text: string): boolean {
  if (
    text.includes("\0") ||
    /(?:@generated|auto[- ]generated|automatically generated)[^\n]{0,120}(?:do not edit)?/i.test(
      text.slice(0, 1000),
    )
  )
    return true;
  const controls =
    text.slice(0, 4000).match(/[\x01-\x08\x0b\x0c\x0e-\x1f]/g)?.length ?? 0;
  return controls > Math.max(2, Math.min(text.length, 4000) / 100);
}
function indexSnapshot(
  snapshot: DocumentSnapshot,
  characterLimit = MAX_FILE_CHARS,
): IndexedDocument | undefined {
  const prefix = snapshot.text.slice(0, characterLimit);
  if (binaryOrGenerated(prefix)) return undefined;
  const split = prefix.split(/\r?\n/);
  const lines = split
    .slice(0, MAX_LINES)
    .map((line) => line.slice(0, MAX_LINE_CHARS));
  const symbols = new Map<string, number[]>();
  lines.forEach((line, index) => {
    const definition =
      /^\s*(?:(?:export|default|public|private|protected|static|async|abstract|declare)\s+)*(?:function\s*\*?|def\s+|class\s+|interface\s+|type\s+|enum\s+|fn\s+|(?:const|let|var)\s+)([\p{L}_$][\p{L}\p{N}_$]*)/u.exec(
        line,
      );
    if (!definition) return;
    const name = definition[1].toLowerCase();
    symbols.set(name, [...(symbols.get(name) ?? []), index]);
  });
  return {
    path: snapshot.path,
    version: snapshot.version,
    lines,
    symbols,
    characterLimit,
    truncated:
      snapshot.text.length > characterLimit ||
      split.length > MAX_LINES ||
      split.some((line) => line.length > MAX_LINE_CHARS),
  };
}
function normalizedFile(file: string) {
  return file.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
}

async function collectDocuments(
  adapter: WorkspaceAdapter,
  instruction: string,
  explicitFiles: string[] = [],
) {
  let listed: string[];
  try {
    listed = await adapter.listFiles();
  } catch {
    throw new Error("Unable to list workspace files for context retrieval.");
  }
  const files = [
    ...new Set(listed.filter((file) => !isExcluded(file)).map(normalizedFile)),
  ];
  for (const file of explicitFiles) {
    if (isExcluded(file))
      throw new Error("Mentioned workspace file is excluded.");
    // Adapters can expose unsaved/new files through read before directory listings update.
    if (!files.includes(file)) files.unshift(file);
  }
  const terms = words(instruction);
  const explicit = new Set(explicitFiles);
  files.sort(
    (a, b) =>
      (explicit.has(b) ? 1000 : 0) +
        lexicalScore(b, terms) * 10 -
        (explicit.has(a) ? 1000 : 0) -
        lexicalScore(a, terms) * 10 || a.localeCompare(b),
  );
  const previous = indexes.get(adapter) ?? new Map<string, IndexedDocument>();
  const next = new Map<string, IndexedDocument>();
  const documents: IndexedDocument[] = [];
  let scanned = 0;
  let attempts = 0;
  let omitted = 0;
  for (const file of files) {
    if (attempts >= MAX_FILES || scanned >= MAX_SCAN_CHARS) {
      omitted++;
      continue;
    }
    attempts++;
    let snapshot: DocumentSnapshot;
    try {
      snapshot = await adapter.read(file);
    } catch {
      if (explicit.has(file))
        throw new Error(
          `Mentioned workspace file not found or unavailable: ${file}`,
        );
      omitted++;
      continue;
    }
    const characterLimit = Math.min(MAX_FILE_CHARS, MAX_SCAN_CHARS - scanned);
    scanned += Math.min(snapshot.text.length, characterLimit);
    const cached = previous.get(file);
    // Always read the adapter version so dirty buffers invalidate this parsing cache.
    const document =
      cached?.version === snapshot.version &&
      cached.characterLimit === characterLimit
        ? cached
        : indexSnapshot({ ...snapshot, path: file }, characterLimit);
    if (!document) {
      omitted++;
      continue;
    }
    next.set(file, document);
    documents.push(document);
  }
  indexes.set(adapter, next);
  return { documents, omitted };
}

interface Candidate {
  document: IndexedDocument;
  line: number;
  score: number;
  reason: string;
  wholeFile?: boolean;
}
interface CoveredRange {
  start: number;
  end: number;
}
function snippetCost(snippet: Omit<Snippet, "tokenEstimate">): number {
  return estimateTokens(
    `${snippet.path}:${snippet.startLine}-${snippet.endLine}\n${snippet.reason}\n${snippet.text}`,
  );
}
function fitSnippet(
  candidate: Candidate,
  remaining: number,
  covered: CoveredRange[],
): Snippet | undefined {
  const { document } = candidate;
  let start = candidate.wholeFile ? 0 : Math.max(0, candidate.line - 6);
  let end = candidate.wholeFile
    ? Math.min(document.lines.length, 100)
    : Math.min(document.lines.length, candidate.line + 35);
  for (const range of covered) {
    if (range.end < candidate.line) start = Math.max(start, range.end + 1);
    if (range.start > candidate.line) end = Math.min(end, range.start);
  }
  // Prior context must never consume the entire budget before the matching line.
  while (
    start < candidate.line &&
    snippetCost({
      path: document.path,
      startLine: start + 1,
      endLine: candidate.line + 1,
      reason: candidate.reason,
      text: document.lines.slice(start, candidate.line + 1).join("\n"),
    }) > remaining
  )
    start++;
  const snippet = {
    path: document.path,
    startLine: start + 1,
    endLine: start + 1,
    text: "",
    reason: candidate.reason,
  };
  let selected: string[] = [];
  for (let index = start; index < end; index++) {
    const proposed = {
      ...snippet,
      endLine: index + 1,
      text: [...selected, document.lines[index]].join("\n"),
    };
    if (snippetCost(proposed) > remaining) break;
    selected.push(document.lines[index]);
    Object.assign(snippet, proposed);
  }
  if (!selected.length) {
    // Preserve a usable prefix of a long line without exceeding its metadata budget.
    let low = 0,
      high = document.lines[start]?.length ?? 0;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (
        snippetCost({
          ...snippet,
          text: document.lines[start].slice(0, middle),
        }) <= remaining
      )
        low = middle;
      else high = middle - 1;
    }
    if (!low) return undefined;
    snippet.text = document.lines[start].slice(0, low);
  }
  return { ...snippet, tokenEstimate: snippetCost(snippet) };
}

/** Selective context is a tool; the model still decides which tools and edits to request. */
export async function retrieveContext(
  adapter: WorkspaceAdapter,
  instruction: string,
  totalTokens = 4096,
): Promise<RetrievalResult> {
  const { inputBudget } = calculateContextBudget(totalTokens, instruction);
  if (!inputBudget)
    return { snippets: [], usedTokens: 0, inputBudget, omittedCount: 0 };
  const mentions = parseMentions(instruction);
  const explicitFiles = mentions
    .filter((mention) => mention.kind === "file")
    .map((mention) => normalizedFile(mention.value));
  const { documents, omitted } = await collectDocuments(
    adapter,
    instruction,
    explicitFiles,
  );
  const terms = words(instruction);
  const candidates: Candidate[] = [];
  for (const file of explicitFiles) {
    const document = documents.find((document) => document.path === file);
    if (document)
      candidates.push({
        document,
        line: 0,
        score: 10000,
        reason: "Explicit file mention",
        wholeFile: true,
      });
  }
  for (const mention of mentions.filter(
    (mention) => mention.kind === "symbol",
  )) {
    const symbol = mention.value
      .split(/\.|::|#/)
      .at(-1)!
      .toLowerCase();
    const definitions = documents.flatMap((document) =>
      (document.symbols.get(symbol) ?? []).map((line) => ({
        document,
        line,
        score: 9000,
        reason: `Symbol definition: ${mention.value}`,
      })),
    );
    if (definitions.length) candidates.push(...definitions);
    else
      for (const document of documents) {
        const line = document.lines.findIndex((line) =>
          line.toLowerCase().includes(mention.value.toLowerCase()),
        );
        if (line >= 0)
          candidates.push({
            document,
            line,
            score: 8000,
            reason: `Symbol text fallback: ${mention.value}`,
          });
      }
  }
  for (const document of documents) {
    const filenameScore = lexicalScore(document.path, terms);
    const lineScores = document.lines.map((line) => lexicalScore(line, terms));
    const score = filenameScore * 3 + Math.max(0, ...lineScores);
    if (!score) continue;
    const line = lineScores.indexOf(Math.max(...lineScores));
    const kind = fileKind(document.path);
    const bonus = kind === "test" || kind === "doc" ? 2 : 0;
    candidates.push({
      document,
      line: Math.max(0, line),
      score: score + bonus,
      reason:
        kind === "test"
          ? "Related tests from lexical search"
          : kind === "doc"
            ? "Related documentation from lexical search"
            : "Lexical source match",
    });
  }
  candidates.sort(
    (a, b) =>
      b.score - a.score || a.document.path.localeCompare(b.document.path),
  );
  const snippets: Snippet[] = [];
  let usedTokens = 0;
  let omittedCount = omitted;
  const covered = new Map<string, CoveredRange[]>();
  for (const candidate of candidates) {
    const ranges = covered.get(candidate.document.path) ?? [];
    // Keep separate symbols in a file while omitting windows already represented.
    if (
      ranges.some(
        (range) => candidate.line >= range.start && candidate.line <= range.end,
      )
    )
      continue;
    const snippet = fitSnippet(candidate, inputBudget - usedTokens, ranges);
    if (!snippet) {
      omittedCount++;
      continue;
    }
    snippets.push(snippet);
    covered.set(candidate.document.path, [
      ...ranges,
      { start: snippet.startLine - 1, end: snippet.endLine - 1 },
    ]);
    usedTokens += snippet.tokenEstimate;
    if (
      candidate.document.truncated ||
      snippet.endLine < candidate.document.lines.length ||
      snippet.text.length <
        candidate.document.lines
          .slice(snippet.startLine - 1, snippet.endLine)
          .join("\n").length
    )
      omittedCount++;
  }
  return { snippets, usedTokens, inputBudget, omittedCount };
}

/** Literal, bounded search; query strings are never evaluated as regular expressions. */
export async function searchWorkspace(
  adapter: WorkspaceAdapter,
  query: string,
  maxResults = 20,
): Promise<SearchResult[]> {
  if (!Number.isFinite(maxResults) || maxResults < 0)
    throw new Error("Search result limit must be a finite nonnegative number.");
  if (query.length > 512)
    throw new Error("Search query is too long (maximum 512 characters).");
  const limit = Math.min(100, Math.floor(maxResults));
  if (!query.trim() || !limit) return [];
  const { documents } = await collectDocuments(adapter, query);
  const needle = query.toLowerCase();
  const results: SearchResult[] = [];
  for (const document of documents) {
    for (let index = 0; index < document.lines.length; index++) {
      if (!document.lines[index].toLowerCase().includes(needle)) continue;
      results.push({
        path: document.path,
        line: index + 1,
        text: document.lines[index].slice(0, 240),
      });
      if (results.length === limit) return results;
    }
  }
  return results;
}
