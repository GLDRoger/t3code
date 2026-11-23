import type { KinAgentId, KinWatchKind } from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import type { SenseContext } from "../../pulse/senses/shared.ts";

/** What a round reads with: the pulse's own sense context (org, instant, zone, default agents). */
export type WatchContext = SenseContext;

/** A watch as a kind reads it. */
export interface WatchRow {
  readonly watchId: string;
  readonly kind: string;
  readonly sourceKey: string;
  readonly recordId: string | null;
  readonly subjectRef: string | null;
  readonly about: string;
  readonly agentId: string | null;
  readonly latestBy: number | null;
  readonly lookedAt: number | null;
  readonly createdAt: number;
}

/** A source a kind found: one watch per `sourceKey`, made once. */
export interface Found {
  readonly sourceKey: string;
  readonly recordId: string | null;
  readonly subjectRef: string | null;
  /** What it is about, such as "Brightwell Labs' INV-11" (≤200). */
  readonly about: string;
  /** What would close it, in words (≤200). */
  readonly closesWhen: string;
  readonly agentId: KinAgentId | null;
  /** Why it exists (≤200). */
  readonly why: string;
}

/** Ids only, never words: record keys, thread ids, PR links, event ids. */
export type Evidence = ReadonlyArray<{ readonly kind: string; readonly id: string }>;

/**
 * A code check's answer. `read`: only reading can tell, which waits for the scout. Every line is
 * code's own words, never a source's.
 */
export type CodeOutcome =
  | { readonly _tag: "closed"; readonly how: string; readonly evidence: Evidence }
  | { readonly _tag: "problem"; readonly line: string; readonly evidence: Evidence }
  | { readonly _tag: "changed"; readonly line: string; readonly evidence: Evidence }
  | { readonly _tag: "nothing_new"; readonly evidence: Evidence }
  | { readonly _tag: "cant_tell"; readonly line: string }
  | { readonly _tag: "read" };

type Read<A> = Effect.Effect<A, SqlError.SqlError | Schema.SchemaError, SqlClient.SqlClient>;

/**
 * How one sort of loop is found, when it is due and how code checks it. One file per kind; the
 * round runs each in `ALL_KINDS` order. No model runs in any of these.
 */
export interface WatchKind {
  readonly kind: KinWatchKind;
  readonly source: "sense" | "task" | "turn" | "host";
  /** Money, mail and host watches are the owner level's alone; work may reach a teammate. */
  readonly reach: "money" | "mail" | "host" | "work";
  /** A look that found nothing new reads "Checked work" in the log, not "Nothing new". */
  readonly checksWork: boolean;
  /** Sources Kin's own rows show now; idempotent by `sourceKey`. */
  readonly find: (ctx: WatchContext) => Read<ReadonlyArray<Found>>;
  /** Watches whose subject moved since their last look: due at once, back-off reset. */
  readonly moved?: (
    ctx: WatchContext,
    watches: ReadonlyArray<WatchRow>,
  ) => Read<ReadonlySet<string>>;
  /** Watches whose subject is set aside, with when the hold ends (null: until lifted). */
  readonly asleep?: (
    ctx: WatchContext,
    watches: ReadonlyArray<WatchRow>,
  ) => Read<ReadonlyMap<string, number | null>>;
  readonly check: (ctx: WatchContext, watch: WatchRow) => Read<CodeOutcome>;
}
