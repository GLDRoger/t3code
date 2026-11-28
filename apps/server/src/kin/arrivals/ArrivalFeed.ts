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
import { KinAttachmentStore } from "../chat/KinAttachmentStore.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinConnections, MAIL_FEED_WINDOW } from "../connections/ConnectionsService.ts";
import { type MailArrival, receivedAmong } from "../connections/MailProvider.ts";
import { normalizeAddress } from "../connections/MailSignals.ts";
import { MAIL_PRESETS } from "../connections/mailProviders.ts";
import { DAY_MS, MINUTE_MS } from "../durations.ts";
import { KinEventQueue } from "../lead/KinEventQueue.ts";
import { mailLine } from "../pulse/outside.ts";
import { sectionOnFor } from "../shell/KinShell.ts";
import { billsOnMail, pruneHeldBillMail } from "../work/billMail/billSenderArrivals.ts";
import { offer } from "../work/billMail/billSenderCards.ts";
import { readBillMail } from "../work/billMail/billMailReads.ts";
import { KinRecords } from "../work/KinRecords.ts";
import { quietBankSenderAddresses } from "../work/statements/bankSenderRows.ts";
import * as ArrivalStore from "./ArrivalStore.ts";
import { type ArrivalRows, classify } from "./classify.ts";
import { companyRuleMailbox } from "./ruleAccess.ts";
import { mailRuleHeaderFacts, matchMailRule } from "./ruleMatch.ts";
import {
  playbookRoute,
  routeLateRuleHolds,
  takeHeldRulePlaybook,
  wakePlaybookMail,
  type PlaybookMail,
} from "./rulePlaybook.ts";
import {
  activeRuleIds,
  alreadyClaimedRuleMail,
  claimRuleMail,
  flushRuleMail,
  matchingRules,
} from "./ruleWake.ts";

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
     * arrival, classified by code. Mail watches use the arrivals committed by that read.
     */
    readonly read: (
      orgId: KinOrgId,
      connectionId: string,
      moneyOn?: boolean,
    ) => Effect.Effect<FeedRead, KinArrivalFeedError>;
  }
>()("t3/kin/arrivals/ArrivalFeed/KinArrivalFeed") {}

const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const make = Effect.gen(function* () {
  const connections = yield* KinConnections;
  const queue = yield* KinEventQueue;
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const sql = yield* SqlClient.SqlClient;
  // The scheduler's tick runs outside Kin's layers, so rule history moves use this one.
  const refresh = yield* KinRefreshObserver;

  // Per-message work shares the mailbox read's span.
  const arrive = Effect.fnUntraced(function* (input: {
    readonly orgId: KinOrgId;
    readonly connectionId: string;
    readonly rows: ArrivalRows;
    readonly moneyOn: boolean;
    readonly arrival: MailArrival;
    readonly parked: ArrivalStore.Parked | undefined;
    readonly now: number;
  }) {
    const { orgId, arrival, parked, now } = input;
    const classified = classify(arrival, input.rows);
    const arrivalId =
      parked?.arrivalId ?? ArrivalStore.arrivalIdOf(orgId, input.connectionId, arrival.messageId);
    const billArrival = {
      orgId,
      connectionId: input.connectionId,
      mail: arrival,
      knownBillers: input.rows.billers,
      moneyOn: input.moneyOn,
      now,
    };
    // A company address already approved for bills is independent of ordinary arrival classes.
    if (classified.class === "own") {
      yield* billsOnMail({ ...billArrival, candidateAllowed: false });
      if (parked !== undefined)
        yield* ArrivalStore.settleNothing(orgId, arrivalId, classified.reason, now);
      return undefined;
    }
    const facts = mailRuleHeaderFacts(arrival);
    const from = arrival.fromAddress?.toLowerCase() ?? facts.fromAddress;
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
        hasFile: facts.hasFile,
        senderCheck: facts.senderCheck,
      },
      now,
      parked !== undefined,
    );
    if (!made) return undefined;
    yield* billsOnMail(billArrival);
    return {
      arrivalId,
      class: classified.class,
      look: elsewhere ? undefined : classified.look,
      facts,
      mailKey,
    };
  });

  const read = Effect.fn("KinArrivalFeed.read")(
    function* (orgId: KinOrgId, connectionId: string, tickMoneyOn?: boolean) {
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
      const startedOn =
        messageIds.length === 0 ? new Set<string>() : yield* activeRuleIds(orgId, connectionId);
      const moneyOn =
        tickMoneyOn ?? (messageIds.length > 0 && (yield* sectionOnFor(orgId, "money")));
      const approved = new Set(
        !moneyOn || messageIds.length === 0
          ? []
          : (yield* sql<{ address: string }>`SELECT address FROM kin_bill_senders
              WHERE org_id = ${orgId} AND state = 'approved'`).map((row) => row.address),
      );
      const reads =
        messageIds.length === 0
          ? []
          : yield* connections.arrivals(
              orgId,
              connectionId,
              messageIds,
              (arrival) => !approved.has(normalizeAddress(arrival.fromAddress) ?? ""),
            );
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          let rows: ArrivalRows | undefined;
          const connection = yield* companyRuleMailbox(orgId, connectionId);
          let hiddenBankSenders: Set<string> | undefined;
          const recorded: Array<string> = [];
          const playbook = new Map<string, PlaybookMail>();
          const ruleCandidates = new Set<string>();
          const rules = yield* matchingRules(orgId, connectionId);
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
            // Nor is anything received while the mailbox was someone's own, put back or parked.
            const floor = Math.max(
              retried === undefined ? found.floor : retried.noticedAt - MAIL_FEED_WINDOW.marginMs,
              found.ownUntil === null ? Number.NEGATIVE_INFINITY : found.ownUntil + 1,
            );
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
              moneyOn,
              arrival: result.arrival,
              parked: retried,
              now,
            });
            if (arrived === undefined) continue;
            recorded.push(arrived.arrivalId);
            const { class: mailClass, look } = arrived;
            const arrivalId = arrived.arrivalId;
            const quietBankSender =
              look !== undefined &&
              typeof look.by === "string" &&
              (hiddenBankSenders ??= yield* quietBankSenderAddresses(orgId, moneyOn)).size > 0 &&
              hiddenBankSenders.has(normalizeAddress(result.arrival.fromAddress) ?? "");
            const ordinary =
              !quietBankSender &&
              connection !== undefined &&
              look !== undefined &&
              typeof look.by === "string" &&
              (mailClass === "unknown_person" ||
                mailClass === "automated_notice" ||
                mailClass === "client" ||
                mailClass === "names_money")
                ? {
                    line: {
                      ...mailLine(connection.label, connection.account, {
                        ...result.arrival,
                        receivedBy: receivedAmong(
                          { account: connection.account, addresses: found.addresses },
                          result.arrival.deliveredTo,
                        ),
                      }),
                      matched: look.matched,
                    },
                    domain: look.by,
                    ...(look.clientId === undefined ? {} : { clientId: look.clientId }),
                    arrivalId,
                    mailClass,
                  }
                : undefined;
            if (ordinary !== undefined) playbook.set(arrivalId, ordinary);

            // The oldest rule that runs on the mail claims it; else the oldest that holds it.
            let runs: (typeof rules)[number]["rule"] | undefined;
            let holds: typeof runs;
            for (const { rule, filter } of rules) {
              if (rule.state !== "on" && !startedOn.has(rule.ruleId)) continue;
              const resultOfRule = matchMailRule(filter, {
                ...arrived.facts,
                connectionId,
                class: mailClass,
                subject: result.arrival.subject,
              });
              if (resultOfRule === "no_match") continue;
              if (yield* alreadyClaimedRuleMail(rule, arrived.mailKey)) continue;
              if (resultOfRule === "match") {
                runs = rule;
                break;
              }
              holds ??= rule;
            }
            if (runs !== undefined) {
              yield* claimRuleMail(
                runs,
                arrivalId,
                arrived.mailKey,
                "match",
                playbookRoute(ordinary),
              );
              ruleCandidates.add(arrivalId);
            } else if (holds !== undefined) {
              yield* claimRuleMail(holds, arrivalId, arrived.mailKey, "held_unverified", null);
            }
          }
          yield* flushRuleMail(rules, yield* Clock.currentTimeMillis).pipe(
            Effect.provideService(KinEventQueue, queue),
            Effect.provideService(KinChatRepository, repo),
            Effect.provideService(KinChatHub, hub),
          );
          const held = yield* takeHeldRulePlaybook(orgId, connectionId, playbook);
          const heldIds = new Set(held.map(({ arrivalId }) => arrivalId));
          const eligible = [
            ...held.filter(({ arrivalId }) => !playbook.has(arrivalId)),
            ...Array.from(playbook.values()).filter(
              ({ arrivalId }) => !ruleCandidates.has(arrivalId) || heldIds.has(arrivalId),
            ),
          ];
          yield* wakePlaybookMail(orgId, now, eligible).pipe(
            Effect.provideService(KinEventQueue, queue),
          );
          if (connection !== undefined) {
            if (found.gap !== null)
              yield* ArrivalStore.gap(
                orgId,
                connectionId,
                found.gap,
                `Kin couldn't see mail between ${isoOf(found.gap.from)} and ${isoOf(found.gap.to)}`,
              );
            yield* connections.changesSeen(orgId, connectionId, found.cursor);
          }
          return {
            off: false,
            more: connection !== undefined && found.more,
            recorded,
          } satisfies FeedRead;
        }),
      );
    },
    (effect, _orgId, connectionId) =>
      effect.pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(KinRefreshObserver, refresh),
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
    const chat = yield* KinChatService;
    const connections = yield* KinConnections;
    const queue = yield* KinEventQueue;
    const store = yield* Effect.serviceOption(KinAttachmentStore);
    const repo = yield* Effect.serviceOption(KinChatRepository);
    const hub = yield* Effect.serviceOption(KinChatHub);
    const records = yield* Effect.serviceOption(KinRecords);
    const drain =
      Option.isSome(store) && Option.isSome(repo) && Option.isSome(hub) && Option.isSome(records)
        ? (orgId: KinOrgId, now: number, moneyOn: boolean) =>
            readBillMail(orgId, now, moneyOn).pipe(
              Effect.provideService(KinConnections, connections),
              Effect.provideService(KinEventQueue, queue),
              Effect.provideService(KinAttachmentStore, store.value),
              Effect.provideService(KinChatRepository, repo.value),
              Effect.provideService(KinChatHub, hub.value),
              Effect.provideService(KinRecords, records.value),
            )
        : () => Effect.logDebug("Kin bill mail reader services are unavailable");
    const due = new Map<string, { readonly at: number; readonly failures: number }>();
    let moneyWasOff = new Set<KinOrgId>();
    let pruned = Number.NEGATIVE_INFINITY;
    yield* ticks.register(
      "kin-arrivals",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now - pruned >= PRUNE_EVERY_MS) {
          pruned = now;
          yield* Effect.andThen(ArrivalStore.prune(now), pruneHeldBillMail(now)).pipe(
            Effect.catch((cause) => Effect.logWarning("Kin couldn't prune arrivals", { cause })),
          );
        }
        yield* routeLateRuleHolds(now).pipe(
          Effect.provideService(KinEventQueue, queue),
          Effect.catch((cause) => Effect.logWarning("Kin couldn't route held mail", { cause })),
        );
        // Scheduler maintenance: every org's live mail connections; each read is org-scoped.
        // A person's own mailbox is theirs alone (`turnMailbox.ts`): never read for the company.
        const rows = yield* sql<{ orgId: string; connectionId: string }>`SELECT org_id AS "orgId",
            connection_id AS "connectionId" FROM kin_connections
          WHERE preset IN ${sql.in(MAIL_PRESETS)} AND removed_at IS NULL AND paused_at IS NULL
            AND state = 'active' AND person_id IS NULL
          ORDER BY org_id, created_at, connection_id`.pipe(NodeSqliteClient.readOnly);
        const companies = new Map<KinOrgId, { moneyOn: boolean; billWorkDue: boolean } | null>();
        for (const { orgId, connectionId } of rows) {
          const company = KinOrgId.make(orgId);
          let scan = companies.get(company);
          if (scan === undefined) {
            scan = yield* sectionOnFor(company, "money").pipe(
              // A waiting bill can resume before the next mailbox read is due.
              Effect.map((moneyOn) => ({
                moneyOn,
                billWorkDue: moneyOn && moneyWasOff.has(company),
              })),
              Effect.catch((cause) =>
                Effect.logWarning("Kin couldn't read a company's Money setting", {
                  orgId,
                  cause,
                }).pipe(Effect.as(null)),
              ),
            );
            companies.set(company, scan);
          }
          if (scan === null) continue;
          const key = `${orgId}\0${connectionId}`;
          const next = due.get(key);
          if (next !== undefined && now < next.at) continue;
          const exit = yield* Effect.exit(feed.read(company, connectionId, scan.moneyOn));
          if (Exit.isSuccess(exit)) {
            scan.billWorkDue = true;
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
        const moneyOff = new Set<KinOrgId>();
        for (const [company, scan] of companies) {
          if (scan === null) {
            if (moneyWasOff.has(company)) moneyOff.add(company);
            continue;
          }
          const { moneyOn, billWorkDue } = scan;
          if (!moneyOn) moneyOff.add(company);
          if (!billWorkDue) continue;
          yield* Effect.gen(function* () {
            yield* offer(company, now, moneyOn).pipe(
              Effect.provideService(KinChatService, chat),
              Effect.catch(() => Effect.logWarning("Kin couldn't offer billing sender cards")),
            );
            yield* drain(company, now, moneyOn);
          }).pipe(Effect.catchCause(() => Effect.logWarning("Kin couldn't drain bill mail")));
        }
        moneyWasOff = moneyOff;
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
