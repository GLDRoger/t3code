import { kinDraftKey as sharedKinDraftKey } from "@t3tools/client-runtime/kin/kinDraft";
import type { EnvironmentId } from "@t3tools/contracts";

import { KIN_DRAFT_PREFIX } from "../../../lib/composerAttachmentUploadQueue";

/** Every Kin host uses the same org id, so the environment keeps two hosts' drafts apart. */
export const kinDraftKey = (environmentId: EnvironmentId, orgId: string, chatId: string) =>
  `${KIN_DRAFT_PREFIX}${sharedKinDraftKey(environmentId, orgId, chatId)}`;
