import { fileAttachmentTooLargeMessage } from "@t3tools/client-runtime/state/attachments";
import {
  AuthOrchestrationOperateScope,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type EnvironmentId,
  type KinAttachment,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  ComposerAttachmentFileList,
  ComposerAttachmentMediaRow,
  ComposerFilePreviewDialog,
} from "../components/chat/ComposerAttachmentStrip";
import {
  classifyComposerAttachmentFile,
  composerFileAttachmentMimeType,
  fileAttachmentCapabilityBlockReason,
  fileAttachmentStagingLimit,
  normalizeComposerImageFileMimeType,
} from "../components/chat/composerAttachmentFiles";
import { openExpandedImagePreview } from "../components/chat/ExpandedImageDialog";
import {
  addPreparingComposerImages,
  countPreparingComposerImages,
  removePreparingComposerImages,
  usePreparingComposerImages,
} from "../components/chat/preparingComposerImages";
import {
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  composerFileNeedsReattach,
  DraftId,
  useComposerDraftStore,
  useComposerThreadDraft,
} from "../composerDraftStore";
import { useTheme } from "../hooks/useTheme";
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseAttachmentUpload,
  releaseDraftAttachment,
  retryAttachmentUpload,
  startAttachmentUpload,
  useAttachmentUploadStore,
} from "../lib/attachmentUploadQueue";
import { inheritComposerImageThumbnail, prepareImageForAttachment } from "../lib/imageCompression";
import { randomUUID } from "../lib/utils";
import { useServerConfigs } from "../state/entities";
import { useEnvironmentScope } from "../state/session";

/** A Kin chat's files wait in the thread composer's draft store, under a key no thread has. */
const kinAttachmentTarget = (draftKey: string) => DraftId.make(`kin:${draftKey}`);

/** Where a Kin chat's image previews open; mount `ExpandedImageDialogHost` with the same key. */
export const kinPreviewKey = (draftKey: string) => `kin:${draftKey}`;

type DraftAttachment = ComposerImageAttachment | ComposerFileAttachment;

export type KinDraftAttachments =
  | {
      readonly _tag: "ready";
      readonly attachments: ReadonlyArray<KinAttachment>;
      /** The images' own bytes, in order, which show until the posted message's copies load. */
      readonly images: ReadonlyArray<Blob>;
    }
  | { readonly _tag: "blocked"; readonly reason: string };

/**
 * The files waiting in one Kin chat's composer, held and uploaded the way a thread's are. A
 * message carries only what the upload returned: an id, a name, a type and a size.
 */
export function useKinComposerAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly draftKey: string;
}) {
  const { environmentId, draftKey } = input;
  const target = kinAttachmentTarget(draftKey);
  const draft = useComposerThreadDraft(target);
  const preparing = usePreparingComposerImages(target);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const config = useServerConfigs().get(environmentId) ?? null;
  const maxFileBytes = config?.environment.capabilities.fileAttachments?.maxUploadBytes ?? null;
  const capability = {
    attachmentUploadsCapabilityKnown: config !== null,
    supportsAttachmentUploads: config !== null,
    maxFileAttachmentBytes: maxFileBytes,
  };
  const stagingLimit = fileAttachmentStagingLimit(capability);
  const uploads = useAttachmentUploadStore((state) => state.uploadsByImageId);
  const [error, setError] = useState<string | null>(null);

  const attachments: ReadonlyArray<DraftAttachment> = [...draft.images, ...draft.files];
  const count = attachments.length + preparing.length;
  const needsReattach = draft.files.some(composerFileNeedsReattach);
  const failed = attachments.find((attachment) => uploads[attachment.id]?.status === "failed");
  const blockReason =
    fileAttachmentCapabilityBlockReason({ ...capability, files: draft.files }) ??
    (needsReattach ? "Attach the marked files again, or remove them to send." : null) ??
    (failed === undefined ? null : `'${failed.name}' did not upload. Retry it or remove it.`);

  const store = () => useComposerDraftStore.getState();

  const add = async (files: ReadonlyArray<File>): Promise<boolean> => {
    if (!canOperate || files.length === 0) return false;
    // Slots are reserved before the first await, so two pastes can't both take the last one.
    let reserved =
      (store().getComposerDraft(target)?.images.length ?? 0) +
      (store().getComposerDraft(target)?.files.length ?? 0) +
      countPreparingComposerImages(target);
    let refusal: string | null = null;
    const acceptedImages: File[] = [];
    const acceptedFiles: ComposerFileAttachment[] = [];
    for (const file of files) {
      const kind = classifyComposerAttachmentFile(file);
      if (reserved >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        refusal = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`;
        continue;
      }
      if (kind === "unsupported-image") {
        refusal = `'${file.name}' is not a supported image type. Attach GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`;
        continue;
      }
      if (kind === "image") {
        acceptedImages.push(normalizeComposerImageFileMimeType(file));
      } else if (stagingLimit === null) {
        refusal = "This server does not support file attachments.";
        continue;
      } else if (file.size <= 0) {
        refusal = `'${file.name}' is empty or could not be read.`;
        continue;
      } else if (file.size > stagingLimit) {
        refusal = fileAttachmentTooLargeMessage(file.name, stagingLimit);
        continue;
      } else {
        const mimeType = composerFileAttachmentMimeType(file);
        const typed =
          file.type === mimeType
            ? file
            : new File([file], file.name, { type: mimeType, lastModified: file.lastModified });
        acceptedFiles.push({
          type: "file",
          id: randomUUID(),
          name: typed.name || "file",
          mimeType,
          sizeBytes: typed.size,
          file: typed,
        });
      }
      reserved += 1;
    }
    setError(refusal);
    const storedFiles = new Set(
      store().addFiles(target, acceptedFiles, { appendReference: false }),
    );
    for (const file of acceptedFiles) {
      if (storedFiles.has(file.id))
        startAttachmentUpload({ environmentId, image: file, draftTarget: target });
    }
    const added = storedFiles.size > 0;
    if (acceptedImages.length === 0) return added;

    const placeholders = acceptedImages.map((file) => ({
      id: randomUUID(),
      name: file.name || "image",
      file,
    }));
    addPreparingComposerImages(target, placeholders);
    const prepared: ComposerImageAttachment[] = [];
    for (const { id, file } of placeholders) {
      const result = await prepareImageForAttachment(
        file,
        PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
      ).catch(() => ({ ok: false, reason: "unreadable" }) as const);
      if (!result.ok) {
        setError(
          result.reason === "unreadable"
            ? `'${file.name}' could not be read as an image.`
            : `'${file.name}' is too large to attach, even after compression.`,
        );
        continue;
      }
      inheritComposerImageThumbnail(file, result.file);
      prepared.push({
        type: "image",
        id,
        name: result.file.name || "image",
        mimeType: result.file.type,
        sizeBytes: result.file.size,
        previewUrl: URL.createObjectURL(result.file),
        file: result.file,
      });
    }
    // A placeholder removed from the strip meanwhile stays removed.
    const kept = removePreparingComposerImages(target, new Set(placeholders.map(({ id }) => id)));
    const images = prepared.filter((image) => kept.has(image.id));
    const stored = new Set(store().addImages(target, images));
    for (const image of prepared) {
      if (stored.has(image.id))
        startAttachmentUpload({ environmentId, image, draftTarget: target });
      else URL.revokeObjectURL(image.previewUrl);
    }
    return added || stored.size > 0;
  };

  const removeImage = (imageId: string) => {
    if (removePreparingComposerImages(target, new Set([imageId])).size > 0) return;
    releaseAttachmentUpload(imageId);
    store().removeImage(target, imageId);
  };

  const removeFile = (fileId: string) => {
    const file = store()
      .getComposerDraft(target)
      ?.files.find((candidate) => candidate.id === fileId);
    if (file) releaseDraftAttachment(file);
    else releaseAttachmentUpload(fileId);
    store().removeFile(target, fileId);
  };

  /**
   * Waits for the uploads and returns what the message carries. The draft keeps its files until
   * `clear`, so a send that fails here leaves the composer as it was.
   */
  const settle = async (): Promise<KinDraftAttachments> => {
    const current = store().getComposerDraft(target);
    const waiting: ReadonlyArray<DraftAttachment> = [
      ...(current?.images ?? []),
      ...(current?.files ?? []),
    ];
    if (waiting.length === 0) return { _tag: "ready", attachments: [], images: [] };
    for (const attachment of waiting) {
      const upload =
        readAttachmentUpload(attachment.id)?.status === "failed"
          ? retryAttachmentUpload
          : startAttachmentUpload;
      upload({ environmentId, image: attachment, draftTarget: target });
    }
    await awaitAttachmentUploads(waiting.map((attachment) => attachment.id));
    const uploaded = getUploadedAttachments({ environmentId, images: waiting });
    if (uploaded === null)
      return { _tag: "blocked", reason: "An attachment did not upload. Retry it or remove it." };
    return {
      _tag: "ready",
      images: waiting.flatMap((attachment, index) =>
        attachment.type === "image" && uploaded[index] !== undefined ? [attachment.file] : [],
      ),
      // The queue answers in the order asked; a Kin message keeps the kind, not the source.
      attachments: waiting.flatMap((attachment, index) => {
        const stored = uploaded[index];
        return stored === undefined
          ? []
          : [
              {
                type: attachment.type,
                id: stored.id,
                name: stored.name,
                mimeType: stored.mimeType,
                sizeBytes: stored.sizeBytes,
              },
            ];
      }),
    };
  };

  /** Empties the draft once its message is queued. The uploads stay: the message owns them now. */
  const clear = () => {
    setError(null);
    store().clearComposerContent(target);
  };

  return {
    target,
    images: draft.images,
    files: draft.files,
    nonPersistedImageIds: draft.nonPersistedImageIds,
    preparing,
    count,
    /** Why the last pick was turned away; the rest of the draft can still go. */
    refusal: error,
    /** Why the draft cannot go as it stands. */
    blockReason: blockReason ?? (preparing.length > 0 ? "Preparing images" : null),
    canAttach: canOperate && config !== null,
    maxFileBytes,
    stagingLimit,
    add,
    removeImage,
    removeFile,
    settle,
    clear,
  };
}

export type KinComposerAttachmentState = ReturnType<typeof useKinComposerAttachments>;

/** The thread composer's strip over a Kin chat's waiting files: tiles, upload state, remove. */
export function KinComposerAttachmentStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly draftKey: string;
  readonly state: KinComposerAttachmentState;
}) {
  const { environmentId, state } = props;
  const { resolvedTheme } = useTheme();
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const previewFile = state.files.find((file) => file.id === previewFileId);

  if (state.count === 0) return null;
  return (
    <div className="px-3 pt-3">
      {state.images.length + state.preparing.length > 0 ? (
        <ComposerAttachmentMediaRow
          images={state.images}
          expandedImages={state.images}
          preparingImages={state.preparing}
          videos={NONE}
          pendingSnapShotAnimations={NONE}
          pendingSnapShotIds={NONE}
          uncommittedSnapShotIds={NONE}
          nonPersistedImageIds={state.nonPersistedImageIds}
          snapShotAnimations={false}
          supportsAttachmentUploads
          maxFileAttachmentBytes={state.maxFileBytes}
          environmentId={environmentId}
          attachmentDraftTarget={state.target}
          canOperateThread={state.canAttach}
          onExpandImage={(preview) =>
            openExpandedImagePreview(kinPreviewKey(props.draftKey), preview)
          }
          onFileOpen={noop}
          onRemoveImage={state.removeImage}
          onRemoveFile={state.removeFile}
        />
      ) : null}
      {state.files.length > 0 ? (
        <ComposerAttachmentFileList
          files={state.files}
          resolvedTheme={resolvedTheme}
          supportsAttachmentUploads
          maxFileAttachmentBytes={state.maxFileBytes}
          fileStagingLimit={state.stagingLimit}
          environmentId={environmentId}
          attachmentDraftTarget={state.target}
          canOperateThread={state.canAttach}
          onPreviewFile={setPreviewFileId}
          onRemoveFile={state.removeFile}
        />
      ) : null}
      {previewFile === undefined ? null : (
        <ComposerFilePreviewDialog
          file={previewFile}
          onRemove={state.removeFile}
          onPreviewFileIdChange={setPreviewFileId}
        />
      )}
    </div>
  );
}

const NONE: ReadonlyArray<never> = [];
const noop = () => {};
