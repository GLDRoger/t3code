import {
  isKinLeadProjectId,
  type OrchestrationV2AppThreadLineage,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

const isKinThreadId = (id: ThreadId) =>
  id.startsWith("kin:") || id.startsWith("kin-shared:") || id.startsWith("kin-dream:");

export const isPrivateKinActivity = (
  id: ThreadId,
  thread?: { readonly projectId: ProjectId; readonly lineage: OrchestrationV2AppThreadLineage },
) =>
  isKinThreadId(id) ||
  (thread !== undefined &&
    (isKinLeadProjectId(thread.projectId) ||
      thread.projectId.startsWith("kin-dream:") ||
      isKinThreadId(thread.lineage.rootThreadId) ||
      (thread.lineage.parentThreadId !== null && isKinThreadId(thread.lineage.parentThreadId))));
