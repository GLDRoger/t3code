import {
  KinEvent,
  KinEventId,
  KinOrgId,
  type KinAgentId,
  type KinPulseOutsideLine,
} from "@t3tools/contracts";
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
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import * as Scheduler from "../../scheduling/Scheduler.ts";
import { KinConnections, MAIL_FEED_WINDOW } from "../connections/ConnectionsService.ts";
import { type MailArrival, receivedAmong } from "../connections/MailProvider.ts";
import { MAIL_PRESETS } from "../connections/mailProviders.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { agentQuietUntil } from "../triggers/quietHold.ts";
import { logTouch } from "../work/touches.ts";
import * as ArrivalStore from "./ArrivalStore.ts";
import { type ArrivalLook, type ArrivalRows, classify } from "./classify.ts";

/** Each mailbox is read once a minute; a host with no public address can't be told sooner. */
const FEED_EVERY_MS = 60_000;
/** A failing read (a vendor's rate limit, an outage) waits longer each time, up to this. */
const BACK_OFF_MAX_MS = 30 * 60_000;
const PRUNE_EVERY_MS = 86_400_000;

export type FeedRead = {
  /** The mailbox's mail reads are off, so nothing was read. */
  readonly off: boolean;
  /** More of the change record waits; the next read goes on at once. */
  readonly more: boolean;
  /** The arrivals this read queued a wake for. */
  readonly woke: ReadonlyArray<string>;
};

/** A mailbox's read failed before it committed: nothing moved, and the next read tries again. */
export class KinArrivalFeedError extends Schema.TaggedError<KinArrivalFeedError>()(
  "KinArrivalFeedError",
  { connectionId: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return "Kin couldn't read a mailbox's new mail.";
  }
}

export class KinArrivalFeed extends Context.Service<
  KinArrivalFeed,
  {
    /**
     * One read of one mailbox's change record. What it names that is new mail becomes one
     * arrival, classified by code; a look-worthy one wakes the agent today's watch woke, once.
     */
    readonly read: (
      orgId: KinOrgId,
      connectionId: string,
    ) => Effect.Effect<FeedRead, KinArrivalFeedError>;
  }
>()("t3/kin/arrivals/ArrivalFeed/KinArrivalFeed") {}

const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const shortHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 32);
const cut = (text: string | null | undefined, max: number) =>
  text === null || text === undefined ? null : Array.from(text).slice(0, max).join("");
const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const make = Effect.gen(function* () {
  const connections = yield* KinConnections;
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue.KinEventQueue;

  /** Finance for money, the Chief of staff for the rest, as the 3-minute watch chose. */
  const agentFor = Effect.fnUntraced(function* (orgId: KinOrgId, by: ArrivalLook["by"]) {
    const chief = (yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN }))?.agentId;
    if (by === "chief") return chief;
    const wanted = by === "finance" ? undefined : by.agentId;
    const [lead] = yield* sql<{ agentId: KinAgentId }>`SELECT l.agent_id AS "agentId"
      FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        AND a.role = 'lead' AND a.retired_at IS NULL
      WHERE l.org_id = ${orgId}
        AND ${wanted === undefined ? sql`l.domain = 'finance'` : sql`l.agent_id = ${wanted}`}
      ORDER BY a.created_at, l.agent_id LIMIT 1`;
    return lead?.agentId ?? chief;
  });

  const arrive = Effect.fnUntraced(function* (input: {
    readonly orgId: KinOrgId;
    readonly connectionId: string;
    readonly label: string;
    readonly mailbox: {
      readonly account: string | null;
      readonly addresses: ReadonlyArray<string>;
    };
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
    let mailKey = from === null ? null : ArrivalStore.mailKeyOf(orgId, from, arrival.internetId);
    let reason = classified.reason;
    let agentId: KinAgentId | undefined;
    const elsewhere = yield* ArrivalStore.heldElsewhere(orgId, mailKey, arrivalId);
    if (elsewhere !== undefined) {
      reason = `also came in at ${elsewhere}; looked at there`;
      mailKey = null;
    } else if (classified.look !== undefined) {
      agentId = yield* agentFor(orgId, classified.look.by);
      const stranger =
        classified.class === "unknown_person" || classified.class === "failed_checks";
      const looks =
        stranger && from !== null ? yield* ArrivalStore.looksToday(orgId, from, now) : undefined;
      if (agentId === undefined) reason = "no agent could look at it";
      else if (looks !== undefined && looks.count >= ArrivalStore.UNKNOWN_LOOKS_PER_DAY) {
        reason = `more from this sender today; the first is with ${looks.first ?? "an agent"}`;
        agentId = undefined;
      }
    }
    const dedupeKey = `arrival:${arrivalId}`;
    const eventId = agentId === undefined ? null : `pulse-${shortHash(`${orgId}\0${dedupeKey}`)}`;
    const made = yield* ArrivalStore.claim(
      orgId,
      {
        arrivalId,
        connectionId: input.connectionId,
        messageId: arrival.messageId,
        threadId: arrival.threadId,
        mailKey,
        fromAddress: from,
        receivedAt: arrival.receivedAt,
        class: classified.class,
        reason,
        agentId: agentId ?? null,
        eventId,
      },
      now,
      parked !== undefined,
    );
    if (!made || agentId === undefined || eventId === null || classified.look === undefined)
      return undefined;
    const to = receivedAmong(input.mailbox, [...arrival.to, ...arrival.cc, ...arrival.deliveredTo]);
    const line: KinPulseOutsideLine = {
      source: "mail",
      connection: cut(input.label, 120)!,
      ...(input.mailbox.account === null ? {} : { account: cut(input.mailbox.account, 320)! }),
      ...(to === null ? {} : { to: cut(to, 320)! }),
      id: cut(`${arrival.threadId}:${arrival.date ?? ""}`, 200)!,
      at: cut(arrival.date, 60),
      who: cut(arrival.from, 300),
      subject: cut(arrival.subject, 300),
      where: null,
      matched: cut(classified.look.matched, 300)!,
    };
    // Mail from a client is contact with that client, as the watch logged it.
    if (classified.look.clientId !== undefined)
      yield* logTouch(orgId, {
        partyId: classified.look.clientId,
        kind: "email",
        at: Math.min(arrival.receivedAt, now),
        note: arrival.subject.slice(0, 300),
        personId: null,
        by: { kind: "agent", id: agentId },
        originKey: `mail-in:${dedupeKey}`,
        now,
      }).pipe(
        Effect.catch((cause) => Effect.logWarning("Kin couldn't note client mail", { cause })),
      );
    const notBefore = yield* agentQuietUntil(orgId, agentId, now);
    const queued = yield* queue
      .enqueue(
        yield* decodeEvent({
          _tag: "pulse",
          orgId,
          eventId: KinEventId.make(eventId),
          agentId,
          receivedAt: isoOf(now),
          dedupeKey,
          provenance: { _tag: "system" },
          factKeys: [],
          outside: [line],
          arrivalId,
        }),
        notBefore === undefined ? undefined : { notBefore },
      )
      .pipe(
        Effect.as(true),
        Effect.catchTags({
          KinEventQueueUnknownAgent: () => Effect.succeed(false),
          KinEventQueueRetiredAgent: () => Effect.succeed(false),
          KinEventQueueConflict: () => Effect.succeed(false),
        }),
      );
    if (!queued) {
      yield* ArrivalStore.settleNothing(orgId, arrivalId, "no agent could look at it", now);
      return undefined;
    }
    return arrivalId;
  });

  const read = Effect.fn("KinArrivalFeed.read")(
    function* (orgId: KinOrgId, connectionId: string) {
      const found = yield* connections.changes(orgId, connectionId);
      if (found._tag === "off") return { off: true, more: false, woke: [] } satisfies FeedRead;
      const now = yield* Clock.currentTimeMillis;
      // A vendor can name one message twice in a page (added, then labelled Inbox again).
      const named = new Map(found.changes.map((change) => [change.messageId, change]));
      const seen = yield* ArrivalStore.known(orgId, connectionId, [...named.keys()]);
      const fresh = [...named.values()].filter((change) => !seen.has(change.messageId));
      const parked = yield* ArrivalStore.parkedDue(orgId, connectionId, now);
      // Reads go out before the transaction; only what they found is written, in one commit.
      const reads = yield* connections.arrivals(orgId, connectionId, [
        ...fresh.map((change) => change.messageId),
        ...parked.map((one) => one.messageId),
      ]);
      const [connection] = yield* sql<{ label: string }>`SELECT label FROM kin_connections
      WHERE org_id = ${orgId} AND connection_id = ${connectionId}`;
      const mailbox = { account: found.account, addresses: found.addresses };
      const woke = yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* ArrivalStore.rowsFor(orgId, connectionId, found.addresses);
          const woke: Array<string> = [];
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
            const arrivalId = yield* arrive({
              orgId,
              connectionId,
              label: connection?.label ?? found.account ?? "Mail",
              mailbox,
              rows,
              arrival: result.arrival,
              parked: retried,
              now,
            });
            if (arrivalId !== undefined) woke.push(arrivalId);
          }
          if (found.gap !== null)
            yield* ArrivalStore.gap(
              orgId,
              connectionId,
              found.gap,
              `Kin couldn't see mail between ${isoOf(found.gap.from)} and ${isoOf(found.gap.to)}`,
            );
          yield* connections.changesSeen(orgId, connectionId, found.cursor);
          return woke;
        }),
      );
      return { off: false, more: found.more, woke } satisfies FeedRead;
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
        const rows = yield* sql<{ orgId: string; connectionId: string }>`SELECT org_id AS "orgId",
            connection_id AS "connectionId" FROM kin_connections
          WHERE preset IN ${sql.in(MAIL_PRESETS)} AND removed_at IS NULL AND paused_at IS NULL
            AND state = 'active'
          ORDER BY org_id, created_at, connection_id`.pipe(NodeSqliteClient.readOnly);
        for (const { orgId, connectionId } of rows) {
          const next = due.get(connectionId);
          if (next !== undefined && now < next.at) continue;
          const exit = yield* Effect.exit(feed.read(KinOrgId.make(orgId), connectionId));
          if (Exit.isSuccess(exit)) {
            due.set(connectionId, {
              at: now + (exit.value.more ? 0 : FEED_EVERY_MS),
              failures: 0,
            });
            continue;
          }
          const failures = (next?.failures ?? 0) + 1;
          due.set(connectionId, {
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
