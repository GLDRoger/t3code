import {
  GithubRepoSlug,
  KinAgentId,
  KinEvent,
  KinEventId,
  KinOrgId,
  type KinGithubEvent,
  type KinTriggerFired,
  type MemoryItemHead,
  type ScheduledTaskWebhookDelivery,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { isSqlError } from "effect/sql/SqlError";

import { toPersistenceSqlError } from "../../persistence/Errors.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as Memory from "../memory/Memory.ts";
import * as KinTriggerInbox from "./KinTriggerInbox.ts";
import { isPermanent } from "./routines.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;
const PAGE = 100;
const EVENT_NAME = /^[a-z_]{1,64}$/;
const ORG_LEVEL_EVENTS = new Set([
  "ping",
  "installation",
  "installation_repositories",
  "github_app_authorization",
  "meta",
]);
const isQueueConflict = Schema.is(KinEventQueue.KinEventQueueConflict);
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const PayloadFields = Schema.Struct({
  action: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.Struct({ full_name: Schema.String })),
  sender: Schema.optional(Schema.Struct({ login: Schema.String })),
  pull_request: Schema.optional(
    Schema.Struct({
      number: Schema.Int,
      merged: Schema.optional(Schema.NullOr(Schema.Boolean)),
      head: Schema.optional(Schema.Struct({ sha: Schema.String })),
    }),
  ),
  issue: Schema.optional(Schema.Struct({ number: Schema.Int })),
  check_suite: Schema.optional(Schema.Struct({ head_sha: Schema.String })),
  workflow_run: Schema.optional(Schema.Struct({ head_sha: Schema.String })),
  after: Schema.optional(Schema.String),
});
const decodePayloadFields = Schema.decodeUnknownOption(PayloadFields);
const isRepoSlug = Schema.is(GithubRepoSlug);

/** The org's repos (`KIN_GITHUB_REPOS`, the scope APPR-8's `KinGitHubScope` reads). Empty drops every event. */
export class KinGithubRepoScope extends Context.Service<
  KinGithubRepoScope,
  { readonly repos: ReadonlyArray<string> }
>()("t3/kin/triggers/githubEvents/KinGithubRepoScope") {}

/** Comma-separated `owner/name`, trimmed. Unset, empty or any invalid entry fails closed with one warning. */
export const repoScopeLayer = Layer.effect(
  KinGithubRepoScope,
  Effect.gen(function* () {
    const raw = yield* Config.option(Config.String("KIN_GITHUB_REPOS"));
    const entries = Option.getOrElse(raw, () => "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (entries.length === 0) {
      yield* Effect.logWarning("KIN_GITHUB_REPOS is empty or unset; dropping all GitHub events");
      return [];
    }
    const invalid = entries.filter((entry) => !isRepoSlug(entry));
    if (invalid.length > 0) {
      yield* Effect.logWarning("KIN_GITHUB_REPOS is invalid; dropping all GitHub events", {
        invalid,
      });
      return [];
    }
    return entries;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("KIN_GITHUB_REPOS is unreadable; dropping all GitHub events", cause).pipe(
        Effect.as([]),
      ),
    ),
    Effect.map((repos) => KinGithubRepoScope.of({ repos })),
  ),
);

export const inRepoScope = (repos: ReadonlyArray<string>, repo: string) =>
  repos.some((scoped) => scoped.toLowerCase() === repo.toLowerCase());

const header = (headers: Readonly<Record<string, string>>, name: string) =>
  Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name)?.[1]
    ?.trim() || undefined;

type RecheckReason = Extract<KinTriggerFired["payload"], { kind: "github_recheck" }>["reason"];
type PayloadFields = typeof PayloadFields.Type;
type GithubDeliveryResult =
  | { readonly _tag: "event"; readonly event: KinGithubEvent; readonly merged: boolean | null }
  | { readonly _tag: "recheck"; readonly reason: RecheckReason }
  | { readonly _tag: "drop"; readonly reason: string };

type Subject = { readonly number: number | null; readonly headSha: string | null };
// The object each subscribed event must carry; a body without it doesn't belong to its header.
const SUBJECTS = new Map<string, (fields: PayloadFields) => Subject | undefined>([
  ...["pull_request", "pull_request_review", "pull_request_review_comment"].map(
    (name) =>
      [
        name,
        ({ pull_request }: PayloadFields) =>
          pull_request && { number: pull_request.number, headSha: pull_request.head?.sha ?? null },
      ] as const,
  ),
  ...["issues", "issue_comment"].map(
    (name) =>
      [
        name,
        ({ issue }: PayloadFields) => issue && { number: issue.number, headSha: null },
      ] as const,
  ),
  [
    "check_suite",
    ({ check_suite }) => check_suite && { number: null, headSha: check_suite.head_sha },
  ],
  [
    "workflow_run",
    ({ workflow_run }) => workflow_run && { number: null, headSha: workflow_run.head_sha },
  ],
  ["push", ({ after }) => (after === undefined ? undefined : { number: null, headSha: after })],
]);

/** Builds the event from a logged delivery; anything that can't be read becomes a recheck. */
export function githubEventFromDelivery(
  orgId: KinOrgId,
  delivery: Pick<
    ScheduledTaskWebhookDelivery,
    "id" | "receivedAt" | "headers" | "body" | "bodyTruncated"
  >,
): GithubDeliveryResult {
  const eventName = header(delivery.headers, "x-github-event");
  if (eventName !== undefined && ORG_LEVEL_EVENTS.has(eventName))
    return { _tag: "drop", reason: "org-level event" };
  const deliveryId = header(delivery.headers, "x-github-delivery");
  const payload = Option.getOrUndefined(parseJson(delivery.body));
  const fields = Option.getOrUndefined(decodePayloadFields(payload));
  if (
    eventName === undefined ||
    !EVENT_NAME.test(eventName) ||
    deliveryId === undefined ||
    fields === undefined
  )
    return { _tag: "recheck", reason: "body_unparseable" };
  const subjectOf = SUBJECTS.get(eventName);
  const subject = subjectOf === undefined ? { number: null, headSha: null } : subjectOf(fields);
  if (subject === undefined) return { _tag: "recheck", reason: "body_unparseable" };
  const repo = fields.repository?.full_name;
  if (repo === undefined || !isRepoSlug(repo)) return { _tag: "recheck", reason: "repo_unknown" };
  return {
    _tag: "event",
    merged: fields.pull_request?.merged ?? null,
    event: {
      orgId,
      deliveryId,
      event: eventName,
      action: fields.action ?? null,
      repo,
      number: subject.number,
      headSha: subject.headSha,
      sender: fields.sender?.login ?? "unknown",
      receivedAt: delivery.receivedAt,
      heldByRelay: delivery.id.startsWith("delivery:relay:"),
      bodyTruncated: delivery.bodyTruncated,
      payload,
    },
  };
}

/** What a condition can test. `github_recheck` builds the same facts from GitHub state. */
export interface GithubConditionFacts {
  readonly event: string;
  readonly action: string | null;
  readonly repo: string;
  readonly number: number | null;
  readonly merged: boolean | null;
}

/** Open, valid memory items whose `on` condition the facts satisfy. */
export function matchConditions(
  facts: GithubConditionFacts,
  items: ReadonlyArray<MemoryItemHead>,
): ReadonlyArray<MemoryItemHead> {
  return items.filter(
    ({ on, status, invalid_at, superseded_by }) =>
      on !== undefined &&
      status === "open" &&
      invalid_at === null &&
      superseded_by === null &&
      on.event === facts.event &&
      on.action === facts.action &&
      on.number === facts.number &&
      (on.merged === undefined || on.merged === facts.merged) &&
      (on.repo === undefined || on.repo.toLowerCase() === facts.repo.toLowerCase()),
  );
}

const eventIdFor = (prefix: string, orgId: KinOrgId, fireId: string) =>
  KinEventId.make(
    `${prefix}_${Array.from(new TextEncoder().encode(`${orgId.length}:${orgId}${fireId}`), (byte) => byte.toString(16).padStart(2, "0")).join("")}`,
  );

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const summarize = (event: KinGithubEvent) =>
  [
    clip(
      `${event.event}${event.action === null ? "" : `.${event.action}`} in ${event.repo}${event.number === null ? "" : ` #${event.number}`} by ${event.sender}`,
      240,
    ),
    event.heldByRelay ? " (held by relay)" : "",
    event.bodyTruncated ? " (body truncated)" : "",
    " (hint; verify on GitHub)",
  ].join("");

export class KinGithubEventsError extends Schema.TaggedError<KinGithubEventsError>()(
  "KinGithubEventsError",
  { orgId: KinOrgId, cause: Schema.Defect() },
) {}

export class KinGithubEvents extends Context.Service<
  KinGithubEvents,
  { readonly drain: (orgId: KinOrgId) => Effect.Effect<void, KinGithubEventsError> }
>()("t3/kin/triggers/githubEvents/KinGithubEvents") {}

type GithubFire = KinTriggerFired & { readonly payload: { readonly kind: "github" } };
type Outcome =
  | Exclude<GithubDeliveryResult, { readonly _tag: "event" }>
  | (Extract<GithubDeliveryResult, { readonly _tag: "event" }> & {
      readonly matches: ReadonlyArray<MemoryItemHead>;
    });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const inbox = yield* KinTriggerInbox.KinTriggerInbox;
  const queue = yield* KinEventQueue.KinEventQueue;
  // Optional so Kin runtimes built without T3 scheduling (lead tests) still start; production has it.
  const scheduledTasks = yield* Effect.serviceOption(ScheduledTaskService.ScheduledTaskService);
  if (Option.isNone(scheduledTasks))
    return KinGithubEvents.of({ drain: Effect.fn("KinGithubEvents.drain")(() => Effect.void) });
  const tasks = scheduledTasks.value;
  const memory = yield* Memory.Memory;
  const scope = yield* KinGithubRepoScope;
  const ticks = yield* Scheduler.Scheduler;

  // Per process: the 24 h give-up is the durable bound, so a restart only retries sooner.
  const retries = new Map<
    KinOrgId,
    Map<string, { readonly notBefore: number; readonly failures: number }>
  >();

  // Read-only and repeatable: a crash before the write below just reads again.
  const read = Effect.fn("KinGithubEvents.read")(function* (orgId: KinOrgId, fire: GithubFire) {
    const { scheduledTaskId, deliveryId } = fire.payload;
    const [logged] = yield* sql`SELECT delivery_id FROM scheduled_task_webhook_deliveries
      WHERE task_id = ${scheduledTaskId} AND delivery_id = ${deliveryId}
      ORDER BY delivery_id`.pipe(NodeSqliteClient.readOnly);
    if (logged === undefined)
      return { _tag: "recheck", reason: "delivery_missing" } satisfies GithubDeliveryResult;
    const { delivery } = yield* tasks.getWebhookDelivery({
      id: scheduledTaskId,
      deliveryId,
      acceptAnyOutcome: true,
    });
    const built = githubEventFromDelivery(orgId, delivery);
    if (built._tag === "event" && !inRepoScope(scope.repos, built.event.repo))
      return { _tag: "drop", reason: "repo out of scope" } satisfies GithubDeliveryResult;
    return built;
  });

  const putRecheck = (orgId: KinOrgId, fire: GithubFire, reason: RecheckReason, now: number) => {
    const iso = DateTime.formatIso(DateTime.makeUnsafe(now));
    return inbox.put(
      {
        fireId: KinTriggerInbox.recheckFireId(orgId, fire.fireId),
        orgId,
        dueAt: iso,
        firedAt: iso,
        lateByMs: 0,
        payload: { kind: "github_recheck", repo: null, reason, sourceFireId: fire.fireId },
      },
      now,
    );
  };

  const write = Effect.fn("KinGithubEvents.write")(function* (
    orgId: KinOrgId,
    fire: GithubFire,
    read: Outcome,
    now: number,
  ) {
    const unconsumed = yield* sql`SELECT fire_id FROM kin_trigger_inbox
      WHERE org_id = ${orgId} AND fire_id = ${fire.fireId} AND consumed_at IS NULL ORDER BY fire_id`;
    if (unconsumed.length === 0) return;
    const { sourceId, scheduledTaskId } = fire.payload;
    const [source] = yield* sql`SELECT source_id FROM kin_webhook_sources
      WHERE org_id = ${orgId} AND source_id = ${sourceId} AND scheduled_task_id = ${scheduledTaskId}
      ORDER BY source_id`;
    const outcome: Outcome =
      source === undefined ? { _tag: "drop", reason: "source removed" } : read;
    if (outcome._tag === "recheck") {
      yield* putRecheck(orgId, fire, outcome.reason, now);
    } else if (outcome._tag === "event") {
      const [lead] = yield* sql<{ agent_id: string }>`SELECT l.agent_id FROM kin_leads l
        JOIN kin_agents a ON a.org_id = l.org_id AND a.agent_id = l.agent_id
        WHERE l.org_id = ${orgId} AND a.retired_at IS NULL ORDER BY l.agent_id LIMIT 1`;
      if (lead === undefined) {
        yield* Effect.logWarning("Kin GitHub event dropped: no active lead", {
          orgId,
          fireId: fire.fireId,
        });
      } else {
        const { event } = outcome;
        const base = {
          orgId,
          agentId: KinAgentId.make(lead.agent_id),
          receivedAt: event.receivedAt,
          // GitHub text is outside input: LEAD stores it as `trust: external` and quotes it.
          provenance: { _tag: "system" },
        };
        yield* queue.enqueue(
          yield* decodeEvent({
            ...base,
            _tag: "github",
            eventId: eventIdFor("github", orgId, fire.fireId),
            dedupeKey: event.deliveryId,
            deliveryId: event.deliveryId,
            eventName: event.event,
            repo: event.repo,
            summary: summarize(event),
            scheduledTaskId,
            webhookDeliveryId: fire.payload.deliveryId,
          }),
        );
        if (outcome.matches.length > 0)
          yield* queue.enqueue(
            yield* decodeEvent({
              ...base,
              _tag: "watchdog",
              eventId: eventIdFor("github_condition", orgId, fire.fireId),
              dedupeKey: `github-condition:${event.deliveryId}`,
              finding: `GitHub event suggests condition met (hint; verify on GitHub before acting): ${clip(`${event.event}.${event.action ?? ""} ${event.repo}#${event.number ?? ""}`, 200)}${outcome.merged === true ? " (merged)" : ""}`,
              itemIds: outcome.matches.map((item) => item.id),
            }),
          );
      }
    } else {
      yield* Effect.logDebug("Kin GitHub event dropped", {
        orgId,
        fireId: fire.fireId,
        reason: outcome.reason,
      });
    }
    yield* inbox.markConsumed(orgId, [fire.fireId]);
  });

  const drain = Effect.fn("KinGithubEvents.drain")(function* (orgId: KinOrgId) {
    const now = yield* Clock.currentTimeMillis;
    const pending = yield* inbox
      .listPending(orgId, PAGE, undefined, ["github"])
      .pipe(Effect.mapError((cause) => new KinGithubEventsError({ orgId, cause })));
    const orgRetries = retries.get(orgId) ?? new Map();
    retries.set(orgId, orgRetries);
    // A full page may hide pending fires, so only a short one can prove an entry stale.
    if (pending.length < PAGE) {
      const ids = new Set(pending.map((fire) => fire.fireId));
      for (const fireId of orgRetries.keys()) if (!ids.has(fireId)) orgRetries.delete(fireId);
    }
    const reads = [];
    for (const fire of pending) {
      if (fire.payload.kind !== "github") continue;
      const retry = orgRetries.get(fire.fireId);
      const giveUp = now - Date.parse(fire.dueAt) > DAY_MS;
      if (retry !== undefined && now < retry.notBefore && !giveUp) continue;
      const github = { ...fire, payload: fire.payload };
      reads.push({
        fire: github,
        retry,
        giveUp,
        result: yield* read(orgId, github).pipe(
          Effect.mapError((cause) =>
            isSqlError(cause) ? toPersistenceSqlError("KinGithubEvents.read")(cause) : cause,
          ),
          Effect.result,
        ),
      });
    }

    // One memory read per drain; without it events still go through and TRIG-10's recheck matches later.
    const items = reads.some(
      ({ result }) => Result.isSuccess(result) && result.success._tag === "event",
    )
      ? yield* memory.query(orgId, { status: "open", excludeInvalid: true }, "triggers").pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Kin GitHub condition matching skipped: memory unavailable", {
              orgId,
              errorTag: cause._tag,
            }).pipe(Effect.as([])),
          ),
        )
      : [];

    for (const { fire, retry, giveUp, result } of reads) {
      yield* Effect.gen(function* () {
        const built = yield* Effect.fromResult(result);
        const outcome: Outcome =
          built._tag === "event"
            ? {
                ...built,
                matches: matchConditions({ ...built.event, merged: built.merged }, items),
              }
            : built;
        yield* sql.withTransaction(write(orgId, fire, outcome, now));
        orgRetries.delete(fire.fireId);
      }).pipe(
        Effect.mapError((cause) =>
          isSqlError(cause) ? toPersistenceSqlError("KinGithubEvents.drain")(cause) : cause,
        ),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const permanent = isPermanent(cause) || isQueueConflict(cause);
            const consume = permanent || giveUp;
            const failures = (retry?.failures ?? 0) + 1;
            yield* (consume || failures === 1 ? Effect.logWarning : Effect.logDebug)(
              "Kin GitHub fire processing failed",
              {
                orgId,
                fireId: fire.fireId,
                errorTag: cause._tag,
                message: cause.message,
                failures,
                disposition: permanent ? "consumed" : giveUp ? "stale" : "retry",
              },
            );
            if (!consume) {
              const delay = Math.min(RETRY_MAX_MS, RETRY_FIRST_MS * 2 ** (failures - 1));
              orgRetries.set(fire.fireId, { notBefore: now + delay, failures });
              return;
            }
            yield* (
              permanent
                ? inbox.markConsumed(orgId, [fire.fireId])
                : sql.withTransaction(
                    putRecheck(orgId, fire, "stale", now).pipe(
                      Effect.andThen(inbox.markConsumed(orgId, [fire.fireId])),
                    ),
                  )
            ).pipe(
              Effect.tap(() => Effect.sync(() => orgRetries.delete(fire.fireId))),
              Effect.tapError(() =>
                Effect.sync(() =>
                  orgRetries.set(fire.fireId, { notBefore: now + RETRY_MAX_MS, failures }),
                ),
              ),
              Effect.catch((cause) =>
                Effect.logWarning("Kin GitHub fire could not be consumed", {
                  orgId,
                  fireId: fire.fireId,
                  errorTag: cause._tag,
                }),
              ),
            );
          }),
        ),
      );
    }
  });

  yield* ticks.register(
    "kin-github-events",
    Effect.gen(function* () {
      // Scheduler maintenance scans organizations; pending rows outlive a removed source, so scan those.
      const orgs = yield* sql<{ org_id: string }>`SELECT DISTINCT org_id FROM kin_trigger_inbox
        WHERE consumed_at IS NULL AND json_extract(payload_json, '$.payload.kind') = 'github'
        ORDER BY org_id`;
      for (const row of orgs) {
        const orgId = KinOrgId.make(row.org_id);
        yield* drain(orgId).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Kin GitHub events tick failed", { orgId, cause }),
          ),
        );
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Kin GitHub events scan failed", {
          errorTag: cause._tag,
          message: cause.message,
        }),
      ),
    ),
  );

  return KinGithubEvents.of({ drain });
});

export const layer = Layer.effect(KinGithubEvents, make);
export const consumerLayer = layer.pipe(Layer.provide(repoScopeLayer));
