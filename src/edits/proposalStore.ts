import { createHash, randomUUID } from "node:crypto";
import type {
  DocumentSnapshot,
  WorkspaceAdapter,
  WorkspaceChange,
} from "../contracts";

export type ReviewDecision = "accept" | "reject";
export type ProposalStatus = "pending" | "reviewed" | "applied" | "cancelled";

export interface ProposedChange {
  path: string;
  oldText: string;
  newText: string;
}

export interface ProposedHunk {
  readonly id: string;
  readonly path: string;
  readonly before: string;
  readonly after: string;
  /** Offsets in the original document, never in a partially accepted result. */
  readonly start: number;
  readonly end: number;
}

export interface Proposal {
  readonly id: string;
  readonly runId: string;
  readonly status: ProposalStatus;
  readonly hunks: readonly ProposedHunk[];
  readonly baseVersions: Readonly<Record<string, string>>;
}

export interface ApplyResult {
  readonly proposalId: string;
  readonly acceptedIds: readonly string[];
  readonly rejectedIds: readonly string[];
  readonly paths: readonly string[];
}

interface StoredProposal {
  proposal: Proposal;
  bases: Map<string, DocumentSnapshot>;
  /** This state is created only by the host review method; it is never accepted as tool input. */
  review?: ReadonlyMap<string, ReviewDecision>;
}

interface UndoEntry {
  before: Map<string, DocumentSnapshot>;
  after: Map<string, DocumentSnapshot>;
}

/** Stage and review edits independently of the editor and model transport. */
export class ProposalStore {
  private readonly proposals = new Map<string, StoredProposal>();
  private readonly cancelledRuns = new Set<string>();
  private readonly undoEntries: UndoEntry[] = [];
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly adapter: WorkspaceAdapter) {}

  async stage(runId: string, changes: ProposedChange[]): Promise<Proposal> {
    this.assertRunActive(runId);
    if (!runId || !Array.isArray(changes) || !changes.length)
      throw new Error("A run and nonempty changes are required");
    const bases = new Map<string, DocumentSnapshot>();
    const hunks: ProposedHunk[] = [];
    for (const change of changes) {
      if (
        !change ||
        typeof change.oldText !== "string" ||
        typeof change.newText !== "string"
      )
        throw new Error("Changes require exact oldText and newText strings");
      const path = safePath(change.path);
      let base = bases.get(path);
      if (!base) {
        base = await this.readSnapshot(path);
        bases.set(path, base);
      }
      this.assertRunActive(runId);
      const newText = preserveEol(change.newText, base.text);
      if (!change.oldText) {
        if (base.version !== "missing")
          throw new Error(
            "Empty oldText can only create a file that does not exist",
          );
        if (!newText) throw new Error("A new file must have nonempty content");
        hunks.push(makeHunk(path, "", newText, 0, 0));
        continue;
      }
      if (base.version === "missing")
        throw new Error(`No matching context: ${path} does not exist`);
      const start = base.text.indexOf(change.oldText);
      if (start === -1)
        throw new Error(`Exact oldText context did not match ${path}`);
      if (base.text.indexOf(change.oldText, start + 1) !== -1)
        throw new Error(`oldText context must be unique in ${path}`);
      if (change.oldText === newText)
        throw new Error("A proposal must change document content");
      if (change.oldText === base.text) {
        hunks.push(...lineHunks(path, change.oldText, newText));
      } else {
        hunks.push(
          makeHunk(
            path,
            change.oldText,
            newText,
            start,
            start + change.oldText.length,
          ),
        );
      }
    }
    assertDisjoint(hunks);
    const activeHunks: ProposedHunk[] = [...hunks];
    for (const entry of this.proposals.values()) {
      if (
        entry.proposal.runId !== runId ||
        (entry.proposal.status !== "pending" &&
          entry.proposal.status !== "reviewed")
      )
        continue;
      for (const hunk of entry.proposal.hunks) {
        if (bases.has(hunk.path) && entry.review?.get(hunk.id) !== "reject")
          activeHunks.push(hunk);
      }
    }
    assertDisjoint(activeHunks);
    this.assertRunActive(runId);
    const baseVersions = Object.fromEntries(
      [...bases].map(([path, base]) => [path, base.version]),
    );
    const proposal: Proposal = Object.freeze({
      id: randomUUID(),
      runId,
      status: "pending",
      hunks: Object.freeze(hunks),
      baseVersions: Object.freeze(baseVersions),
    });
    this.proposals.set(proposal.id, { proposal, bases });
    return proposal;
  }

  /** Call only from the trusted host review UI, never from model tool arguments. */
  review(proposalId: string, decisions: Record<string, ReviewDecision>): void {
    const entry = this.requireProposal(proposalId);
    this.assertApplicable(entry);
    if (!decisions || typeof decisions !== "object")
      throw new Error("A complete review is required");
    const hunkIds = new Set(entry.proposal.hunks.map((hunk) => hunk.id));
    for (const id of Object.keys(decisions)) {
      if (!hunkIds.has(id))
        throw new Error("Review contains an unknown hunk ID");
    }
    const receipt = new Map<string, ReviewDecision>();
    for (const id of hunkIds) {
      if (!Object.hasOwn(decisions, id))
        throw new Error("A complete review is required: missing hunk decision");
      const decision = decisions[id];
      if (decision !== "accept" && decision !== "reject")
        throw new Error(
          "Every hunk requires an accept or reject review decision",
        );
      receipt.set(id, decision);
    }
    entry.review = receipt;
    this.setStatus(entry, "reviewed");
  }

  async apply(proposalId: string): Promise<ApplyResult> {
    return this.exclusive(async () => {
      const entry = this.requireProposal(proposalId);
      this.assertApplicable(entry);
      const review = entry.review;
      if (!review || entry.proposal.status !== "reviewed")
        throw new Error(
          "Proposal requires a complete host review before apply",
        );
      const assertCurrentApproval = () => {
        this.assertApplicable(entry);
        if (entry.review !== review)
          throw new Error("Host review changed during apply; review again");
      };
      for (const [path, base] of entry.bases)
        await this.assertCurrent(path, base);
      assertCurrentApproval();
      const accepted = entry.proposal.hunks.filter(
        (hunk) => review.get(hunk.id) === "accept",
      );
      const rejected = entry.proposal.hunks.filter(
        (hunk) => review.get(hunk.id) === "reject",
      );
      const changes = composeChanges(entry.bases, accepted);
      const before = new Map<string, DocumentSnapshot>();
      for (const change of changes)
        before.set(change.path, entry.bases.get(change.path)!);
      if (changes.length) {
        // Recheck approval after the adapter's async version checks, immediately
        // before its atomic commit. Cancellation after that point cannot undo a commit.
        await this.adapter.apply(changes, assertCurrentApproval);
        const after = new Map<string, DocumentSnapshot>();
        for (const change of changes) {
          const snapshot = await this.readSnapshot(change.path);
          // A later user edit must never become part of the undo base.
          if (snapshot.text !== change.text || snapshot.version === "missing") {
            this.setStatus(entry, "applied");
            throw new Error(
              "Changes applied, but a later document change prevents safe undo",
            );
          }
          after.set(change.path, snapshot);
        }
        this.undoEntries.push({ before, after });
      }
      this.setStatus(entry, "applied");
      entry.review = undefined;
      return Object.freeze({
        proposalId,
        acceptedIds: Object.freeze(accepted.map((hunk) => hunk.id)),
        rejectedIds: Object.freeze(rejected.map((hunk) => hunk.id)),
        paths: Object.freeze(changes.map((change) => change.path)),
      });
    });
  }

  cancelRun(runId: string): void {
    this.cancelledRuns.add(runId);
    for (const entry of this.proposals.values()) {
      if (
        entry.proposal.runId === runId &&
        entry.proposal.status !== "applied"
      ) {
        entry.review = undefined;
        this.setStatus(entry, "cancelled");
      }
    }
  }

  async undoLast(): Promise<void> {
    return this.exclusive(async () => {
      const entry = this.undoEntries.at(-1);
      if (!entry) throw new Error("No applied change is available to undo");
      for (const [path, after] of entry.after)
        await this.assertCurrent(path, after);
      const changes: WorkspaceChange[] = [...entry.before].map(
        ([path, before]) => ({
          path,
          text: before.text,
          expectedVersion: entry.after.get(path)!.version,
          ...(before.version === "missing" ? { delete: true } : {}),
        }),
      );
      await this.adapter.apply(changes);
      this.undoEntries.pop();
      // Undo itself changes version identities. Refresh a preceding undo only when its
      // exact expected text has been restored, so sequential undo stays safe.
      const previous = this.undoEntries.at(-1);
      if (previous) {
        for (const path of changes.map((change) => change.path)) {
          const expected = previous.after.get(path);
          if (!expected) continue;
          const current = await this.readSnapshot(path);
          if (current.text === expected.text) previous.after.set(path, current);
        }
      }
    });
  }

  get(id: string): Proposal | undefined {
    return this.proposals.get(id)?.proposal;
  }

  list(runId?: string): Proposal[] {
    return [...this.proposals.values()]
      .map((entry) => entry.proposal)
      .filter((proposal) => runId === undefined || proposal.runId === runId);
  }

  async readOverlay(path: string, runId?: string): Promise<DocumentSnapshot> {
    path = safePath(path);
    const base = await this.readSnapshot(path);
    let text = base.text;
    const occupied: ProposedHunk[] = [];
    for (const entry of this.proposals.values()) {
      const proposal = entry.proposal;
      if (runId !== undefined && proposal.runId !== runId) continue;
      if (proposal.status !== "pending" && proposal.status !== "reviewed")
        continue;
      const stagedBase = entry.bases.get(path);
      if (!stagedBase) continue;
      if (stagedBase.version !== base.version || stagedBase.text !== base.text)
        throw new Error(`Stale proposal overlay for ${path}`);
      for (const hunk of proposal.hunks) {
        if (hunk.path === path && entry.review?.get(hunk.id) !== "reject")
          occupied.push(hunk);
      }
    }
    assertDisjoint(occupied);
    for (const hunk of [...occupied].sort(
      (left, right) => right.start - left.start,
    ))
      text = text.slice(0, hunk.start) + hunk.after + text.slice(hunk.end);
    const version = occupied.length
      ? `overlay:${createHash("sha256").update(base.version).update("\0").update(text).digest("hex")}`
      : base.version;
    return { path, text, version };
  }

  private assertRunActive(runId: string): void {
    if (this.cancelledRuns.has(runId))
      throw new Error("Run has been cancelled");
  }

  private requireProposal(id: string): StoredProposal {
    const entry = this.proposals.get(id);
    if (!entry) throw new Error("Unknown proposal ID");
    return entry;
  }

  private assertApplicable(entry: StoredProposal): void {
    this.assertRunActive(entry.proposal.runId);
    if (entry.proposal.status === "cancelled")
      throw new Error("Proposal has been cancelled");
    if (entry.proposal.status === "applied")
      throw new Error("Proposal has already been applied; replay rejected");
  }

  private setStatus(entry: StoredProposal, status: ProposalStatus): void {
    entry.proposal = Object.freeze({ ...entry.proposal, status });
  }

  private async readSnapshot(path: string): Promise<DocumentSnapshot> {
    try {
      return { ...(await this.adapter.read(path)), path };
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      )
        return { path, text: "", version: "missing" };
      throw error;
    }
  }

  private async assertCurrent(
    path: string,
    expected: DocumentSnapshot,
  ): Promise<void> {
    const current = await this.readSnapshot(path);
    if (current.version !== expected.version || current.text !== expected.text)
      throw new Error(`Stale document version conflict for ${path}`);
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operation;
    let release!: () => void;
    this.operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function safePath(input: string): string {
  if (typeof input !== "string" || !input || /[\0\r\n:]/u.test(input))
    throw new Error("Invalid workspace path");
  const path = input.replaceAll("\\", "/");
  if (
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Path must be relative and stay inside the workspace");
  return path;
}

function preserveEol(text: string, original: string): string {
  return original.includes("\r\n") ? text.replace(/\r?\n/gu, "\r\n") : text;
}

function makeHunk(
  path: string,
  before: string,
  after: string,
  start: number,
  end: number,
): ProposedHunk {
  return Object.freeze({ id: randomUUID(), path, before, after, start, end });
}

function assertDisjoint(hunks: readonly ProposedHunk[]): void {
  const sorted = [...hunks].sort(
    (left, right) =>
      left.path.localeCompare(right.path) || left.start - right.start,
  );
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (
      previous.path === current.path &&
      (previous.end > current.start || previous.start === current.start)
    )
      throw new Error("Overlapping staged hunks cannot be applied safely");
  }
}

function composeChanges(
  bases: Map<string, DocumentSnapshot>,
  hunks: readonly ProposedHunk[],
): WorkspaceChange[] {
  const grouped = new Map<string, ProposedHunk[]>();
  for (const hunk of hunks)
    grouped.set(hunk.path, [...(grouped.get(hunk.path) ?? []), hunk]);
  return [...grouped].map(([path, fileHunks]) => {
    const base = bases.get(path)!;
    let text = base.text;
    for (const hunk of fileHunks.sort(
      (left, right) => right.start - left.start,
    ))
      text = text.slice(0, hunk.start) + hunk.after + text.slice(hunk.end);
    return { path, text, expectedVersion: base.version };
  });
}

/** Line LCS gives independently reviewable edits while retaining original newline bytes. */
function lineHunks(
  path: string,
  before: string,
  after: string,
): ProposedHunk[] {
  const left = before.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  const right = after.match(/[^\n]*\n|[^\n]+$/gu) ?? [];
  // Bound memory for large generated replacements. Retain shared prefix/suffix.
  if (left.length * right.length > 1_000_000) {
    let start = 0;
    while (
      start < left.length &&
      start < right.length &&
      left[start] === right[start]
    )
      start++;
    let leftEnd = left.length;
    let rightEnd = right.length;
    while (
      leftEnd > start &&
      rightEnd > start &&
      left[leftEnd - 1] === right[rightEnd - 1]
    ) {
      leftEnd--;
      rightEnd--;
    }
    const offset = left.slice(0, start).join("").length;
    const oldText = left.slice(start, leftEnd).join("");
    return [
      makeHunk(
        path,
        oldText,
        right.slice(start, rightEnd).join(""),
        offset,
        offset + oldText.length,
      ),
    ];
  }
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--)
      table[i * width + j] =
        left[i] === right[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  }
  const hunks: ProposedHunk[] = [];
  let i = 0;
  let j = 0;
  let offset = 0;
  let start = 0;
  let oldText = "";
  let newText = "";
  const flush = () => {
    if (oldText || newText)
      hunks.push(
        makeHunk(path, oldText, newText, start, start + oldText.length),
      );
    oldText = "";
    newText = "";
  };
  while (i < left.length || j < right.length) {
    if (i < left.length && j < right.length && left[i] === right[j]) {
      flush();
      offset += left[i]!.length;
      i++;
      j++;
    } else {
      if (!oldText && !newText) start = offset;
      if (
        i < left.length &&
        (j === right.length ||
          table[(i + 1) * width + j]! >= table[i * width + j + 1]!)
      ) {
        oldText += left[i]!;
        offset += left[i]!.length;
        i++;
      } else {
        newText += right[j]!;
        j++;
      }
    }
  }
  flush();
  return hunks;
}
