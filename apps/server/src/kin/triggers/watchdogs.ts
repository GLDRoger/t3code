import {
  KinAgentId,
  KinChatId,
  KinEvent,
  KinEventId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinWatchdog,
  type KinWebhookSource,
  type MemoryItemHead,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as Chat from "../chat/KinChatService.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import { indexIsStale } from "../memory/buildIndex.ts";
import { memoryDateMillis } from "../memory/frontMatter.ts";
import * as Memory from "../memory/Memory.ts";
import * as MemoryCache from "../memory/MemoryCache.ts";
import { githubRef } from "./deferralGithub.ts";
import {
  type GithubConditionFacts,
  inRepoScope,
  KinGithubRepoScope,
  matchConditions,
  repoScopeLayer,
} from "./githubEvents.ts";
import { KinGithubWebhookLock } from "./githubWebhooks.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import * as KinTriggerService from "./KinTriggerService.ts";
import * as KinTriggerStore from "./KinTriggerStore.ts";
import * as Pings from "./pings.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WATCHDOG_EVERY_MS: Readonly<Record<KinWatchdog, number>> = {
  github_recheck: 10 * MINUTE,
  stale_review: 30 * MINUTE,
  promise_overdue: 30 * MINUTE,
  objective_at_risk: 6 * HOUR,
  index_freshness: HOUR,
  trigger_reconcile: 15 * MINUTE,
};
const READ_TIMEOUT = "30 seconds";
const PAGE = 100;
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);

/** One issue or pull request as GitHub has it now. */
export interface GithubItemState {
  readonly number: number;
  readonly kind: "issue" | "pull";
  readonly state: "open" | "closed" | "merged";
  /** Pending review requests on a pull request, with when each was made (epoch ms). */
  readonly reviewRequests: ReadonlyArray<{ readonly login: string; readonly requestedAt: number }>;
}

export class KinWatchdogGithubError extends Schema.TaggedError<KinWatchdogGithubError>()(
  "KinWatchdogGithubError",
  { orgId: KinOrgId, repo: Schema.String, reason: Schema.Literals(["unavailable", "timeout"]) },
) {}

export interface KinWatchdogGithubReaderShape {
  /** Read-only and batched: one call per repo for all of its numbers. Unknown numbers are left out. */
  readonly readRepo: (
    orgId: KinOrgId,
    repo: string,
    numbers: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyArray<GithubItemState>, KinWatchdogGithubError>;
}

// githubReaders.ts replaces this when the Kin App is configured. Without it the GitHub watchdogs
// stay off and `github_recheck` requests wait in the inbox.
export const KinWatchdogGithubReader = Context.Reference<KinWatchdogGithubReaderShape | null>(
  "t3/kin/triggers/watchdogs/KinWatchdogGithubReader",
  { defaultValue: () => null },
);

export class KinWatchdogsError extends Schema.TaggedError<KinWatchdogsError>()(
  "KinWatchdogsError",
  { orgId: KinOrgId, watchdog: Schema.String, cause: Schema.Defect() },
) {}

export class KinWatchdogs extends Context.Service<
  KinWatchdogs,
  {
    readonly run: (
      watchdog: KinWatchdog,
      orgId: KinOrgId,
    ) => Effect.Effect<void, KinWatchdogsError>;
  }
>()("t3/kin/triggers/watchdogs/KinWatchdogs") {}

interface Link {
  readonly repo: string;
  readonly number: number;
}
type Item = MemoryItemHead & { readonly duplicate: boolean };
const refKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
const githubUrl = (repo: string, state: GithubItemState) =>
  `https://github.com/${repo}/${state.kind === "issue" ? "issues" : "pull"}/${state.number}`;
const isDone = (state: GithubItemState) =>
  state.state === (state.kind === "issue" ? "closed" : "merged");
const shortHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 32);

/** What a condition can test, from an issue or PR's current state rather than an event. */
function conditionFactsFromState(repo: string, state: GithubItemState): GithubConditionFacts {
  return {
    event: state.kind === "pull" ? "pull_request" : "issues",
    action: state.state === "open" ? "opened" : "closed",
    repo,
    number: state.number,
    merged: state.kind === "pull" ? state.state === "merged" : null,
  };
}

/** The org's scoped GitHub links on an item, deduplicated. */
function linksOf(item: MemoryItemHead, repos: ReadonlyArray<string>): ReadonlyArray<Link> {
  const seen = new Map<string, Link>();
  for (const link of item.links) {
    const ref = githubRef(link);
    if (ref !== undefined && inRepoScope(repos, ref.repo))
      seen.set(refKey(ref.repo, ref.number), ref);
  }
  return [...seen.values()];
}

/** The repos a condition can be met in: its own, or every scoped repo. */
function conditionLinks(item: MemoryItemHead, repos: ReadonlyArray<string>): ReadonlyArray<Link> {
  if (item.on === undefined) return [];
  const { repo, number } = item.on;
  if (repo !== undefined) return inRepoScope(repos, repo) ? [{ repo, number }] : [];
  return repos.map((scoped) => ({ repo: scoped, number }));
}

/** Which way, if any, a webhook source has stopped delivering. Only the owner turns it back on. */
function observedSourceStatus(
  task: Pick<ScheduledTask, "enabled" | "blockedByPolicy"> | undefined,
): KinWebhookSource["status"] {
  if (task === undefined) return "missing";
  if (task.blockedByPolicy !== undefined) return "blocked_by_policy";
  return task.enabled ? "active" : "paused_in_t3";
}

const STATUS_NOTICE: Readonly<Record<KinWebhookSource["status"], string>> = {
  active: "GitHub events reach Kin again.",
  paused_in_t3:
    "GitHub events are paused: Kin's GitHub webhook task is turned off in T3's scheduled tasks. Kin won't turn it back on. Turn it on there, or run GitHub setup again.",
  blocked_by_policy:
    "GitHub events are blocked: this host's managed policy turns off webhook tasks. Kin will catch up from GitHub when a reader is available.",
  missing:
    "GitHub events stopped: Kin's GitHub webhook task was deleted. Run GitHub setup again to recreate it.",
};
const SECRET_NOTICE =
  "GitHub events are refused: Kin's GitHub webhook task has a secret Kin didn't bind. Send the GitHub App's webhook secret to Kin again, or run GitHub setup again.";

interface Lead {
  readonly agentId: KinAgentId;
  readonly owner: KinPersonId;
  readonly chatId: KinChatId;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const inbox = yield* KinTriggerInbox.KinTriggerInbox;
  const store = yield* KinTriggerStore.KinTriggerStore;
  const triggers = yield* KinTriggerService.KinTriggerService;
  const queue = yield* KinEventQueue.KinEventQueue;
  const memory = yield* Memory.Memory;
  const chat = yield* Chat.KinChatService;
  const pings = yield* Pings.KinPings;
  const scope = yield* KinGithubRepoScope;
  const ticks = yield* Scheduler.Scheduler;
  // Optional, as in githubEvents: lead-only test runtimes have no T3 scheduling.
  const tasks = yield* Effect.serviceOption(ScheduledTaskService.ScheduledTaskService);
  if (Option.isNone(tasks))
    yield* Effect.logWarning(
      "Kin watchdogs started without T3 scheduled tasks: webhook sources go unreconciled",
    );
  // The RPC handlers own this lock; without it a re-key can briefly read as a foreign secret.
  const lock = yield* Effect.serviceOption(KinGithubWebhookLock);

  const leadOf = Effect.fn("KinWatchdogs.lead")(function* (orgId: KinOrgId) {
    const [row] = yield* sql<{ agentId: string; owner: string; chatId: string }>`SELECT
      l.agent_id AS "agentId", a.owner_person_id AS owner, l.owner_chat_id AS "chatId"
      FROM kin_leads l JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
      WHERE l.org_id = ${orgId} AND a.retired_at IS NULL ORDER BY l.agent_id LIMIT 1`.pipe(
      NodeSqliteClient.readOnly,
    );
    return row === undefined
      ? undefined
      : ({
          agentId: KinAgentId.make(row.agentId),
          owner: KinPersonId.make(row.owner),
          chatId: KinChatId.make(row.chatId),
        } satisfies Lead);
  });

  const openItems = (orgId: KinOrgId) =>
    memory
      .query(orgId, { status: "open", excludeInvalid: true })
      .pipe(
        Effect.map((items) =>
          items.filter((item) => !item.duplicate && item.superseded_by === null),
        ),
      );

  /** One bounded read per repo; a repo that fails or times out is reported, not retried here. */
  const readStates = Effect.fn("KinWatchdogs.readStates")(function* (
    orgId: KinOrgId,
    reader: KinWatchdogGithubReaderShape,
    links: ReadonlyArray<Link>,
  ) {
    const byRepo = new Map<string, { readonly repo: string; readonly numbers: Set<number> }>();
    for (const link of links) {
      const key = link.repo.toLowerCase();
      const entry = byRepo.get(key) ?? { repo: link.repo, numbers: new Set<number>() };
      entry.numbers.add(link.number);
      byRepo.set(key, entry);
    }
    const states = new Map<string, GithubItemState>();
    const failed = new Set<string>();
    for (const [key, { repo, numbers }] of [...byRepo].toSorted(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )) {
      const read = yield* reader
        .readRepo(
          orgId,
          repo,
          [...numbers].toSorted((a, b) => a - b),
        )
        .pipe(
          Effect.timeoutOrElse({
            duration: READ_TIMEOUT,
            orElse: () =>
              Effect.fail(new KinWatchdogGithubError({ orgId, repo, reason: "timeout" })),
          }),
          Effect.result,
        );
      if (Result.isFailure(read)) {
        failed.add(key);
        yield* Effect.logWarning("Kin watchdog GitHub read failed", {
          orgId,
          repo,
          reason: read.failure.reason,
        });
        continue;
      }
      for (const state of read.success)
        if (numbers.has(state.number)) states.set(refKey(repo, state.number), state);
    }
    return {
      failed: (link: Link) => failed.has(link.repo.toLowerCase()),
      state: (link: Link) => states.get(refKey(link.repo, link.number)),
    };
  });

  type Finding = { readonly dedupeKey: string; readonly finding: string; readonly item: Item };
  /** Enqueues code-built findings for the lead, skipping ones already queued under their key. */
  const enqueueFindings = Effect.fn("KinWatchdogs.enqueueFindings")(function* (
    orgId: KinOrgId,
    lead: Lead,
    findings: ReadonlyArray<Finding>,
    now: number,
  ) {
    for (const { dedupeKey, finding, item } of findings) {
      const [seen] = yield* sql`SELECT event_id FROM kin_events
        WHERE org_id = ${orgId} AND dedupe_key = ${dedupeKey} ORDER BY event_id LIMIT 1`;
      if (seen !== undefined) continue;
      yield* queue.enqueue(
        yield* decodeEvent({
          _tag: "watchdog",
          orgId,
          eventId: KinEventId.make(`watchdog-${shortHash(`${orgId}\0${dedupeKey}`)}`),
          agentId: lead.agentId,
          receivedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          dedupeKey,
          // Server-written text; GitHub only supplied states, never prose.
          provenance: { _tag: "system" },
          finding,
          itemIds: [item.id],
        }),
      );
    }
  });

  const githubRecheck = Effect.fn("KinWatchdogs.githubRecheck")(function* (orgId: KinOrgId) {
    const reader = yield* KinWatchdogGithubReader;
    // Without a reader nothing is compared, so the requests wait rather than being consumed.
    if (reader === null) return;
    const now = yield* Clock.currentTimeMillis;
    const requests = yield* inbox.listPending(orgId, PAGE, undefined, ["github_recheck"]);
    const items = yield* openItems(orgId);
    const tracked = items.filter((item) => item.kind === "commitment" || item.kind === "deferral");
    const conditions = items.filter((item) => item.on !== undefined);
    const wanted = [
      ...tracked.flatMap((item) => linksOf(item, scope.repos)),
      ...conditions.flatMap((item) => conditionLinks(item, scope.repos)),
    ];
    const github = yield* readStates(orgId, reader, wanted);

    const findings: Array<Finding> = [];
    for (const item of tracked) {
      const links = linksOf(item, scope.repos);
      if (links.length === 0 || links.some(github.failed)) continue;
      const done = links.flatMap((link) => {
        const state = github.state(link);
        return state !== undefined && isDone(state)
          ? [{ url: githubUrl(link.repo, state), state: state.state }]
          : [];
      });
      if (done.length !== links.length) continue;
      const evidence = done.map(({ url }) => url);
      findings.push({
        item,
        dedupeKey: `watchdog:github_recheck:done:${item.id}:${evidence.join(",")}`,
        finding: `Verified on GitHub by code: ${done.map(({ url, state }) => `${url} is ${state}`).join(", ")}. Mark ${item.kind} ${item.id} done and record ${evidence.length === 1 ? "that link" : "those links"} as its evidence.`,
      });
    }
    for (const item of conditions)
      for (const link of conditionLinks(item, scope.repos)) {
        const state = github.state(link);
        if (state === undefined) continue;
        if (matchConditions(conditionFactsFromState(link.repo, state), [item]).length === 0)
          continue;
        const url = githubUrl(link.repo, state);
        findings.push({
          item,
          dedupeKey: `watchdog:github_recheck:condition:${item.id}:${refKey(link.repo, link.number)}:${state.state}`,
          finding: `GitHub state shows condition met (read from GitHub by code): ${url} is ${state.state}.`,
        });
      }

    const complete = wanted.every((link) => !github.failed(link));
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const lead = yield* leadOf(orgId);
        if (lead === undefined && findings.length > 0)
          yield* Effect.logWarning("Kin GitHub recheck findings dropped: no active lead", {
            orgId,
            count: findings.length,
          });
        if (lead !== undefined) yield* enqueueFindings(orgId, lead, findings, now);
        // Only a sweep that read every repo answers a request; otherwise it waits for the next.
        if (complete)
          yield* inbox.markConsumed(
            orgId,
            requests.map((fire) => fire.fireId),
          );
      }),
    );
  });

  /** Puts a chase unless this person has one for the item that is active or was stopped after `changedAt`. */
  const chase = Effect.fn("KinWatchdogs.chase")(function* (
    orgId: KinOrgId,
    lead: Lead,
    item: MemoryItemHead,
    person: KinPersonId,
    nextStep: string,
    changedAt: number,
  ) {
    if (item.chat === undefined)
      return yield* Effect.logDebug("Kin watchdog chase skipped: item has no chat", {
        orgId,
        itemId: item.id,
      });
    const [existing] = yield* sql<{ stoppedAt: number | null }>`SELECT stopped_at AS "stoppedAt"
      FROM kin_ping_items WHERE org_id = ${orgId} AND person = ${person} AND item_id = ${item.id}
      ORDER BY item_id`.pipe(NodeSqliteClient.readOnly);
    // An answered chase stays answered until what prompted it (a due date, a review request) moves.
    if (
      existing !== undefined &&
      (existing.stoppedAt === null || !(changedAt > existing.stoppedAt))
    )
      return;
    yield* pings
      .put(
        {
          orgId,
          person,
          itemId: item.id,
          chatId: item.chat,
          owner: lead.owner,
          ownerChatId: lead.chatId,
          nextStep,
        },
        item,
      )
      .pipe(
        Effect.catch((cause) =>
          Effect.logDebug("Kin watchdog chase failed", {
            orgId,
            itemId: item.id,
            errorTag: cause._tag,
          }),
        ),
      );
  });

  const promiseOverdue = Effect.fn("KinWatchdogs.promiseOverdue")(function* (orgId: KinOrgId) {
    const lead = yield* leadOf(orgId);
    if (lead === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    for (const item of yield* openItems(orgId)) {
      if (item.kind !== "commitment" || !(memoryDateMillis(item.due) < now)) continue;
      const handle = item.owner ?? item.said_by;
      const [person] = yield* sql<{ personId: string }>`SELECT person_id AS "personId"
        FROM kin_people WHERE org_id = ${orgId} AND handle = ${handle} ORDER BY person_id`.pipe(
        NodeSqliteClient.readOnly,
      );
      if (person === undefined) {
        yield* Effect.logDebug("Kin overdue chase skipped: promiser unknown", {
          orgId,
          itemId: item.id,
        });
        continue;
      }
      yield* chase(
        orgId,
        lead,
        item,
        KinPersonId.make(person.personId),
        `Was due ${item.due}. What's the status? ${Pings.quoted(item.title)}`,
        memoryDateMillis(item.due),
      );
    }
  });

  const staleReview = Effect.fn("KinWatchdogs.staleReview")(function* (orgId: KinOrgId) {
    const reader = yield* KinWatchdogGithubReader;
    if (reader === null) return;
    const lead = yield* leadOf(orgId);
    if (lead === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const items = (yield* openItems(orgId)).filter((item) => linksOf(item, scope.repos).length > 0);
    const github = yield* readStates(
      orgId,
      reader,
      items.flatMap((item) => linksOf(item, scope.repos)),
    );
    for (const item of items)
      for (const link of linksOf(item, scope.repos)) {
        const state = github.state(link);
        if (state?.kind !== "pull" || state.state !== "open") continue;
        for (const request of state.reviewRequests) {
          if (now - request.requestedAt < DAY) continue;
          const [person] = yield* sql<{ personId: string }>`SELECT person_id AS "personId"
            FROM kin_people WHERE org_id = ${orgId} AND lower(github_login) = lower(${request.login})
            ORDER BY person_id`.pipe(NodeSqliteClient.readOnly);
          if (person === undefined) continue;
          yield* chase(
            orgId,
            lead,
            item,
            KinPersonId.make(person.personId),
            `Your review is requested on ${githubUrl(link.repo, state)}. Can you review it? ${Pings.quoted(item.title)}`,
            request.requestedAt,
          );
        }
      }
  });

  const objectiveAtRisk = Effect.fn("KinWatchdogs.objectiveAtRisk")(function* (orgId: KinOrgId) {
    const reader = yield* KinWatchdogGithubReader;
    if (reader === null) return;
    const lead = yield* leadOf(orgId);
    if (lead === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const soon = (yield* openItems(orgId)).filter((item) => {
      const due = memoryDateMillis(item.due);
      return (
        item.kind === "objective" &&
        due > now &&
        due <= now + 3 * DAY &&
        linksOf(item, scope.repos).length > 0
      );
    });
    if (soon.length === 0) return;
    const github = yield* readStates(
      orgId,
      reader,
      soon.flatMap((item) => linksOf(item, scope.repos)),
    );
    for (const item of soon) {
      const links = linksOf(item, scope.repos);
      if (links.some(github.failed)) continue;
      const open = links.flatMap((link) => {
        const state = github.state(link);
        return state?.state === "open" ? [githubUrl(link.repo, state)] : [];
      });
      if (open.length === 0) continue;
      const messageId = KinMessageId.make(
        `kin-watchdog:objective_at_risk:${orgId}:${item.id}:${memoryDateMillis(item.due)}`,
      );
      // One flag per objective and due date, whatever its open work looks like on later runs.
      const [posted] = yield* sql`SELECT message_id FROM kin_messages
        WHERE org_id = ${orgId} AND message_id = ${messageId} ORDER BY message_id`;
      if (posted !== undefined) continue;
      yield* chat.notice({
        orgId,
        chatId: lead.chatId,
        messageId,
        body: `An objective due ${item.due} still has open GitHub work: ${open.slice(0, 20).join(", ")}${open.length > 20 ? ` and ${open.length - 20} more` : ""}.\n${Pings.quoted(item.title)}`,
      });
    }
  });

  const indexFreshness = Effect.fn("KinWatchdogs.indexFreshness")(function* (orgId: KinOrgId) {
    const index = yield* memory
      .readIndex(orgId)
      .pipe(Effect.catchTags({ MemoryError: () => Effect.succeed("") }));
    if (indexIsStale(index, yield* Clock.currentTimeMillis)) yield* memory.rebuildIndex(orgId);
  });

  const reconcileSources = Effect.fn("KinWatchdogs.reconcileSources")(function* (orgId: KinOrgId) {
    const sources = yield* store.listSources(orgId);
    if (sources.length === 0 || Option.isNone(tasks)) return;
    const all = (yield* tasks.value.list()).tasks;
    const lead = yield* leadOf(orgId);
    const notify = (messageId: string, body: string) =>
      lead === undefined
        ? Effect.logWarning("Kin webhook source needs the owner", { orgId, body })
        : chat
            .notice({ orgId, chatId: lead.chatId, messageId: KinMessageId.make(messageId), body })
            .pipe(Effect.asVoid);
    for (const source of sources) {
      const task = all.find((candidate) => candidate.id === source.scheduledTaskId);
      const status = observedSourceStatus(task);
      // Reports only: re-enabling, re-keying or rebinding is the owner's call.
      if (
        status !== source.status &&
        (yield* store.setSourceStatus(orgId, source.id, source.status, status))
      )
        yield* notify(
          `kin-reconcile:${orgId}:${source.id}:${status}:${yield* Clock.currentTimeMillis}`,
          STATUS_NOTICE[status],
        );
      if (task === undefined || (yield* store.secretMatchesTask(orgId, source.id))) continue;
      const [bound] = yield* sql<{ boundAt: number | null }>`SELECT secret_bound_at AS "boundAt"
        FROM kin_webhook_sources WHERE org_id = ${orgId} AND source_id = ${source.id}
        ORDER BY source_id`.pipe(NodeSqliteClient.readOnly);
      // Once per binding: a fresh bind is the only way out, and it gets its own notice if it fails.
      yield* notify(
        `kin-reconcile:${orgId}:${source.id}:secret:${bound?.boundAt ?? "unbound"}`,
        SECRET_NOTICE,
      );
    }
  });

  const triggerReconcile = Effect.fn("KinWatchdogs.triggerReconcile")(function* (orgId: KinOrgId) {
    // Independent halves: a failure in one is logged and the other still runs.
    yield* (
      Option.isSome(lock)
        ? lock.value.withPermits(1)(reconcileSources(orgId))
        : reconcileSources(orgId)
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Kin webhook source reconcile failed", { orgId, cause }),
      ),
    );
    // Re-arms open deferrals the cache hook missed; a failed read must not disarm everything.
    yield* memory.query(orgId, {}, "triggers").pipe(
      Effect.flatMap((items) => triggers.syncOrg(orgId, items)),
      Effect.catch((cause) => Effect.logWarning("Kin trigger re-arm failed", { orgId, cause })),
    );
  });

  const run = Effect.fn("KinWatchdogs.run")(
    function* (watchdog: KinWatchdog, orgId: KinOrgId) {
      switch (watchdog) {
        case "github_recheck":
          return yield* githubRecheck(orgId);
        case "stale_review":
          return yield* staleReview(orgId);
        case "promise_overdue":
          return yield* promiseOverdue(orgId);
        case "objective_at_risk":
          return yield* objectiveAtRisk(orgId);
        case "index_freshness":
          return yield* indexFreshness(orgId);
        case "trigger_reconcile":
          return yield* triggerReconcile(orgId);
      }
    },
    (effect, watchdog, orgId) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isSqlError(cause) ? toPersistenceSqlError(`KinWatchdogs.${watchdog}`)(cause) : cause,
        ),
        Effect.mapError((cause) => new KinWatchdogsError({ orgId, watchdog, cause })),
      ),
  );

  const prune = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* inbox.pruneConsumed(now);
    yield* store.pruneFires(now);
  }).pipe(Effect.withSpan("KinWatchdogs.prune"));

  // Per process: no backfill, so each watchdog runs at startup and then every interval.
  const nextAt = new Map<KinWatchdog, number>();
  yield* ticks.register(
    "kin-watchdogs",
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const due = KinWatchdog.literals.filter((watchdog) => (nextAt.get(watchdog) ?? 0) <= now);
      if (due.length === 0) return;
      for (const watchdog of due) nextAt.set(watchdog, now + WATCHDOG_EVERY_MS[watchdog]);
      if (due.includes("trigger_reconcile"))
        yield* prune.pipe(
          Effect.catch((cause) => Effect.logWarning("Kin trigger retention failed", { cause })),
        );
      // Scheduler maintenance scans organizations; every watchdog below is org-scoped.
      const orgs = yield* sql<{ orgId: string }>`SELECT org_id AS "orgId" FROM kin_orgs
        ORDER BY org_id`;
      for (const { orgId } of orgs)
        for (const watchdog of due)
          yield* run(watchdog, KinOrgId.make(orgId)).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Kin watchdog failed", { orgId, watchdog, cause }),
            ),
          );
    }).pipe(Effect.catch((cause) => Effect.logWarning("Kin watchdog scan failed", { cause }))),
  );

  return KinWatchdogs.of({ run });
});

export const layer = Layer.effect(KinWatchdogs, make).pipe(
  Layer.provide(Layer.mergeAll(Pings.layer, KinTriggerService.layer)),
  Layer.provide(MemoryCache.layer),
);
export const runtimeLayer = layer.pipe(Layer.provide(repoScopeLayer));
