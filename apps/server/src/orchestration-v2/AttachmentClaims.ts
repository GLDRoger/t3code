import * as FileSystem from "effect/FileSystem";
import {
  ChatAttachmentId,
  getProviderAttachmentLimitError,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isSvgAttachment } from "@t3tools/shared/image";

import { ownsPendingUpload, type PendingUploadOwner } from "../assets/AttachmentUpload.ts";
import {
  isKinAttachmentId,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  planAttachmentClaim,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "../provider/DocumentText.ts";

export class AttachmentClaimError extends Schema.TaggedError<AttachmentClaimError>()(
  "AttachmentClaimError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const validateAttachmentLimits = Effect.fn("AttachmentClaims.validateAttachmentLimits")(
  function* (attachments: ReadonlyArray<ChatAttachment>) {
    const error = getProviderAttachmentLimitError(attachments);
    if (error) return yield* new AttachmentClaimError({ message: error });
  },
);

export interface ClaimedAttachments {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly claimedPaths: ReadonlyArray<string>;
  /** For a moving claim, where each claimed file came from, so a failed send can put it back. */
  readonly moved: ReadonlyArray<{ readonly from: string; readonly to: string }>;
}

/**
 * A Kin chat's files reach a thread only through Kin's own server path (a lead's wake-up), never
 * by a reference a client or agent names.
 */
export const refuseKinAttachments = Effect.fn("AttachmentClaims.refuseKinAttachments")(function* (
  attachments: ReadonlyArray<ChatAttachment>,
) {
  if (attachments.some((attachment) => isKinAttachmentId(attachment.id)))
    return yield* new AttachmentClaimError({ message: "Attachment not found." });
});

export function attachmentIsPendingUpload(attachment: ChatAttachment): boolean {
  return parseThreadSegmentFromAttachmentId(attachment.id) === PENDING_ATTACHMENT_THREAD_SEGMENT;
}

/** Puts moved files back into the pending pool, for a send that was never written. */
export const restoreMovedAttachments = Effect.fn("AttachmentClaims.restoreMovedAttachments")(
  function* (moved: ClaimedAttachments["moved"]) {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      moved,
      ({ from, to }) => fileSystem.rename(to, from).pipe(Effect.ignore),
      { concurrency: 1, discard: true },
    ).pipe(Effect.uninterruptible);
  },
);

/** Remove partial claims only before dispatch, or after proving they were not accepted. */
export const releaseClaimedAttachments = Effect.fn("AttachmentClaims.releaseClaimedAttachments")(
  function* (claimedPaths: ReadonlyArray<string>) {
    if (claimedPaths.length === 0) return;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      claimedPaths,
      (path) =>
        fileSystem
          .remove(path)
          .pipe(
            Effect.ignore,
            Effect.andThen(fileSystem.remove(`${path}.txt`, { force: true }).pipe(Effect.ignore)),
          ),
      {
        concurrency: 1,
        discard: true,
      },
    ).pipe(Effect.uninterruptible);
  },
);

/**
 * Claims only `owner`'s own uploads. Copies preserve the pending retry source after failed
 * bootstrap; the pending sweep reclaims it. `move` renames instead, so of two claims racing for
 * one upload exactly one wins; `restoreMovedAttachments` undoes it.
 */
export const claimPendingAttachments = Effect.fn("AttachmentClaims.claimPendingAttachments")(
  function* (input: {
    readonly threadId: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly owner: PendingUploadOwner;
    readonly move?: boolean;
  }) {
    yield* validateAttachmentLimits(input.attachments);
    yield* refuseKinAttachments(input.attachments);
    if (
      new Set(input.attachments.map((attachment) => attachment.id)).size !==
      input.attachments.length
    ) {
      return yield* new AttachmentClaimError({
        message: "Duplicate attachment ids are not allowed.",
      });
    }
    if (!input.attachments.some(attachmentIsPendingUpload)) {
      return {
        attachments: input.attachments,
        claimedPaths: [],
        moved: [],
      } satisfies ClaimedAttachments;
    }
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const claimedPaths: string[] = [];
    const moved: Array<{ readonly from: string; readonly to: string }> = [];
    const documents = yield* DocumentText.DocumentText;
    const attachments = yield* Effect.forEach(
      input.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (!attachmentIsPendingUpload(attachment)) {
            return attachment;
          }
          const notFound = new AttachmentClaimError({
            message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
          });
          // Someone else's upload reads as a missing one.
          if (!(yield* ownsPendingUpload(attachment.id, input.owner))) return yield* notFound;
          const claim = planAttachmentClaim({
            attachmentsDir: serverConfig.attachmentsDir,
            threadId: input.threadId,
            attachmentId: attachment.id,
          });
          if (!claim.ok) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
            });
          }
          const info = yield* fileSystem.stat(claim.currentPath).pipe(
            Effect.mapError(
              (cause) =>
                new AttachmentClaimError({
                  message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
                  cause,
                }),
            ),
          );
          if (Number(info.size) !== attachment.sizeBytes) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
            });
          }
          const normalized: ChatAttachment = {
            ...attachment,
            id: ChatAttachmentId.make(claim.finalId),
            name:
              attachment.type === "file" &&
              isSvgAttachment(attachment) &&
              !/\.svg$/i.test(attachment.name)
                ? `${attachment.name}.svg`
                : attachment.name,
            mimeType: attachment.mimeType.toLowerCase(),
          };
          const expectedPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: normalized,
          });
          if (expectedPath !== claim.finalPath) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: attachment type does not match the upload.`,
            });
          }
          if (input.move) {
            // The rename is the claim: a second claim of the same upload finds no file.
            yield* fileSystem.rename(claim.currentPath, claim.finalPath).pipe(
              Effect.mapError(
                (cause) => new AttachmentClaimError({ message: notFound.message, cause }),
              ),
              Effect.andThen(
                Effect.sync(() => moved.push({ from: claim.currentPath, to: claim.finalPath })),
              ),
              Effect.uninterruptible,
            );
            const sidecar = `${claim.currentPath}.txt`;
            const keptText = yield* fileSystem.rename(sidecar, `${claim.finalPath}.txt`).pipe(
              Effect.andThen(
                Effect.sync(() => moved.push({ from: sidecar, to: `${claim.finalPath}.txt` })),
              ),
              Effect.as(true),
              Effect.uninterruptible,
              Effect.orElseSucceed(() => false),
            );
            if (!keptText) {
              const extracted = yield* documents.ensure(claim.finalPath);
              if (extracted) claimedPaths.push(extracted);
            }
            return normalized;
          }
          // Copies isolate edits from the retry source. Keep the uncancellable copy and rollback registration
          // uninterruptible so cleanup always sees completed writes.
          yield* fileSystem.copyFile(claim.currentPath, claim.finalPath).pipe(
            Effect.mapError(
              (cause) =>
                new AttachmentClaimError({
                  message: `Failed to claim attachment '${attachment.name}' for this thread.`,
                  cause,
                }),
            ),
            Effect.andThen(Effect.sync(() => claimedPaths.push(claim.finalPath))),
            Effect.uninterruptible,
          );
          const sidecar = `${claim.currentPath}.txt`;
          if (yield* fileSystem.exists(sidecar).pipe(Effect.orElseSucceed(() => false))) {
            yield* fileSystem.copyFile(sidecar, `${claim.finalPath}.txt`).pipe(
              Effect.andThen(Effect.sync(() => claimedPaths.push(`${claim.finalPath}.txt`))),
              Effect.onError(() =>
                fileSystem.remove(`${claim.finalPath}.txt`, { force: true }).pipe(Effect.ignore),
              ),
              Effect.uninterruptible,
              Effect.ignore,
            );
          } else {
            const extracted = yield* documents.ensure(claim.finalPath);
            if (extracted) claimedPaths.push(extracted);
          }
          return normalized;
        }),
      { concurrency: 1 },
    ).pipe(
      Effect.onError(() =>
        releaseClaimedAttachments(claimedPaths).pipe(
          Effect.andThen(restoreMovedAttachments(moved)),
        ),
      ),
    );
    return { attachments, claimedPaths, moved } satisfies ClaimedAttachments;
  },
);
