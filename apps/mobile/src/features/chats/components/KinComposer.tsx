import { useAtomValue } from "@effect/atom-react";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type KinAttachment,
  type KinChatId,
} from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { useImperativeHandle, useState, type Ref, type RefObject } from "react";
import { Platform, View } from "react-native";

import { ComposerAttachmentStrip } from "../../../components/ComposerAttachmentStrip";
import * as Dialog from "../../../components/ui/Dialog";
import { FilePreviewModal, type FilePreviewSource } from "../../../components/ui/FilePreviewModal";
import {
  VideoPreviewModal,
  type VideoPreviewSource,
} from "../../../components/ui/VideoPreviewModal";
import { prepareTurnAttachments } from "../../../lib/attachmentUpload";
import { KIN_DRAFT_PREFIX } from "../../../lib/composerAttachmentUploadQueue";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
  composerAttachmentsStillUploading,
} from "../../../state/composer-attachment-uploads";
import { useServerConfigs } from "../../../state/entities";
import { useEnvironmentScope } from "../../../state/session";
import { useComposerAttachmentActions } from "../../../state/use-composer-attachment-actions";
import { ComposerAttachmentButton } from "../../threads/ComposerAttachmentButton";

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
  appendComposerDraftAttachments,
  clearComposerDraftContent,
  composerDraftsAtom,
  getComposerDraftSnapshot,
  removeComposerDraftAttachment,
  scheduleUnusedComposerAttachmentCleanup,
  setComposerDraftText,
  useComposerDraft,
} from "../../../state/use-composer-drafts";
import {
  kinApplyMention,
  kinMentionQuery,
  kinMentionsIn,
  type KinMentionCandidate,
} from "@t3tools/client-runtime/kin/kinGroups";
import { KIN_MESSAGE_MAX_LENGTH } from "@t3tools/client-runtime/kin/kinOutbox";
import { Chip } from "../../../components/ui/Chip";
import { deliverKinOutbox, kinOutbox } from "../state/kinOutboxDelivery";
import { kinAttachmentFailure } from "../state/kinAttachmentFailure";

/** Every Kin host uses the same org id, so the environment keeps two hosts' drafts apart. */
export const kinDraftKey = (environmentId: EnvironmentId, orgId: string, chatId: string) =>
  `${KIN_DRAFT_PREFIX}${environmentId}:${orgId}:${chatId}`;

// The native editor has no intrinsic height: it grows with its text from one line to four.
// iOS reports at most four lines of content, so a taller cap would never turn scrolling on.
const EDITOR_MIN_HEIGHT = 36;
const EDITOR_MAX_LINES = 4;
const EDITOR_INSET = 6;

const lengthFormat = new Intl.NumberFormat();
const NO_MENTIONS: ReadonlyArray<KinMentionCandidate> = [];

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
function restoredDraft(draftKey: string, body: string) {
  const typed = getComposerDraftSnapshot(draftKey).text;
  return typed.trim().length === 0 ? body : `${body}\n\n${typed}`;
}

/** How the feed writes into the composer; each call leaves the caret after what it wrote. */
export interface KinComposerHandle {
  /** Replaces the draft and focuses the editor. */
  readonly fill: (text: string) => void;
  /** Moves an unsent message back into the draft; false once it is already going out. */
  readonly edit: (clientMessageId: string) => Promise<boolean>;
}

/**
 * The chat's text box. The draft lives in the shared composer drafts, so it survives a restart;
 * a send goes to the outbox, which shows it at once and delivers it when the host is reachable.
 * Attachments are the thread composer's: the same picker, strip, limits and upload queue. They
 * sit beside the text, not in it, since a Kin message has no context chips.
 */
export function KinComposer({
  ref,
  ...props
}: {
  readonly orgId: string;
  readonly chatId: KinChatId;
  readonly environmentId: EnvironmentId;
  /** Who reads the message; null for a direct chat whose agent this phone can't name yet. */
  readonly recipient: string | null;
  /** The host is reachable: uploads need it, though text alone can wait in the outbox. */
  readonly connected: boolean;
  /** Space under the Send row: the bottom safe area, at least `KIN_COMPOSER_GUTTER`. */
  readonly bottomInset: number;
  /** Called once the message is in the outbox, so the feed can show the end. */
  readonly onSend: () => void;
  readonly onFocusChange?: (focused: boolean) => void;
  /** Owned by the feed, which writes into the composer through `ref`. */
  readonly editorRef: RefObject<ComposerEditorHandle | null>;
  readonly ref?: Ref<KinComposerHandle>;
  /** The group's leads, offered on `@`; a message that names one is answered by it. */
  readonly mentionable?: ReadonlyArray<KinMentionCandidate>;
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
  // Text and caret land in one render, so the native editor never keeps a caret at 0.
  const write = (text: string, caret: number) => {
    setComposerDraftText(draftKey, text);
    setSelection({ start: caret, end: caret });
    editorRef.current?.focus();
  };
  useImperativeHandle(ref, () => ({
    fill: (text) => write(text, text.length),
    edit: async (clientMessageId) => {
      const body = await kinOutbox.discard(clientMessageId);
      if (body === null) return false;
      write(restoredDraft(draftKey, body), body.length);
      return true;
    },
  }));
  // T3's dictation: it writes into this chat's draft at the cursor, as in the thread composer.
  const voice = useVoiceInputController({
    ownerKey: draftKey,
    label: props.recipient ?? "Kin chat",
    readDraftMessage: () => getComposerDraftSnapshot(draftKey).text,
    subscribeToDraftChanges: (onChange) => appAtomRegistry.subscribe(composerDraftsAtom, onChange),
    selection,
    onChangeDraftMessage: (text) => setComposerDraftText(draftKey, text),
    onChangeSelection: setSelection,
  });
  const voicePresentation = resolveVoiceComposerPresentation(voice.state, voice.elapsedSeconds);
  const showsDictation = voicePresentation.statusKind === "active";
  const controlSize = largeControls ? "large" : "regular";
  const navigation = useNavigation();
  const serverConfig = useServerConfigs().get(props.environmentId) ?? null;
  // Uploading is the thread composer's permission; a session without it sees no attach control.
  const canAttach =
    useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope) &&
    serverConfig !== null;
  const [sending, setSending] = useState(false);
  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoPreviewSource | null>(null);
  const attach = useComposerAttachmentActions({
    draftKey,
    serverConfig,
    locked: sending,
    inlineReferences: false,
  });
  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  const hasAttachments = draft.attachments.length > 0;
  const uploading =
    hasAttachments &&
    composerAttachmentsStillUploading({
      environmentId: props.environmentId,
      attachments: draft.attachments,
      serverConfig,
      states: uploadStates,
    });
  const uploadBlock = composerAttachmentUploadBlockReason({
    environmentId: props.environmentId,
    attachments: draft.attachments,
    connected: props.connected,
    serverConfig,
    states: uploadStates,
  });
  const mentionable = props.mentionable ?? NO_MENTIONS;
  const mention =
    selection.start === selection.end
      ? kinMentionQuery(draft.text, selection.end, mentionable)
      : null;
  const length = draft.text.trim().length;
  const tooLong = length > KIN_MESSAGE_MAX_LENGTH;
  const canSend =
    (length > 0 || hasAttachments) &&
    !tooLong &&
    !full &&
    !voice.blocksSubmission &&
    !sending &&
    !uploading &&
    uploadBlock === null &&
    (!hasAttachments || props.connected);
  const hint = tooLong
    ? `Too long to send: ${lengthFormat.format(length)} of ${lengthFormat.format(KIN_MESSAGE_MAX_LENGTH)} characters.`
    : full
      ? "Too many unsent messages. Wait for them to go out."
      : uploadBlock !== null
        ? `${uploadBlock}.`
        : hasAttachments && !props.connected
          ? "Attachments send once the server is connected."
          : null;

  /** The uploads the host already holds for this draft, as the references a message carries. */
  const uploadedAttachments = async (
    attachments: ReturnType<typeof getComposerDraftSnapshot>["attachments"],
  ): Promise<ReadonlyArray<KinAttachment> | null> => {
    if (attachments.length === 0) return [];
    setSending(true);
    const prepared = await settlePromise(() =>
      prepareTurnAttachments({
        environmentId: props.environmentId,
        attachments,
        supportsImageUploads: true,
      }),
    );
    setSending(false);
    if (AsyncResult.isFailure(prepared)) {
      const failure = kinAttachmentFailure(
        squashAtomCommandFailure(prepared),
        attachments.map((attachment) => attachment.type),
      );
      Dialog.alert(failure.title, failure.message);
      return null;
    }
    if (prepared.value.status !== "ready") return null;
    const references = prepared.value.attachments.flatMap((uploaded): Array<KinAttachment> => {
      if ("dataUrl" in uploaded) return [];
      const { id, name, mimeType, sizeBytes } = uploaded;
      return [{ type: uploaded.type, id, name, mimeType, sizeBytes }];
    });
    return references.length === attachments.length ? references : null;
  };

  const send = async () => {
    if (sending) return;
    await editorRef.current?.flushPendingInput();
    const snapshot = getComposerDraftSnapshot(draftKey);
    const body = snapshot.text.trim();
    if (body.length === 0 && snapshot.attachments.length === 0) return;
    if (body.length > KIN_MESSAGE_MAX_LENGTH) return;
    const attachments = await uploadedAttachments(snapshot.attachments);
    if (attachments === null) return;
    // The outbox entry owns the uploads from here; only this device's copies are swept below.
    clearComposerDraftContent(draftKey, { deferAttachmentCleanup: true });
    const queued = await kinOutbox.enqueue({
      environmentId: props.environmentId,
      chatId: props.chatId,
      body,
      attachments,
      mentions: kinMentionsIn(body, mentionable),
    });
    if (queued._tag !== "queued") {
      setComposerDraftText(draftKey, restoredDraft(draftKey, body));
      appendComposerDraftAttachments(draftKey, snapshot.attachments);
      return;
    }
    scheduleUnusedComposerAttachmentCleanup(
      snapshot.attachments.map(
        ({ uploadedAttachmentId: _id, uploadEnvironmentId: _environment, ...local }) => local,
      ),
    );
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
      {mention === null || showsDictation ? null : (
        <View
          accessibilityRole="menu"
          accessibilityLabel="Agents you can ask"
          className="flex-row flex-wrap gap-2 px-1 pb-1"
        >
          {mention.matches.map((lead) => (
            <Chip
              key={lead.memberId}
              label={`@${lead.name}`}
              accessibilityLabel={`Ask ${lead.name}`}
              onPress={() => {
                const next = kinApplyMention(draft.text, mention.start, selection.end, lead.name);
                setComposerDraftText(draftKey, next.text);
                setSelection({ start: next.cursor, end: next.cursor });
              }}
            />
          ))}
        </View>
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
        {hasAttachments ? (
          <View className="px-[14px] pb-1 pt-2.5">
            <ComposerAttachmentStrip
              environmentId={props.environmentId}
              attachments={draft.attachments}
              onRemove={(id) => {
                if (!sending) removeComposerDraftAttachment(draftKey, id);
              }}
              onPressPreview={setPreviewFile}
              onPressVideo={(attachment, sourceIdentifier) =>
                setPreviewVideo({ type: "local", attachment, sourceIdentifier })
              }
              onPressDocument={(attachment) =>
                navigation.navigate("ThreadAttachment", {
                  environmentId: String(props.environmentId),
                  attachmentId: attachment.id,
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeBytes: String(attachment.sizeBytes),
                  draftKey,
                })
              }
            />
          </View>
        ) : null}
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
            {canAttach ? (
              <ComposerAttachmentButton
                size={controlSize}
                disabled={sending}
                supportsFiles
                onPickMedia={attach.onPickDraftMedia}
                onPickFiles={attach.onPickDraftFiles}
              />
            ) : null}
            <View className={`min-h-11 flex-1 justify-center py-1 ${canAttach ? "" : "pl-4"}`}>
              <ComposerEditor
                ref={editorRef}
                draftKey={draftKey}
                pasteContext={false}
                inlineTokens={false}
                multiline
                value={draft.text}
                placeholder={props.recipient === null ? "Message" : `Message ${props.recipient}`}
                readOnly={voice.freezesEditor || sending}
                selection={selection}
                onSelectionChange={setSelection}
                onSubmit={() => void send()}
                onPasteImages={
                  canAttach ? (uris) => void attach.onNativePasteImages(uris) : undefined
                }
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
      <FilePreviewModal source={previewFile} onRequestClose={() => setPreviewFile(null)} />
      <VideoPreviewModal source={previewVideo} onRequestClose={() => setPreviewVideo(null)} />
    </View>
  );
}
