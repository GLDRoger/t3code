import { kinAskDraft, kinReadiedDraftAtom } from "@t3tools/client-runtime/kin/kinDraft";
import { kinPendingRefAtom, kinPendingRefKey } from "@t3tools/client-runtime/kin/kinDocs";
import { kinAgentChatProblem } from "@t3tools/client-runtime/kin/kinPeopleChat";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinAgentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { kinClient } from "./kinClient";
import { kinDraftAtom, kinDraftKey } from "./kinDraft";
import { runKinCommand } from "@t3tools/client-runtime/kin/kinRunCommand";

/** Opens a Kin chat, with `draft` ready in its box when given: an Ask of its own (`kinAskDraft`). */
export function useKinOpenChat() {
  const navigate = useNavigate();
  return (environmentId: EnvironmentId, orgId: KinOrgId, chatId: KinChatId, draft?: string) => {
    if (draft !== undefined) {
      const key = kinDraftKey(environmentId, orgId, chatId);
      const atom = kinDraftAtom(key);
      const readied = kinReadiedDraftAtom(key);
      const ask = kinAskDraft(appAtomRegistry.get(atom), {
        question: draft,
        ref: null,
        readied: appAtomRegistry.get(readied),
      });
      appAtomRegistry.set(atom, ask.text);
      appAtomRegistry.set(readied, draft);
      appAtomRegistry.set(kinPendingRefAtom(kinPendingRefKey(environmentId, chatId)), ask.ref);
    }
    void navigate({
      to: "/kin/$environmentId/$orgId/$chatId",
      params: { environmentId, orgId, chatId },
    });
  };
}

/** Opens the viewer's chat with an agent, made the first time; the problem when it can't. */
export function useKinOpenAgentChat() {
  const openChat = useKinOpenChat();
  return async (
    environmentId: EnvironmentId,
    orgId: KinOrgId,
    agentId: KinAgentId,
    draft?: string,
  ) => {
    const result = await runKinCommand(appAtomRegistry, kinClient.chatWithAgent, {
      environmentId,
      input: { orgId, agentId },
    });
    if (result._tag !== "Success") return kinAgentChatProblem(squashAtomCommandFailure(result));
    openChat(environmentId, orgId, result.value.chatId, draft);
    return null;
  };
}
