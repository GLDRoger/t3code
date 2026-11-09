import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, KinChatId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Platform, View } from "react-native";

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

/** Every Kin host uses the same org id, so the environment keeps two hosts' drafts apart. */
export const kinDraftKey = (environmentId: EnvironmentId, orgId: string, chatId: string) =>
  `kin:${environmentId}:${orgId}:${chatId}`;

// The native editor has no intrinsic height: it grows with its text from one line to this cap.
const EDITOR_MIN_HEIGHT = 36;
const EDITOR_MAX_HEIGHT = 140;
const EDITOR_INSET = 6;

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
  const draftKey = kinDraftKey(props.environmentId, props.orgId, props.chatId);
  const draft = useComposerDraft(draftKey);
  const editorRef = useRef<ComposerEditorHandle>(null);
  const full = useAtomValue(kinOutbox.fullAtom(props.environmentId));
  const [contentHeight, setContentHeight] = useState(0);
  const editorHeight = Math.min(
    EDITOR_MAX_HEIGHT,
    Math.max(EDITOR_MIN_HEIGHT, Math.ceil(contentHeight) + 2 * EDITOR_INSET),
  );
  const length = draft.text.trim().length;
  const tooLong = length > KIN_MESSAGE_MAX_LENGTH;
  const canSend = length > 0 && !tooLong && !full;
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
        <View className="min-h-11 flex-1 justify-center rounded-[22px] border border-composer-border bg-composer-surface px-3.5 py-1">
          <ComposerEditor
            ref={editorRef}
            draftKey={draftKey}
            pasteContext={false}
            multiline
            value={draft.text}
            placeholder={`Message ${props.recipient}`}
            onSubmit={() => void send()}
            onChangeText={(text) => setComposerDraftText(draftKey, text)}
            contentInsetVertical={EDITOR_INSET}
            singleLineCentered={contentHeight <= EDITOR_MIN_HEIGHT - 2 * EDITOR_INSET}
            scrollEnabled={Platform.OS === "android" || editorHeight >= EDITOR_MAX_HEIGHT}
            onContentSizeChange={(size) => setContentHeight(size.height)}
            style={{ height: editorHeight }}
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
