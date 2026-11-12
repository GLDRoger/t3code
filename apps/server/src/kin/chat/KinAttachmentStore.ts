import { KinChatError, type KinAttachment } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { forgetPendingAttachment, type PendingUploadOwner } from "../../assets/AttachmentUpload.ts";
import { resolveAttachmentRelativePath } from "../../attachmentPaths.ts";
import {
  createAttachmentId,
  createDeterministicAttachmentId,
  isKinAttachmentId,
  KIN_ATTACHMENT_ID_PREFIX,
  resolveAttachmentPathById,
} from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as AttachmentClaims from "../../orchestration-v2/AttachmentClaims.ts";
import * as DocumentText from "../../provider/DocumentText.ts";

// Kin's files sit beside threads' in the attachments directory, under their own id prefix.
const KIN_ATTACHMENT_OWNER = KIN_ATTACHMENT_ID_PREFIX.slice(0, -1);
export { KIN_ATTACHMENT_ID_PREFIX };

const refused = (message: string) => new KinChatError({ reason: "invalid_state", message });

/**
 * Keeps checked bytes as a file of the org's, named by its content: the same bytes again are the
 * same file, so a retry or a second entry with it writes nothing. `undefined` if no id fits.
 */
export const keepOrgFile = Effect.fn("KinAttachmentStore.keepOrgFile")(function* (
  orgId: string,
  scratchTag: string,
  file: { readonly sha256: string; readonly extension: string; readonly bytes: Uint8Array },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const base = createDeterministicAttachmentId("kin-chat", `${orgId}:${file.sha256}`);
  if (base === null) return undefined;
  const attachmentId = `${base}-${file.extension}`;
  const target = path.join(attachmentsDir, `${attachmentId}.${file.extension}`);
  if (!(yield* fs.exists(target))) {
    yield* fs.makeDirectory(attachmentsDir, { recursive: true });
    const scratch = `${target}.${scratchTag}.tmp`;
    yield* fs.writeFile(scratch, file.bytes);
    yield* fs.rename(scratch, target);
  }
  return attachmentId;
});

export interface ClaimedKinAttachments {
  readonly attachments: ReadonlyArray<KinAttachment>;
  readonly claimed: AttachmentClaims.ClaimedAttachments;
}

/**
 * Moves a person's uploads out of the pending pool and into Kin's keeping, through the same
 * claim a thread message uses. A message row is written only after its files are claimed.
 */
export class KinAttachmentStore extends Context.Service<
  KinAttachmentStore,
  {
    /** Only `owner`'s own uploads, each moved so that one upload lands in one message at most. */
    readonly claim: (
      attachments: ReadonlyArray<KinAttachment>,
      owner: PendingUploadOwner,
    ) => Effect.Effect<ClaimedKinAttachments, KinChatError>;
    /** Puts back the uploads of a message that was never written. */
    readonly release: (claimed: ClaimedKinAttachments) => Effect.Effect<void>;
    /** Drops the pending uploads a written message no longer needs. */
    readonly discardPending: (attachments: ReadonlyArray<KinAttachment>) => Effect.Effect<void>;
    /** Keeps a page an agent wrote as a new file of Kin's, never replacing one. */
    readonly storePage: (html: string) => Effect.Effect<string, KinChatError>;
    /** Deletes Kin's stored files by id, for good; one already gone is not an error. */
    readonly remove: (attachmentIds: ReadonlyArray<string>) => Effect.Effect<void>;
  }
>()("t3/kin/chat/KinAttachmentStore") {}

export const layer = Layer.effect(
  KinAttachmentStore,
  Effect.gen(function* () {
    const context = Context.mergeAll(
      Context.make(ServerConfig.ServerConfig, yield* ServerConfig.ServerConfig),
      Context.make(FileSystem.FileSystem, yield* FileSystem.FileSystem),
      Context.make(DocumentText.DocumentText, yield* DocumentText.DocumentText),
    );
    const { attachmentsDir } = Context.get(context, ServerConfig.ServerConfig);
    return KinAttachmentStore.of({
      claim: Effect.fn("KinAttachmentStore.claim")(function* (attachments, owner) {
        // Only this caller's fresh uploads: a stored id from another chat is never re-attached.
        if (!attachments.every(AttachmentClaims.attachmentIsPendingUpload))
          return yield* refused("Attachments must be new uploads.");
        const claimed = yield* AttachmentClaims.claimPendingAttachments({
          threadId: KIN_ATTACHMENT_OWNER,
          attachments,
          owner,
          move: true,
        }).pipe(
          Effect.provideContext(context),
          Effect.mapError((error) => refused(error.message)),
        );
        return {
          claimed,
          // The claim keeps order and kind; it renames the id and normalises name and type.
          attachments: attachments.flatMap((attachment, index) => {
            const stored = claimed.attachments[index];
            return stored === undefined
              ? []
              : [{ ...attachment, id: stored.id, name: stored.name, mimeType: stored.mimeType }];
          }),
        };
      }),
      release: Effect.fn("KinAttachmentStore.release")(({ claimed }) =>
        AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths).pipe(
          Effect.andThen(AttachmentClaims.restoreMovedAttachments(claimed.moved)),
          Effect.provideContext(context),
        ),
      ),
      discardPending: Effect.fn("KinAttachmentStore.discardPending")((attachments) =>
        Effect.forEach(attachments, (attachment) => forgetPendingAttachment(attachment.id), {
          discard: true,
        }).pipe(Effect.provideContext(context)),
      ),
      storePage: Effect.fn("KinAttachmentStore.storePage")(function* (html) {
        // The `-html` suffix is what the asset route reads as a document.
        const attachmentId = createAttachmentId(KIN_ATTACHMENT_OWNER, "html");
        const filePath =
          attachmentId === null
            ? null
            : resolveAttachmentRelativePath({
                attachmentsDir,
                relativePath: `${attachmentId}.html`,
              });
        if (attachmentId === null || filePath === null)
          return yield* refused("The page could not be saved.");
        const fileSystem = Context.get(context, FileSystem.FileSystem);
        yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true }).pipe(
          Effect.andThen(fileSystem.writeFileString(filePath, html, { flag: "wx" })),
          Effect.tapError((cause) => Effect.logWarning("Kin could not save a visual.", cause)),
          Effect.mapError(() => refused("The page could not be saved.")),
        );
        return attachmentId;
      }),
      remove: Effect.fn("KinAttachmentStore.remove")((attachmentIds) =>
        AttachmentClaims.releaseClaimedAttachments(
          attachmentIds.flatMap((attachmentId) => {
            if (!isKinAttachmentId(attachmentId)) return [];
            const path = resolveAttachmentPathById({ attachmentsDir, attachmentId });
            return path === null ? [] : [path];
          }),
        ).pipe(Effect.provideContext(context)),
      ),
    });
  }),
);
