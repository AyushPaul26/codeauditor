export interface HostApprovalDecision {
  toolCallId: string;
  allow: boolean;
  reason?: string;
}
/** TrueForge resumes one turn with ALL of that turn's pending decisions. */
export function completeApprovalBatch(
  pending: ReadonlyArray<{ toolCallId: string }>,
  decisions: ReadonlyMap<string, HostApprovalDecision>,
): HostApprovalDecision[] | undefined {
  if (!pending.length || pending.some((p) => !decisions.has(p.toolCallId)))
    return undefined;
  return pending.map((p) => decisions.get(p.toolCallId)!);
}
