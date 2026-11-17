import type { EnvironmentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";

import { setComposerDraftText } from "../../../state/use-composer-drafts";
import { kinDraftKey } from "../components/KinComposer";

/** Opens a Kin chat, with `draft` ready in its box when given. */
export function useKinOpenChat() {
  const navigation = useNavigation();
  return (environmentId: EnvironmentId, orgId: KinOrgId, chatId: KinChatId, draft?: string) => {
    if (draft !== undefined) setComposerDraftText(kinDraftKey(environmentId, orgId, chatId), draft);
    navigation.navigate("KinChat", { environmentId, orgId, chatId });
  };
}
