import { formatKinWhen, KIN_TEXT_LOCALE, KinOrgId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Scheduler from "../../scheduling/Scheduler.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { context } from "../pulse/KinPulse.ts";
import * as KinShell from "../shell/KinShell.ts";
import { ALL_KINDS } from "./kinds/all.ts";
import * as KinWatches from "./KinWatches.ts";

/** Each org's sources are found again this often, and at once when its records change. */
const ROUND_EVERY_MS = KinWatches.FIRST_INTERVAL_MS;

const whyOf = (watch: KinWatches.OpenWatch) =>
  watch.askedLookAt !== null || watch.source === "person"
    ? ("asked" as const)
    : watch.source === "agent" || watch.source === "promise"
      ? ("again" as const)
      : ("routine" as const);

/**
 * One org's round: find new sources (when `find`), wake or sleep set-aside watches, snap back the
 * ones whose subject moved, then code-check every watch due now. Nothing due: nothing is written.
 */
export const round = Effect.fn("KinWatchRounds.round")(function* (
  orgId: KinOrgId,
  at: number,
  options: { readonly find: boolean },
) {
  const ctx = yield* context(orgId, at).pipe(NodeSqliteClient.readOnly);
  const shell = yield* KinShell.get(orgId);
  const kinds = ALL_KINDS.filter(
    ({ section }) => section === null || KinShell.sectionOn(shell, section),
  );
  if (options.find)
    for (const kind of kinds) {
      const found = yield* kind.find(ctx).pipe(
        NodeSqliteClient.readOnly,
        Effect.catch((cause) =>
          Effect.logWarning("Kin watch find failed", { orgId, kind: kind.kind, cause }).pipe(
            Effect.as([]),
          ),
        ),
      );
      yield* KinWatches.upsert({ orgId, at, kind, found });
    }
  const before = yield* KinWatches.openWatches(orgId);
  const moved = new Set<string>();
  const asleep = new Map<string, number | null>();
  for (const kind of kinds) {
    const theirs = before.filter((watch) => watch.kind === kind.kind);
    if (theirs.length === 0) continue;
    const read = Effect.all([
      kind.moved === undefined ? Effect.succeed(new Set<string>()) : kind.moved(ctx, theirs),
      kind.asleep === undefined
        ? Effect.succeed(new Map<string, number | null>())
        : kind.asleep(ctx, theirs),
    ]).pipe(
      NodeSqliteClient.readOnly,
      Effect.catch((cause) =>
        Effect.logWarning("Kin watch clock read failed", { orgId, kind: kind.kind, cause }).pipe(
          Effect.as([new Set<string>(), new Map<string, number | null>()] as const),
        ),
      ),
    );
    const [kindMoved, kindAsleep] = yield* read;
    for (const id of kindMoved) moved.add(id);
    for (const [id, until] of kindAsleep) asleep.set(id, until);
  }
  yield* KinWatches.settleClock({
    orgId,
    at,
    moved,
    asleep,
    watches: before.filter((watch) => kinds.some(({ kind }) => kind === watch.kind)),
  });
  const due = (yield* KinWatches.openWatches(orgId)).filter(
    (watch) => watch.askedLookAt !== null || (watch.nextLookAt <= at && watch.aside === 0),
  );
  const looks: Array<KinWatches.Look> = [];
  for (const watch of due) {
    const kind = kinds.find(({ kind }) => kind === watch.kind);
    // A kind this host doesn't run yet keeps its row for the host that does.
    if (kind === undefined) continue;
    const checked = yield* kind.check(ctx, watch).pipe(
      NodeSqliteClient.readOnly,
      Effect.catch((cause) =>
        Effect.logWarning("Kin watch check failed", { orgId, watchId: watch.watchId, cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    // Only reading can tell: the scout's, which this host doesn't run yet.
    if (checked === undefined || checked._tag === "read") continue;
    const late =
      checked._tag !== "closed" && watch.latestBy !== null && watch.latestBy <= at
        ? {
            _tag: "problem" as const,
            line: `due by ${formatKinWhen(watch.latestBy, "day", { zone: ctx.zone, locale: KIN_TEXT_LOCALE })}, not done yet`,
            evidence: [],
          }
        : undefined;
    looks.push({
      watch,
      why: whyOf(watch),
      outcome: late ?? checked,
      checksWork: kind.checksWork,
    });
  }
  return yield* KinWatches.recordRound({ orgId, at, looks });
});

/** When each org's sources were last found, and its change number then. */
export type Rounds = Map<string, { readonly at: number; readonly seq: number }>;

/** One scheduler pass: each org runs a round when its sources are due a look or a watch is due. */
// Untraced: the scheduler runs it every few seconds; each org's `round` carries its own span.
const pass = Effect.fnUntraced(
  function* (last: Rounds) {
    const sql = yield* SqlClient.SqlClient;
    const now = yield* Clock.currentTimeMillis;
    // Scheduler maintenance scans organizations; each round below is org-scoped.
    const orgs = yield* sql<{
      orgId: string;
      seq: number | null;
      due: number;
    }>`SELECT o.org_id AS "orgId",
        (SELECT MAX(c.seq) FROM kin_record_changes c WHERE c.org_id = o.org_id) AS seq,
        EXISTS (SELECT 1 FROM kin_watches w WHERE w.org_id = o.org_id AND w.state = 'open'
          AND (w.next_look_at <= ${now} OR w.asked_look_at IS NOT NULL)) AS due
      FROM kin_orgs o ORDER BY o.org_id`.pipe(NodeSqliteClient.readOnly);
    for (const { orgId, seq, due } of orgs) {
      const seen = last.get(orgId);
      const find = seen === undefined || seen.seq !== (seq ?? 0) || now - seen.at >= ROUND_EVERY_MS;
      if (!find && due === 0) continue;
      if (find) last.set(orgId, { at: now, seq: seq ?? 0 });
      yield* round(KinOrgId.make(orgId), now, { find }).pipe(
        Effect.catch((cause) => Effect.logWarning("Kin watch round failed", { orgId, cause })),
      );
    }
  },
  Effect.catch((cause) => Effect.logWarning("Kin watch scan failed", { cause })),
);

/** Each org's round, on the shared scheduler beside the pulse. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const ticks = yield* Scheduler.Scheduler;
    const refreshes = yield* KinRefreshObserver;
    const last: Rounds = new Map();
    yield* ticks.register(
      "kin-watch-rounds",
      Effect.suspend(() => pass(last)).pipe(Effect.provideService(KinRefreshObserver, refreshes)),
    );
  }),
);
