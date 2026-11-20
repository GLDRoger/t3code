import { useAtomValue } from "@effect/atom-react";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_TASK_NOTE_COPY, KIN_TASK_RECORD } from "@t3tools/client-runtime/kin/kinTaskRecord";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  KIN_RECORD_COMMENT_FILES_MAX,
  KIN_RECORD_COMMENT_MAX,
  type EnvironmentId,
  type KinAttachment,
  type KinOrgId,
  type KinRecordKey,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";
import { TextInput, View } from "react-native";

import { ComposerAttachmentStrip } from "../../../components/ComposerAttachmentStrip";
import { ComposerSurface } from "../../../components/ComposerSurface";
import { AppText as Text } from "../../../components/ui/AppText";
import { prepareTurnAttachments } from "../../../lib/attachmentUpload";
import { uuidv4 } from "../../../lib/uuid";
import { appAtomRegistry } from "../../../state/atom-registry";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
  composerAttachmentsStillUploading,
  uploadComposerAttachmentShared,
} from "../../../state/composer-attachment-uploads";
import { useServerConfigs } from "../../../state/entities";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useComposerAttachmentActions } from "../../../state/use-composer-attachment-actions";
import {
  clearComposerDraftContent,
  getComposerDraftSnapshot,
  removeComposerDraftAttachment,
  scheduleUnusedComposerAttachmentCleanup,
  setComposerDraftText,
  useComposerDraft,
} from "../../../state/use-composer-drafts";
import { ComposerAttachmentButton } from "../../threads/ComposerAttachmentButton";
import type { ComposerSendPresentation } from "../../threads/composerSendPresentation";
import { SendActionButton } from "../../threads/ThreadComposer";
import { kinClient } from "../state/kinClient";
import { kinAttachmentFailure } from "../state/kinAttachmentFailure";
import { kinDraftKey } from "./KinComposer";

const NOTE_SEND: ComposerSendPresentation = {
  label: KIN_TASK_NOTE_COPY.send,
  icon: "arrow.up",
  action: null,
  alternate: null,
  offersFollowUpChoice: false,
};

/**
 * "Add a note…" at the foot of a task: words and files for everyone who sees it, posted as a
 * comment. The draft is kept like a chat's, so it survives leaving the page.
 */
export function KinTaskNoteComposer(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly itemKey: KinRecordKey;
  readonly connected: boolean;
  readonly bottomInset: number;
}) {
  const { environmentId, orgId, itemKey } = props;
  const draftKey = kinDraftKey(environmentId, orgId, `task-${itemKey}`);
  const draft = useComposerDraft(draftKey);
  const serverConfig = useServerConfigs().get(environmentId) ?? null;
  const comment = useAtomCommand(kinClient.workComment, { reportFailure: false });
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // One id per note until the host takes it, so a retry after a dropped answer posts it once.
  const requestId = useRef<string | null>(null);
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
      environmentId,
      attachments: draft.attachments,
      serverConfig,
      states: uploadStates,
    });
  const uploadBlock = composerAttachmentUploadBlockReason({
    environmentId,
    attachments: draft.attachments,
    connected: props.connected,
    serverConfig,
    states: uploadStates,
  });
  const body = draft.text.trim();
  const tooLong = body.length > KIN_RECORD_COMMENT_MAX;
  const tooMany = draft.attachments.length > KIN_RECORD_COMMENT_FILES_MAX;
  const canSend =
    (body.length > 0 || hasAttachments) &&
    !tooLong &&
    !tooMany &&
    !sending &&
    !uploading &&
    uploadBlock === null &&
    props.connected;
  const hint = tooLong
    ? KIN_TASK_RECORD.noteTooLong(KIN_RECORD_COMMENT_MAX)
    : tooMany
      ? KIN_TASK_NOTE_COPY.tooMany
      : uploadBlock !== null
        ? `${uploadBlock}.`
        : problem;

  /** The uploads the host already holds for this draft, as the references a comment carries. */
  const uploaded = async (
    attachments: ReturnType<typeof getComposerDraftSnapshot>["attachments"],
  ): Promise<ReadonlyArray<KinAttachment> | null> => {
    if (attachments.length === 0) return [];
    const prepared = await settlePromise(() =>
      Effect.runPromise(
        prepareTurnAttachments({
          environmentId,
          attachments,
          supportsImageUploads: true,
          uploadAttachment: (attachment) =>
            uploadComposerAttachmentShared(environmentId, attachment),
        }),
      ),
    );
    if (AsyncResult.isFailure(prepared)) {
      setProblem(
        kinAttachmentFailure(
          squashAtomCommandFailure(prepared),
          attachments.map((attachment) => attachment.type),
        ).message,
      );
      return null;
    }
    if (prepared.value.status !== "ready") return null;
    const references = prepared.value.attachments.flatMap((one): Array<KinAttachment> => {
      if ("dataUrl" in one) return [];
      const { id, name, mimeType, sizeBytes } = one;
      return [{ type: one.type, id, name, mimeType, sizeBytes }];
    });
    return references.length === attachments.length ? references : null;
  };

  const send = async () => {
    if (!canSend) return;
    setSending(true);
    setProblem(null);
    const snapshot = getComposerDraftSnapshot(draftKey);
    const attachments = await uploaded(snapshot.attachments);
    if (attachments === null) return setSending(false);
    const clientRequestId = requestId.current ?? uuidv4();
    requestId.current = clientRequestId;
    const outcome = await comment({
      environmentId,
      input: {
        orgId,
        key: itemKey,
        clientRequestId,
        body: snapshot.text.trim(),
        ...(attachments.length === 0 ? {} : { attachments }),
      },
    });
    setSending(false);
    if (AsyncResult.isFailure(outcome)) {
      setProblem(kinFailureText(squashAtomCommandFailure(outcome), KIN_TASK_NOTE_COPY.notAdded));
      return;
    }
    requestId.current = null;
    // The host keeps the uploads now; only this device's copies are swept.
    clearComposerDraftContent(draftKey, { deferAttachmentCleanup: true });
    scheduleUnusedComposerAttachmentCleanup(
      snapshot.attachments.map(
        ({ uploadedAttachmentId: _id, uploadEnvironmentId: _environment, ...local }) => local,
      ),
    );
    appAtomRegistry.refresh(kinClient.workItem({ environmentId, input: { orgId, key: itemKey } }));
  };

  return (
    <View className="gap-1 bg-screen px-3 pt-1.5" style={{ paddingBottom: props.bottomInset }}>
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
          borderRadius: 27,
          borderCurve: "circular",
          overflow: "hidden",
          paddingVertical: 2,
        }}
      >
        {hasAttachments ? (
          <View className="px-[14px] pb-1 pt-2.5">
            <ComposerAttachmentStrip
              environmentId={environmentId}
              attachments={draft.attachments}
              onRemove={(id) => {
                if (!sending) removeComposerDraftAttachment(draftKey, id);
              }}
            />
          </View>
        ) : null}
        <View className="flex-row items-end">
          {serverConfig === null ? null : (
            <ComposerAttachmentButton
              size="regular"
              disabled={sending}
              supportsFiles
              onPickMedia={attach.onPickDraftMedia}
              onPickFiles={attach.onPickDraftFiles}
            />
          )}
          <View
            className={`min-h-11 flex-1 justify-center py-1 ${serverConfig === null ? "pl-4" : ""}`}
          >
            <TextInput
              value={draft.text}
              editable={!sending}
              multiline
              onChangeText={(text) => setComposerDraftText(draftKey, text)}
              placeholder={KIN_TASK_RECORD.addNote}
              placeholderTextColorClassName="accent-placeholder"
              textAlignVertical="center"
              className="max-h-28 min-h-9 py-1.5 font-sans text-base text-foreground"
            />
          </View>
          <SendActionButton
            size="regular"
            accessibilityLabel={hint ?? NOTE_SEND.label}
            presentation={NOTE_SEND}
            disabled={!canSend}
            onSend={() => void send()}
          />
        </View>
      </ComposerSurface>
    </View>
  );
}
