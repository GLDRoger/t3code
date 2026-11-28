import type { EnvironmentId, KinAgentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";

import { KIN_BILLS } from "@t3tools/client-runtime/kin/kinBills";
import {
  kinAskDraft,
  kinPickPhotosAtom,
  kinReadiedDraftAtom,
} from "@t3tools/client-runtime/kin/kinDraft";
import { kinPendingRefAtom, kinPendingRefKey } from "@t3tools/client-runtime/kin/kinDocs";
import { kinAgentChatProblem } from "@t3tools/client-runtime/kin/kinPeopleChat";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import type { DraftComposerAttachment } from "../../../lib/composerImages";
import { appAtomRegistry } from "../../../state/atom-registry";
import {
  appendComposerDraftAttachments,
  getComposerDraftSnapshot,
  setComposerDraftText,
} from "../../../state/use-composer-drafts";
import { kinDraftKey } from "./kinDraftKey";
import { kinClient } from "./kinClient";
import { runKinCommand } from "@t3tools/client-runtime/kin/kinRunCommand";

/** Readies `draft` in a chat's box as an Ask of its own (`kinAskDraft`). */
function readyDraft(
  environmentId: EnvironmentId,
  orgId: KinOrgId,
  chatId: KinChatId,
  draft: string,
) {
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
  return key;
}

/** Opens a Kin chat, with `draft` ready in its box when given: an Ask of its own (`kinAskDraft`). */
export function useKinOpenChat() {
  const navigation = useNavigation();
  return (environmentId: EnvironmentId, orgId: KinOrgId, chatId: KinChatId, draft?: string) => {
    if (draft !== undefined) readyDraft(environmentId, orgId, chatId, draft);
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
    const result = await runKinCommand(appAtomRegistry, kinClient.chatWithAgent, {
      environmentId,
      input: { orgId, agentId },
    });
    if (result._tag !== "Success") return kinAgentChatProblem(squashAtomCommandFailure(result));
    openChat(environmentId, orgId, result.value.chatId, draft);
    return null;
  };
}

/**
 * Adding bills: the viewer's chat with the agent that reads them, made the first time, with
 * "Bills to add" in its box. Files shared into Kin go in the box; else the photo picker opens
 * there. Nothing is sent until the person sends it.
 */
export function useKinOpenBillsChat() {
  const navigation = useNavigation();
  return async (
    environmentId: EnvironmentId,
    orgId: KinOrgId,
    agentId: KinAgentId,
    options: {
      readonly attachments?: ReadonlyArray<DraftComposerAttachment>;
      /** In place of the screen that opened it, as a shared file's landing. */
      readonly replace?: boolean;
    } = {},
  ) => {
    const result = await runKinCommand(appAtomRegistry, kinClient.chatWithAgent, {
      environmentId,
      input: { orgId, agentId },
    });
    if (result._tag !== "Success") return kinAgentChatProblem(squashAtomCommandFailure(result));
    const { chatId } = result.value;
    const key = readyDraft(environmentId, orgId, chatId, KIN_BILLS.composer);
    const attachments = options.attachments ?? [];
    if (attachments.length > 0) appendComposerDraftAttachments(key, attachments);
    else appAtomRegistry.set(kinPickPhotosAtom(key), true);
    const params = { environmentId, orgId, chatId };
    if (options.replace === true) navigation.dispatch(StackActions.replace("KinChat", params));
    else navigation.navigate("KinChat", params);
    return null;
  };
}
