/** Every Kin host uses the same org id, so the environment keeps two hosts' drafts apart. */
export const kinDraftKey = (environmentId: string, orgId: string, chatId: string) =>
  `${environmentId}:${orgId}:${chatId}`;

/**
 * Whether a draft goes when its host is removed from this device (signed out, or left). The next
 * person may sign in to the same host, so it is never kept for them.
 */
export const kinDraftGoesWith = (draftKey: string, environmentId: string): boolean =>
  draftKey.startsWith(`${environmentId}:`);

/** An unsent body put back in a chat's box, ahead of anything typed since. */
export const kinDraftJoin = (typed: string, body: string): string =>
  typed.trim().length === 0 ? body : `${body}\n\n${typed}`;

/** A prepared question readied in a chat's box: what was typed stays, and it is added once. */
export const kinDraftPrefill = (typed: string, prepared: string): string =>
  typed.includes(prepared) ? typed : kinDraftJoin(typed, prepared);

/**
 * What one Ask readies in a chat: its question added to what was typed, which stays, and its own
 * doc reference or none. One an earlier Ask left unsent is replaced, never carried into this one;
 * files the person attached aren't the Ask's and stay.
 */
export const kinAskDraft = <Ref>(
  typed: string,
  ask: { readonly question: string | null; readonly ref: Ref | null },
): { readonly text: string; readonly ref: Ref | null } => ({
  text: ask.question === null ? typed : kinDraftPrefill(typed, ask.question),
  ref: ask.ref,
});
