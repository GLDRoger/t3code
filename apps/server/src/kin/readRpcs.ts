import type { KinRpcs } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * Kin's hot screen reads, served on SQLite's reader pool so a slow screen never holds the one
 * writer. Each read is fresh and sees every commit before it. None may write (a write on a reader
 * fails as readonly); `readRpcs.test.ts` runs each on a database with readers.
 */
const READS = [
  "kin.work.summary",
  "kin.work.list",
  "kin.work.subscribe",
  "kin.pulse.read",
  "kin.pulse.subscribe",
  "kin.money.subscribe",
  // The Money stream's own builders, asked one at a time.
  "kin.work.money",
  "kin.work.cash",
  "kin.work.outlook",
  "kin.work.budgets",
  "kin.work.receipts",
  "kin.work.lists",
  // What a teammate's screens should read again, Money's lists among it.
  "kin.refreshes.subscribe",
  // What Kin keeps watch on, and its log.
  "kin.watches.list",
  "kin.watches.followUps",
  "kin.watches.log",
] as const satisfies ReadonlyArray<(typeof KinRpcs)[number]["_tag"]>;
export type KinReadRpc = (typeof READS)[number];
export const KIN_READ_RPCS: ReadonlySet<string> = new Set(READS);

// `readOnly` marks the context it runs in; taken alone, the mark covers a stream's every pull.
const readerMark = NodeSqliteClient.readOnly(Effect.context<never>()).pipe(
  Effect.updateContext((_: Context.Context<never>) => Context.empty()),
);

/** `NodeSqliteClient.readOnly` for a whole stream: its first read and every one a change starts. */
export const readOnlyStream = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
  Stream.unwrap(Effect.map(readerMark, (mark) => Stream.provideContext(stream, mark)));
