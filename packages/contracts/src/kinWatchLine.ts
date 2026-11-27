import * as Schema from "effect/Schema";

import { IsoDateTime, KinText, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const KinWatchState = Schema.Literals(["open", "closed", "stopped"]);
export type KinWatchState = typeof KinWatchState.Type;

/** What one look found. `skipped_limit`: a look that needed a model waited on the Daily limit. */
export const KinWatchOutcome = Schema.Literals([
  "nothing_new",
  "closed",
  "changed",
  "problem",
  "cant_tell",
  "skipped_limit",
]);
export type KinWatchOutcome = typeof KinWatchOutcome.Type;

/** Who closed or stopped a watch. `you` is the reader. */
export const KinWatchActor = Schema.Struct({
  kind: Schema.Literals(["person", "agent", "code"]),
  name: Schema.NullOr(KinText),
  you: Schema.Boolean,
});
export type KinWatchActor = typeof KinWatchActor.Type;

/**
 * Exactly what one watch line shows (`kinWatchLine` in client-runtime words it). A record read
 * carries this for the record's watch; nothing more rides on every record.
 */
export const KinWatchLine = Schema.Struct({
  watchId: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString,
  /** What it is about, such as "Brightwell Labs' INV-11", or a person's own words. */
  about: KinText,
  state: KinWatchState,
  lookedAt: Schema.NullOr(IsoDateTime),
  nextLookAt: Schema.NullOr(IsoDateTime),
  lastOutcome: Schema.NullOr(KinWatchOutcome),
  /** What the last look found, in code's words: "the work failed". */
  lastLine: Schema.NullOr(KinText),
  /** Look now was asked and the look hasn't run yet. */
  looking: Schema.Boolean,
  /** Its record is set aside: no look until the hold ends (null: until someone lifts it). */
  aside: Schema.NullOr(Schema.Struct({ until: Schema.NullOr(IsoDateTime) })),
  closedAt: Schema.NullOr(IsoDateTime),
  /** How it closed: "INV-11 was paid on 25 Nov". */
  closedHow: Schema.NullOr(KinText),
  closedBy: Schema.NullOr(KinWatchActor),
});
export type KinWatchLine = typeof KinWatchLine.Type;
