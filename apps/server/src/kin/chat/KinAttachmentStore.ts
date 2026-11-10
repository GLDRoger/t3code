import { KinChatError, type KinAttachment } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import { deletePendingAttachment } from "../../assets/AttachmentUpload.ts";
import * as ServerConfig from "../../config.ts";
import * as AttachmentClaims from "../../orchestration-v2/AttachmentClaims.ts";
import * as DocumentText from "../../provider/DocumentText.ts";

// Kin's files sit beside threads' in the attachments directory, under their own id prefix.
const KIN_ATTACHMENT_OWNER = "kin-chat";
/** Every file Kin stores has an id that starts with this; no thread's does. */
export const KIN_ATTACHMENT_ID_PREFIX = `${KIN_ATTACHMENT_OWNER}-`;

const refused = (message: string) => new KinChatError({ reason: "invalid_state", message });

export interface ClaimedKinAttachments {
  readonly attachments: ReadonlyArray<KinAttachment>;
  readonly claimedPaths: ReadonlyArray<string>;
}

/**
 * Moves a person's uploads out of the pending pool and into Kin's keeping, through the same
 * claim a thread message uses. A message row is written only after its files are claimed.
 */
export class KinAttachmentStore extends Context.Service<
  KinAttachmentStore,
  {
    readonly claim: (
      attachments: ReadonlyArray<KinAttachment>,
    ) => Effect.Effect<ClaimedKinAttachments, KinChatError>;
    /** Removes claimed copies whose message was never written. */
    readonly release: (claimedPaths: ReadonlyArray<string>) => Effect.Effect<void>;
    /** Drops the pending uploads a written message no longer needs. */
    readonly discardPending: (attachments: ReadonlyArray<KinAttachment>) => Effect.Effect<void>;
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
    return KinAttachmentStore.of({
      claim: Effect.fn("KinAttachmentStore.claim")(function* (attachments) {
        // Only this caller's fresh uploads: a stored id from another chat is never re-attached.
        if (!attachments.every(AttachmentClaims.attachmentIsPendingUpload))
          return yield* refused("Attachments must be new uploads.");
        const claimed = yield* AttachmentClaims.claimPendingAttachments({
          threadId: KIN_ATTACHMENT_OWNER,
          attachments,
        }).pipe(
          Effect.provideContext(context),
          Effect.mapError((error) => refused(error.message)),
        );
        return {
          claimedPaths: claimed.claimedPaths,
          // The claim keeps order and kind; it renames the id and normalises name and type.
          attachments: attachments.flatMap((attachment, index) => {
            const stored = claimed.attachments[index];
            return stored === undefined
              ? []
              : [{ ...attachment, id: stored.id, name: stored.name, mimeType: stored.mimeType }];
          }),
        };
      }),
      release: Effect.fn("KinAttachmentStore.release")((claimedPaths) =>
        AttachmentClaims.releaseClaimedAttachments(claimedPaths).pipe(
          Effect.provideContext(context),
        ),
      ),
      discardPending: Effect.fn("KinAttachmentStore.discardPending")((attachments) =>
        Effect.forEach(attachments, (attachment) => deletePendingAttachment(attachment.id), {
          discard: true,
        }).pipe(Effect.provideContext(context)),
      ),
    });
  }),
);
