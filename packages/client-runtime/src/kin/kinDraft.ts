/** An unsent body put back in a chat's box, ahead of anything typed since. */
export const kinDraftJoin = (typed: string, body: string): string =>
  typed.trim().length === 0 ? body : `${body}\n\n${typed}`;

/** A prepared question readied in a chat's box: what was typed stays, and it is added once. */
export const kinDraftPrefill = (typed: string, prepared: string): string =>
  typed.includes(prepared) ? typed : kinDraftJoin(typed, prepared);
