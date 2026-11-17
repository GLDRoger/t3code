import type { EnvironmentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";

import { kinAskDraft } from "@t3tools/client-runtime/kin/kinDraft";
import { kinPendingRefAtom, kinPendingRefKey } from "@t3tools/client-runtime/kin/kinDocs";

import { appAtomRegistry } from "../../../state/atom-registry";
import { getComposerDraftSnapshot, setComposerDraftText } from "../../../state/use-composer-drafts";
import { kinDraftKey } from "../components/KinComposer";

/** Opens a Kin chat, with `draft` ready in its box when given: an Ask of its own (`kinAskDraft`). */
export function useKinOpenChat() {
  const navigation = useNavigation();
  return (environmentId: EnvironmentId, orgId: KinOrgId, chatId: KinChatId, draft?: string) => {
    if (draft !== undefined) {
      const key = kinDraftKey(environmentId, orgId, chatId);
      const ask = kinAskDraft(getComposerDraftSnapshot(key).text, { question: draft, ref: null });
      setComposerDraftText(key, ask.text);
      appAtomRegistry.set(kinPendingRefAtom(kinPendingRefKey(environmentId, chatId)), ask.ref);
    }
    navigation.navigate("KinChat", { environmentId, orgId, chatId });
  };
}
