/** Relative workspace paths are validated at the IO boundary, including realpath. */
export interface DocumentSnapshot {
  path: string;
  text: string;
  /** Content/version identity; 'missing' is reserved for a file that does not exist. */
  version: string;
}
export interface WorkspaceChange {
  path: string;
  text: string;
  expectedVersion: string;
  delete?: boolean;
}
export interface WorkspaceAdapter {
  readonly root: string;
  listFiles(): Promise<string[]>;
  read(path: string): Promise<DocumentSnapshot>;
  /** Compare every version first, then apply all edits as one workspace operation. */
  apply(edits: WorkspaceChange[], preCommit?: () => void): Promise<void>;
}
