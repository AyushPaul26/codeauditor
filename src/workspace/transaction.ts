import type {
  DocumentSnapshot,
  WorkspaceAdapter,
  WorkspaceChange,
} from "../contracts";
export async function prepareWorkspaceChanges(
  adapter: WorkspaceAdapter,
  changes: WorkspaceChange[],
): Promise<Array<{ change: WorkspaceChange; before: DocumentSnapshot }>> {
  const paths = new Set<string>(),
    prepared = [];
  for (const change of changes) {
    if (paths.has(change.path))
      throw new Error("Duplicate path in one workspace transaction.");
    paths.add(change.path);
    const before = await adapter.read(change.path);
    if (before.version !== change.expectedVersion)
      throw new Error(
        `Document version changed: ${change.path}. Review the conflict first.`,
      );
    prepared.push({ change, before });
  }
  if (
    prepared.length > 1 &&
    prepared.some((p) => p.before.version === "missing" || p.change.delete)
  )
    throw new Error(
      "Create/delete files in a separate, single-file proposal. Existing-file text edits can be applied together.",
    );
  return prepared;
}
