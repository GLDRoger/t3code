import type { EnvironmentId, KinAgentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";

import { kinAskDraft, kinReadiedDraftAtom } from "@t3tools/client-runtime/kin/kinDraft";
import { kinPendingRefAtom, kinPendingRefKey } from "@t3tools/client-runtime/kin/kinDocs";
import { kinAgentChatProblem } from "@t3tools/client-runtime/kin/kinPeopleChat";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { appAtomRegistry } from "../../../state/atom-registry";
import { getComposerDraftSnapshot, setComposerDraftText } from "../../../state/use-composer-drafts";
import { kinDraftKey } from "./kinDraftKey";
import { kinClient } from "./kinClient";

/** Opens a Kin chat, with `draft` ready in its box when given: an Ask of its own (`kinAskDraft`). */
export function useKinOpenChat() {
  const navigation = useNavigation();
  return (environmentId: EnvironmentId, orgId: KinOrgId, chatId: KinChatId, draft?: string) => {
    if (draft !== undefined) {
      const key = kinDraftKey(environmentId, orgId, chatId);
      const readied = kinReadiedDraftAtom(key);
      const ask = kinAskDraft(getComposerDraftSnapshot(key).text, {
        question: draft,
        ref: null,
        readied: appAtomRegistry.get(readied),
      });
      setComposerDraftText(key, ask.text);
      appAtomRegistry.set(readied, draft);
      appAtomRegistry.set(kinPendingRefAtom(kinPendingRefKey(environmentId, chatId)), ask.ref);
    }
    navigation.navigate("KinChat", { environmentId, orgId, chatId });
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
    const result = await kinClient.chatWithAgent.run(appAtomRegistry, {
      environmentId,
      input: { orgId, agentId },
    });
    if (result._tag !== "Success") return kinAgentChatProblem(squashAtomCommandFailure(result));
    openChat(environmentId, orgId, result.value.chatId, draft);
    return null;
  };
}
