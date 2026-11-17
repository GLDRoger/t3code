import type { EnvironmentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { prefillKinDraft } from "./kinDraft";

/** Opens a Kin chat, with `draft` ready in its box when given. */
export function useKinOpenChat() {
  const navigate = useNavigate();
  return (environmentId: EnvironmentId, orgId: KinOrgId, chatId: KinChatId, draft?: string) => {
    if (draft !== undefined) prefillKinDraft(environmentId, orgId, chatId, draft);
    void navigate({
      to: "/kin/$environmentId/$orgId/$chatId",
      params: { environmentId, orgId, chatId },
    });
  };
}
