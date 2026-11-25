import type { KinAttachment, KinRecordComment } from "@t3tools/contracts";

/** A note this browser sent that the host hasn't taken yet; a retry reuses its id and files. */
export interface KinNoteSend {
  readonly clientRequestId: string;
  readonly body: string;
  readonly attachments: ReadonlyArray<KinAttachment>;
  readonly status: "sending" | "failed";
  readonly problem: string | null;
  /** The failure was the connection's or the host's moment, not a refusal: Retry may land it. */
  readonly retry: boolean;
}

/**
 * A task's notes as one thread, oldest first: pages read on asking, the sheet's newest page, and
 * notes posted here since the sheet was read. A later answer about a note (a removal) wins.
 */
export function kinTaskNoteThread(input: {
  readonly sheet: ReadonlyArray<KinRecordComment>;
  readonly sheetOlder: boolean;
  /** Pages before the sheet's, and whether the host has more; null until one is read. */
  readonly earlier: {
    readonly comments: ReadonlyArray<KinRecordComment>;
    readonly more: boolean;
  } | null;
  readonly posted: ReadonlyArray<KinRecordComment>;
  readonly answers: ReadonlyArray<KinRecordComment>;
}): { readonly comments: ReadonlyArray<KinRecordComment>; readonly more: boolean } {
  const first = input.sheet[0]?.seq;
  const byId = new Map<string, KinRecordComment>();
  const take = (comments: ReadonlyArray<KinRecordComment>) => {
    for (const comment of comments) byId.set(comment.commentId, comment);
  };
  take(input.posted);
  take((input.earlier?.comments ?? []).filter((one) => first === undefined || one.seq < first));
  take(input.sheet);
  // The sheet read after a removal already says so; an answer only fills the gap until then.
  for (const answer of input.answers) {
    const held = byId.get(answer.commentId);
    if (held !== undefined && held.removed === undefined) byId.set(answer.commentId, answer);
  }
  return {
    comments: [...byId.values()].toSorted((a, b) => a.seq - b.seq),
    more: input.earlier === null ? input.sheetOlder : input.earlier.more,
  };
}
