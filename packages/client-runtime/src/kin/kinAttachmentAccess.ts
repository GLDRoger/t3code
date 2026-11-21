import {
  AuthKinChatScope,
  AuthOrchestrationOperateScope,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";

/**
 * Whether a session may upload attachments: one that operates threads, or a Kin teammate's
 * chat-only session, which its host lets ask for upload URLs.
 */
export const mayUploadAttachments = (hasScope: (scope: AuthEnvironmentScope) => boolean) =>
  hasScope(AuthOrchestrationOperateScope) || hasScope(AuthKinChatScope);
