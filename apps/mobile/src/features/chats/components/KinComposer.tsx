import type { EnvironmentId, KinChatId } from "@t3tools/contracts";
import { useRef } from "react";
import { View } from "react-native";

import { ComposerEditor } from "../../../components/ComposerEditor";
import { IconButton } from "../../../components/ui/IconButton";
import type { ComposerEditorHandle } from "../../../native/T3ComposerEditor.types";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  setComposerDraftText,
  useComposerDraft,
} from "../../../state/use-composer-drafts";
import { deliverKinOutbox, kinOutbox } from "../state/kinOutboxDelivery";

export const kinDraftKey = (orgId: string, chatId: string) => `kin:${orgId}:${chatId}`;

/**
 * The chat's text box. The draft lives in the shared composer drafts, so it survives a restart;
 * a send goes to the outbox, which shows it at once and delivers it when the host is reachable.
 */
export function KinComposer(props: {
  readonly orgId: string;
  readonly chatId: KinChatId;
  readonly environmentId: EnvironmentId;
  readonly recipient: string;
  /** Called once the message is in the outbox, so the feed can show the end. */
  readonly onSend: () => void;
}) {
  const draftKey = kinDraftKey(props.orgId, props.chatId);
  const draft = useComposerDraft(draftKey);
  const editorRef = useRef<ComposerEditorHandle>(null);
  const canSend = draft.text.trim().length > 0;

  const send = async () => {
    await editorRef.current?.flushPendingInput();
    const body = getComposerDraftSnapshot(draftKey).text.trim();
    if (body.length === 0) return;
    clearComposerDraftContent(draftKey);
    await kinOutbox.enqueue({ environmentId: props.environmentId, chatId: props.chatId, body });
    props.onSend();
    await deliverKinOutbox();
  };

  return (
    <View className="flex-row items-end gap-2 border-t border-border bg-screen px-3 pt-2 pb-3">
      <View className="min-h-11 flex-1 justify-center rounded-[22px] bg-card-alt px-3.5 py-1.5">
        <ComposerEditor
          ref={editorRef}
          draftKey={draftKey}
          environmentId={props.environmentId}
          multiline
          value={draft.text}
          placeholder={`Message ${props.recipient}`}
          onSubmit={() => void send()}
          onChangeText={(text) => setComposerDraftText(draftKey, text)}
          style={{ maxHeight: 140 }}
        />
      </View>
      <IconButton
        variant="primary"
        icon="arrow.up"
        accessibilityLabel="Send"
        disabled={!canSend}
        onPress={() => void send()}
      />
    </View>
  );
}
