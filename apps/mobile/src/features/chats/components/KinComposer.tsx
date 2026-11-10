import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, KinChatId } from "@t3tools/contracts";
import { useState, type RefObject } from "react";
import { Platform, View } from "react-native";

import { ComposerEditor, type ComposerEditorSelection } from "../../../components/ComposerEditor";
import { AppText as Text } from "../../../components/ui/AppText";
import { useDeviceType } from "../../../native/native-layout-metrics";
import { useSidebarWorkspaceTabs } from "../../layout/workspace/useSystemWorkspaceTabBar";
import { useComposerTextRole } from "../../settings/appearance/useScaledTextRole";
import type { ComposerSendPresentation } from "../../threads/composerSendPresentation";
import { ComposerSurface, SendActionButton } from "../../threads/ThreadComposer";
import type { ComposerEditorHandle } from "../../../native/T3ComposerEditor.types";
import { appAtomRegistry } from "../../../state/atom-registry";
import {
  ComposerDictationCancelAction,
  ComposerDictationError,
  ComposerDictationPrimaryAction,
  ComposerDictationStartAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../../voice-input/voiceInputPresentation";
import {
  clearComposerDraftContent,
  composerDraftsAtom,
  getComposerDraftSnapshot,
  setComposerDraftText,
  useComposerDraft,
} from "../../../state/use-composer-drafts";
import { KIN_MESSAGE_MAX_LENGTH } from "@t3tools/client-runtime/kin/kinOutbox";
import { deliverKinOutbox, kinOutbox } from "../state/kinOutboxDelivery";

/** Every Kin host uses the same org id, so the environment keeps two hosts' drafts apart. */
export const kinDraftKey = (environmentId: EnvironmentId, orgId: string, chatId: string) =>
  `kin:${environmentId}:${orgId}:${chatId}`;

// The native editor has no intrinsic height: it grows with its text from one line to four.
// iOS reports at most four lines of content, so a taller cap would never turn scrolling on.
const EDITOR_MIN_HEIGHT = 36;
const EDITOR_MAX_LINES = 4;
const EDITOR_INSET = 6;

const lengthFormat = new Intl.NumberFormat();

/** The space under the Send row while the keyboard is up, and the least it gets without one. */
export const KIN_COMPOSER_GUTTER = 12;
/** The composer's height above `bottomInset` with one line and no hint, until it's measured. */
export const KIN_COMPOSER_COLLAPSED_HEIGHT = 54;

const KIN_SEND: ComposerSendPresentation = {
  label: "Send",
  icon: "arrow.up",
  action: null,
  alternate: null,
  offersFollowUpChoice: false,
};

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
 * Kin sends text only, so it takes no attachments or pasted context; dictation types into it.
 */
export function KinComposer(props: {
  readonly orgId: string;
  readonly chatId: KinChatId;
  readonly environmentId: EnvironmentId;
  readonly recipient: string;
  /** Space under the Send row: the bottom safe area, at least `KIN_COMPOSER_GUTTER`. */
  readonly bottomInset: number;
  /** Called once the message is in the outbox, so the feed can show the end. */
  readonly onSend: () => void;
  readonly onFocusChange?: (focused: boolean) => void;
  /** Owned by the feed, so it can focus the editor after filling the draft. */
  readonly editorRef: RefObject<ComposerEditorHandle | null>;
}) {
  const draftKey = kinDraftKey(props.environmentId, props.orgId, props.chatId);
  const draft = useComposerDraft(draftKey);
  const { editorRef } = props;
  const full = useAtomValue(kinOutbox.fullAtom(props.environmentId));
  const [contentHeight, setContentHeight] = useState(0);
  const { lineHeight } = useComposerTextRole();
  // The thread composer's sizing: larger controls on iPad and with the sidebar's tab picker.
  const deviceType = useDeviceType();
  const largeControls = useSidebarWorkspaceTabs() === "picker" || deviceType === "pad";
  const maxContentHeight = lineHeight * EDITOR_MAX_LINES;
  const editorHeight = Math.max(
    EDITOR_MIN_HEIGHT,
    Math.ceil(Math.min(maxContentHeight, contentHeight)) + 2 * EDITOR_INSET,
  );
  const [selection, setSelection] = useState<ComposerEditorSelection>({ start: 0, end: 0 });
  // T3's dictation: it writes into this chat's draft at the cursor, as in the thread composer.
  const voice = useVoiceInputController({
    ownerKey: draftKey,
    label: props.recipient,
    readDraftMessage: () => getComposerDraftSnapshot(draftKey).text,
    subscribeToDraftChanges: (onChange) => appAtomRegistry.subscribe(composerDraftsAtom, onChange),
    selection,
    onChangeDraftMessage: (text) => setComposerDraftText(draftKey, text),
    onChangeSelection: setSelection,
  });
  const voicePresentation = resolveVoiceComposerPresentation(voice.state, voice.elapsedSeconds);
  const showsDictation = voicePresentation.statusKind === "active";
  const controlSize = largeControls ? "large" : "regular";
  const length = draft.text.trim().length;
  const tooLong = length > KIN_MESSAGE_MAX_LENGTH;
  const canSend = length > 0 && !tooLong && !full && !voice.blocksSubmission;
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
    <View className="gap-1 px-3 pt-1.5" style={{ paddingBottom: props.bottomInset }}>
      {/* As under the thread composer: the feed fades out behind the pill. */}
      <View
        className={
          Platform.OS === "android"
            ? "absolute inset-0 bg-screen"
            : "absolute inset-0 bg-linear-to-b from-screen/0 via-screen/60 to-screen/90"
        }
        pointerEvents="none"
      />
      {hint === null ? null : (
        <Text
          textRole="caption"
          accessibilityLiveRegion="polite"
          className="px-1 text-danger-foreground"
        >
          {hint}
        </Text>
      )}
      <ComposerSurface
        animateLayout={false}
        style={{
          borderRadius: largeControls ? 31 : 27,
          borderCurve: "circular",
          overflow: "hidden",
          paddingVertical: largeControls ? 9 : 2,
        }}
      >
        <ComposerDictationError
          error={voice.state.phase === "error" ? voice.state.error : null}
          onDismiss={voice.cancel}
        />
        {showsDictation ? (
          <ComposerDictationToolbar showsDictation>
            <View className="min-h-11 flex-row items-center">
              <ComposerDictationCancelAction
                size={controlSize}
                presentation={voicePresentation}
                onCancel={voice.cancel}
              />
              <ComposerDictationStatus
                audioLevels={voice.audioLevels}
                elapsedSeconds={voice.elapsedSeconds}
                phase={voice.state.phase}
                presentation={voicePresentation}
              />
              <ComposerDictationPrimaryAction
                size={controlSize}
                state={voice.state}
                presentation={voicePresentation}
                isAvailable={voice.isAvailable}
                onStart={voice.start}
                onConfirm={voice.stop}
                onCancel={voice.cancel}
              />
            </View>
          </ComposerDictationToolbar>
        ) : (
          <View className="flex-row items-end">
            <View className="min-h-11 flex-1 justify-center py-1 pl-4">
              <ComposerEditor
                ref={editorRef}
                draftKey={draftKey}
                pasteContext={false}
                multiline
                value={draft.text}
                placeholder={`Message ${props.recipient}`}
                readOnly={voice.freezesEditor}
                selection={selection}
                onSelectionChange={setSelection}
                onSubmit={() => void send()}
                onChangeText={(text) => setComposerDraftText(draftKey, text)}
                onFocus={() => props.onFocusChange?.(true)}
                onBlur={() => props.onFocusChange?.(false)}
                contentInsetVertical={EDITOR_INSET}
                singleLineCentered={
                  contentHeight <= Math.max(EDITOR_MIN_HEIGHT - 2 * EDITOR_INSET, lineHeight)
                }
                scrollEnabled={Platform.OS === "android" || contentHeight >= maxContentHeight}
                onContentSizeChange={(size) => setContentHeight(size.height)}
                style={{ height: editorHeight }}
              />
            </View>
            <ComposerDictationStartAction
              size={controlSize}
              state={voice.state}
              isAvailable={voice.isAvailable}
              onStart={voice.start}
              onCancel={voice.cancel}
            />
            <SendActionButton
              size={controlSize}
              accessibilityLabel={hint ?? "Send"}
              presentation={KIN_SEND}
              disabled={!canSend}
              onSend={() => void send()}
            />
          </View>
        )}
      </ComposerSurface>
    </View>
  );
}
