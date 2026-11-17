import { kinAskDraft } from "@t3tools/client-runtime/kin/kinDraft";
import { kinPendingRefAtom, kinPendingRefKey } from "@t3tools/client-runtime/kin/kinDocs";
import type { EnvironmentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { kinDraftAtom, kinDraftKey } from "./kinDraft";

/** Opens a Kin chat, with `draft` ready in its box when given: an Ask of its own (`kinAskDraft`). */
export function useKinOpenChat() {
  const navigate = useNavigate();
  return (environmentId: EnvironmentId, orgId: KinOrgId, chatId: KinChatId, draft?: string) => {
    if (draft !== undefined) {
      const atom = kinDraftAtom(kinDraftKey(environmentId, orgId, chatId));
      const ask = kinAskDraft(appAtomRegistry.get(atom), { question: draft, ref: null });
      appAtomRegistry.set(atom, ask.text);
      appAtomRegistry.set(kinPendingRefAtom(kinPendingRefKey(environmentId, chatId)), ask.ref);
    }
    void navigate({
      to: "/kin/$environmentId/$orgId/$chatId",
      params: { environmentId, orgId, chatId },
    });
  };
}
