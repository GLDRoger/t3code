import type { EnvironmentId, KinChatId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { View } from "react-native";

import { ComposerEditor } from "../../../components/ComposerEditor";
import { AppText as Text } from "../../../components/ui/AppText";
import { IconButton } from "../../../components/ui/IconButton";
import type { ComposerEditorHandle } from "../../../native/T3ComposerEditor.types";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  setComposerDraftText,
  useComposerDraft,
} from "../../../state/use-composer-drafts";
import { KIN_MESSAGE_MAX_LENGTH } from "../state/kinOutbox";
import { deliverKinOutbox, kinOutbox } from "../state/kinOutboxDelivery";

export const kinDraftKey = (orgId: string, chatId: string) => `kin:${orgId}:${chatId}`;

const lengthFormat = new Intl.NumberFormat();

/** Puts an unsent body back in the draft, ahead of anything typed since. */
function restoreDraft(draftKey: string, body: string) {
  const typed = getComposerDraftSnapshot(draftKey).text;
  setComposerDraftText(draftKey, typed.trim().length === 0 ? body : `${body}\n\n${typed}`);
}

/** Moves a refused send back into the chat's draft and drops it from the outbox. */
export async function editKinOutboxEntry(draftKey: string, clientMessageId: string) {
  const body = await kinOutbox.discard(clientMessageId);
  if (body !== null) restoreDraft(draftKey, body);
}

/**
 * The chat's text box. The draft lives in the shared composer drafts, so it survives a restart;
 * a send goes to the outbox, which shows it at once and delivers it when the host is reachable.
 * Kin sends text only, so it takes no attachments or pasted context.
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
  const [full, setFull] = useState(false);
  const length = draft.text.trim().length;
  const tooLong = length > KIN_MESSAGE_MAX_LENGTH;
  const canSend = length > 0 && !tooLong;
  const hint = tooLong
    ? `Too long to send: ${lengthFormat.format(length)} of ${lengthFormat.format(KIN_MESSAGE_MAX_LENGTH)} characters.`
    : full
      ? "Too many unsent messages. Wait for them to go out."
      : null;

  const send = async () => {
    await editorRef.current?.flushPendingInput();
    const body = getComposerDraftSnapshot(draftKey).text.trim();
    if (body.length === 0 || body.length > KIN_MESSAGE_MAX_LENGTH) return;
    clearComposerDraftContent(draftKey);
    const queued = await kinOutbox.enqueue({
      environmentId: props.environmentId,
      chatId: props.chatId,
      body,
    });
    setFull(queued._tag === "full");
    if (queued._tag !== "queued") {
      restoreDraft(draftKey, body);
      return;
    }
    props.onSend();
    await deliverKinOutbox();
  };

  return (
    <View className="gap-1 border-t border-border bg-screen px-3 pt-2 pb-3">
      {hint === null ? null : (
        <Text
          textRole="caption"
          accessibilityLiveRegion="polite"
          className="px-1 text-danger-foreground"
        >
          {hint}
        </Text>
      )}
      <View className="flex-row items-end gap-2">
        <View className="min-h-11 flex-1 justify-center rounded-[22px] bg-card-alt px-3.5 py-1.5">
          <ComposerEditor
            ref={editorRef}
            draftKey={draftKey}
            pasteContext={false}
            multiline
            value={draft.text}
            placeholder={`Message ${props.recipient}`}
            onSubmit={() => void send()}
            onChangeText={(text) => {
              if (full) setFull(false);
              setComposerDraftText(draftKey, text);
            }}
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
    </View>
  );
}
