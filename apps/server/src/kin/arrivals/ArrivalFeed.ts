import { KinOrgId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as Scheduler from "../../scheduling/Scheduler.ts";
import { connectionById } from "../connections/ConnectionRows.ts";
import { KinConnections, MAIL_FEED_WINDOW } from "../connections/ConnectionsService.ts";
import { type MailArrival, receivedAmong } from "../connections/MailProvider.ts";
import { MAIL_PRESETS } from "../connections/mailProviders.ts";
import { DAY_MS, MINUTE_MS } from "../durations.ts";
import { KinEventQueue } from "../lead/KinEventQueue.ts";
import { type Matched, mailLine, NEW_SENDERS_PER_POLL, wakeMatches } from "../pulse/outside.ts";
import * as ArrivalStore from "./ArrivalStore.ts";
import { type ArrivalRows, classify } from "./classify.ts";

/** Each mailbox is read once a minute; a host with no public address can't be told sooner. */
const FEED_EVERY_MS = MINUTE_MS;
/** A failing read (a vendor's rate limit, an outage) waits longer each time, up to this. */
const BACK_OFF_MAX_MS = 30 * MINUTE_MS;
const PRUNE_EVERY_MS = DAY_MS;

type FeedRead = {
  /** The mailbox's mail reads are off, so nothing was read. */
  readonly off: boolean;
  /** More of the change record waits; the next read goes on at once. */
  readonly more: boolean;
  /** The arrivals this read classified for the first time. */
  readonly recorded: ReadonlyArray<string>;
};

/** A mailbox's read failed before it committed: nothing moved, and the next read tries again. */
class KinArrivalFeedError extends Schema.TaggedError<KinArrivalFeedError>()("KinArrivalFeedError", {
  connectionId: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "Kin couldn't read a mailbox's new mail.";
  }
}

export class KinArrivalFeed extends Context.Service<
  KinArrivalFeed,
  {
    /**
     * One read of one mailbox's change record. What it names that is new mail becomes one
     * arrival, classified by code. Automated notices go through the outside watch's wake path.
     */
    readonly read: (
      orgId: KinOrgId,
      connectionId: string,
    ) => Effect.Effect<FeedRead, KinArrivalFeedError>;
  }
>()("t3/kin/arrivals/ArrivalFeed/KinArrivalFeed") {}

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const make = Effect.gen(function* () {
  const connections = yield* KinConnections;
  const queue = yield* KinEventQueue;
  const sql = yield* SqlClient.SqlClient;

  // Per-message work shares the mailbox read's span.
  const arrive = Effect.fnUntraced(function* (input: {
    readonly orgId: KinOrgId;
    readonly connectionId: string;
    readonly rows: ArrivalRows;
    readonly arrival: MailArrival;
    readonly parked: ArrivalStore.Parked | undefined;
    readonly now: number;
  }) {
    const { orgId, arrival, parked, now } = input;
    const classified = classify(arrival, input.rows);
    const arrivalId =
      parked?.arrivalId ?? ArrivalStore.arrivalIdOf(orgId, input.connectionId, arrival.messageId);
    // Our own mail in our Inbox is not an arrival.
    if (classified.class === "own") {
      if (parked !== undefined)
        yield* ArrivalStore.settleNothing(orgId, arrivalId, classified.reason, now);
      return undefined;
    }
    const from = arrival.fromAddress?.toLowerCase() ?? null;
    const mailKey = from === null ? null : ArrivalStore.mailKeyOf(orgId, from, arrival.internetId);
    const elsewhere = yield* ArrivalStore.recordedElsewhere(orgId, mailKey, arrivalId);
    const made = yield* ArrivalStore.claim(
      orgId,
      {
        arrivalId,
        connectionId: input.connectionId,
        messageId: arrival.messageId,
        threadId: arrival.threadId,
        mailKey: elsewhere ? null : mailKey,
        fromAddress: from,
        receivedAt: arrival.receivedAt,
        class: classified.class,
        reason: elsewhere ? "also recorded in another connected mailbox" : classified.reason,
        needsLook: !elsewhere && classified.look !== undefined,
      },
      now,
      parked !== undefined,
    );
    if (!made) return undefined;
    return {
      arrivalId,
      look: !elsewhere && classified.class === "automated_notice" ? classified.look : undefined,
    };
  });

  const read = Effect.fn("KinArrivalFeed.read")(
    function* (orgId: KinOrgId, connectionId: string) {
      const found = yield* connections.changes(orgId, connectionId);
      if (found._tag === "off") return { off: true, more: false, recorded: [] } satisfies FeedRead;
      const now = yield* Clock.currentTimeMillis;
      // A vendor can name one message twice in a page (added, then labelled Inbox again).
      const named = new Map(found.changes.map((change) => [change.messageId, change]));
      const seen = yield* ArrivalStore.known(orgId, connectionId, [...named.keys()]);
      const fresh = [...named.values()].filter((change) => !seen.has(change.messageId));
      const parked = yield* ArrivalStore.parkedDue(orgId, connectionId, now);
      // Reads go out before the transaction; only what they found is written, in one commit.
      const messageIds = [
        ...fresh.map((change) => change.messageId),
        ...parked.map((one) => one.messageId),
      ];
      const reads =
        messageIds.length === 0 ? [] : yield* connections.arrivals(orgId, connectionId, messageIds);
      const recorded = yield* sql.withTransaction(
        Effect.gen(function* () {
          let rows: ArrivalRows | undefined;
          let connection: Effect.Success<ReturnType<typeof connectionById>>;
          const recorded: Array<string> = [];
          const notices: Array<Matched> = [];
          for (const [index, result] of reads.entries()) {
            const retried = index >= fresh.length ? parked[index - fresh.length] : undefined;
            const change = fresh[index];
            if (result._tag === "unreadable") {
              if (retried !== undefined) yield* ArrivalStore.parkedAgain(orgId, retried, now);
              else if (change !== undefined)
                yield* ArrivalStore.park(orgId, connectionId, change, now);
              continue;
            }
            if (result._tag === "gone") {
              if (retried !== undefined)
                yield* ArrivalStore.settleNothing(
                  orgId,
                  retried.arrivalId,
                  "the mail was gone before Kin could read it",
                  now,
                );
              continue;
            }
            // Received well before the feed's last read: an update or a move back, not new mail.
            const floor =
              retried === undefined ? found.floor : retried.noticedAt - MAIL_FEED_WINDOW.marginMs;
            if (result.arrival.receivedAt < floor) {
              if (retried !== undefined)
                yield* ArrivalStore.settleNothing(
                  orgId,
                  retried.arrivalId,
                  "older mail, not new",
                  now,
                );
              continue;
            }
            rows ??= yield* ArrivalStore.rowsFor(orgId, connectionId, found.addresses);
            const arrived = yield* arrive({
              orgId,
              connectionId,
              rows,
              arrival: result.arrival,
              parked: retried,
              now,
            });
            if (arrived === undefined) continue;
            recorded.push(arrived.arrivalId);
            const { look } = arrived;
            if (
              look === undefined ||
              typeof look.by !== "string" ||
              notices.length >= NEW_SENDERS_PER_POLL
            )
              continue;
            connection ??= yield* connectionById(orgId, connectionId);
            if (connection === undefined) continue;
            const mailbox = { account: connection.accountLabel, addresses: found.addresses };
            const line = mailLine(connection.label, mailbox.account, {
              ...result.arrival,
              receivedBy: receivedAmong(mailbox, result.arrival.deliveredTo),
            });
            notices.push({
              line: { ...line, matched: look.matched },
              domain: look.by,
              arrivalId: arrived.arrivalId,
            });
          }
          if (notices.length > 0)
            yield* wakeMatches(orgId, now, notices).pipe(
              Effect.provideService(KinEventQueue, queue),
            );
          if (found.gap !== null)
            yield* ArrivalStore.gap(
              orgId,
              connectionId,
              found.gap,
              `Kin couldn't see mail between ${isoOf(found.gap.from)} and ${isoOf(found.gap.to)}`,
            );
          yield* connections.changesSeen(orgId, connectionId, found.cursor);
          return recorded;
        }),
      );
      return { off: false, more: found.more, recorded } satisfies FeedRead;
    },
    (effect, _orgId, connectionId) =>
      effect.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((cause) => new KinArrivalFeedError({ connectionId, cause })),
      ),
  );

  return KinArrivalFeed.of({ read });
});

export const layer = Layer.effect(KinArrivalFeed, make);

/**
 * On the shared scheduler: each signed-in, unpaused mailbox whose mail reads are on is read once
 * a minute, sooner while a long change record pages, later after a failure; the cursor moves
 * only with what a read committed, so a back-off loses nothing.
 */
const runtimeLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const feed = yield* KinArrivalFeed;
    const sql = yield* SqlClient.SqlClient;
    const ticks = yield* Scheduler.Scheduler;
    const due = new Map<string, { readonly at: number; readonly failures: number }>();
    let pruned = Number.NEGATIVE_INFINITY;
    yield* ticks.register(
      "kin-arrivals",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now - pruned >= PRUNE_EVERY_MS) {
          pruned = now;
          yield* ArrivalStore.prune(now).pipe(
            Effect.catch((cause) => Effect.logWarning("Kin couldn't prune arrivals", { cause })),
          );
        }
        // Scheduler maintenance: every org's live mail connections; each read is org-scoped.
        // A person's own mailbox is theirs alone (`turnMailbox.ts`): never read for the company.
        const rows = yield* sql<{ orgId: string; connectionId: string }>`SELECT org_id AS "orgId",
            connection_id AS "connectionId" FROM kin_connections
          WHERE preset IN ${sql.in(MAIL_PRESETS)} AND removed_at IS NULL AND paused_at IS NULL
            AND state = 'active' AND person_id IS NULL
          ORDER BY org_id, created_at, connection_id`.pipe(NodeSqliteClient.readOnly);
        for (const { orgId, connectionId } of rows) {
          const key = `${orgId}\0${connectionId}`;
          const next = due.get(key);
          if (next !== undefined && now < next.at) continue;
          const exit = yield* Effect.exit(feed.read(KinOrgId.make(orgId), connectionId));
          if (Exit.isSuccess(exit)) {
            due.set(key, {
              at: now + (exit.value.more ? 0 : FEED_EVERY_MS),
              failures: 0,
            });
            continue;
          }
          const failures = (next?.failures ?? 0) + 1;
          due.set(key, {
            at: now + Math.min(BACK_OFF_MAX_MS, FEED_EVERY_MS * 2 ** failures),
            failures,
          });
          yield* Effect.logWarning("Kin couldn't read a mailbox's new mail", {
            orgId,
            connectionId,
            failures,
            cause: exit.cause,
          });
        }
      }).pipe(Effect.catch((cause) => Effect.logWarning("Kin arrival scan failed", { cause }))),
    );
  }),
);

/** Only where connections are built (Kin's own layers); without them no mailbox is watched. */
export const liveLayer = Layer.unwrap(
  Effect.map(Effect.serviceOption(KinConnections), (connections) =>
    Option.isNone(connections)
      ? Layer.empty
      : runtimeLayer.pipe(
          Layer.provide(layer),
          Layer.provide(Layer.succeed(KinConnections, connections.value)),
        ),
  ),
);
