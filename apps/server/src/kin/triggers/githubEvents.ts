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
const decodeEvent = Schema.decodeUnknownEffect(KinEvent);
const parseJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const PayloadFields = Schema.Struct({
  action: Schema.optional(Schema.String),
  number: Schema.optional(Schema.Int),
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

const repoScopeLayer = Layer.effect(
  KinGithubRepoScope,
  Effect.gen(function* () {
    const repos: ReadonlyArray<string> = yield* Config.Array(
      GithubRepoSlug,
      "KIN_GITHUB_REPOS",
    ).pipe(Config.withDefault([]));
    return repos;
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("KIN_GITHUB_REPOS is invalid; dropping all GitHub events", cause).pipe(
        Effect.as([]),
      ),
    ),
    Effect.map((repos) => KinGithubRepoScope.of({ repos })),
  ),
);

const inRepoScope = (repos: ReadonlyArray<string>, repo: string) =>
  repos.some((scoped) => scoped.toLowerCase() === repo.toLowerCase());

const header = (headers: Readonly<Record<string, string>>, name: string) =>
  Object.entries(headers)
    .find(([key]) => key.toLowerCase() === name)?.[1]
    ?.trim() || undefined;

type GithubDeliveryResult =
  | { readonly _tag: "event"; readonly event: KinGithubEvent; readonly merged: boolean | null }
  | { readonly _tag: "recheck"; readonly reason: "body_unparseable" | "repo_unknown" };

/** Builds the event from a logged delivery; anything that can't be read becomes a recheck. */
function githubEventFromDelivery(
  orgId: KinOrgId,
  delivery: Pick<
    ScheduledTaskWebhookDelivery,
    "id" | "receivedAt" | "headers" | "body" | "bodyTruncated"
  >,
): GithubDeliveryResult {
  const eventName = header(delivery.headers, "x-github-event");
  const deliveryId = header(delivery.headers, "x-github-delivery");
  const payload = Option.getOrUndefined(parseJson(delivery.body));
  const fields = Option.getOrUndefined(decodePayloadFields(payload));
  if (eventName === undefined || deliveryId === undefined || fields === undefined)
    return { _tag: "recheck", reason: "body_unparseable" };
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
      number: fields.pull_request?.number ?? fields.issue?.number ?? fields.number ?? null,
      headSha:
        fields.pull_request?.head?.sha ??
        fields.check_suite?.head_sha ??
        fields.workflow_run?.head_sha ??
        (eventName === "push" ? (fields.after ?? null) : null),
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

const summarize = (event: KinGithubEvent) =>
  [
    `${event.event}${event.action === null ? "" : `.${event.action}`} in ${event.repo}`,
    event.number === null ? "" : ` #${event.number}`,
    ` by ${event.sender}`,
    event.heldByRelay ? " (held by relay)" : "",
    event.bodyTruncated ? " (body truncated)" : "",
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
  | { readonly _tag: "drop"; readonly reason: string }
  | {
      readonly _tag: "recheck";
      readonly reason: "delivery_missing" | "body_unparseable" | "repo_unknown";
    }
  | {
      readonly _tag: "event";
      readonly event: KinGithubEvent;
      readonly matches: ReadonlyArray<MemoryItemHead>;
      readonly merged: boolean | null;
    };

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

  // Read-only and repeatable: a crash before the write below just reads again.
  const read = Effect.fn("KinGithubEvents.read")(function* (orgId: KinOrgId, fire: GithubFire) {
    const { sourceId, scheduledTaskId, deliveryId } = fire.payload;
    const [source] = yield* sql`SELECT source_id FROM kin_webhook_sources
      WHERE org_id = ${orgId} AND source_id = ${sourceId} AND scheduled_task_id = ${scheduledTaskId}
      ORDER BY source_id`.pipe(NodeSqliteClient.readOnly);
    if (source === undefined) return { _tag: "drop", reason: "source removed" } satisfies Outcome;
    const [logged] = yield* sql`SELECT delivery_id FROM scheduled_task_webhook_deliveries
      WHERE task_id = ${scheduledTaskId} AND delivery_id = ${deliveryId}
      ORDER BY delivery_id`.pipe(NodeSqliteClient.readOnly);
    if (logged === undefined)
      return { _tag: "recheck", reason: "delivery_missing" } satisfies Outcome;
    const { delivery } = yield* tasks.getWebhookDelivery({
      id: scheduledTaskId,
      deliveryId,
      acceptAnyOutcome: true,
    });
    const built = githubEventFromDelivery(orgId, delivery);
    if (built._tag === "recheck") return built satisfies Outcome;
    if (!inRepoScope(scope.repos, built.event.repo))
      return { _tag: "drop", reason: "repo out of scope" } satisfies Outcome;
    const items = yield* memory.query(orgId, { status: "open", excludeInvalid: true });
    const matches = matchConditions({ ...built.event, merged: built.merged }, items);
    return { ...built, matches } satisfies Outcome;
  });

  const write = Effect.fn("KinGithubEvents.write")(function* (
    orgId: KinOrgId,
    fire: GithubFire,
    outcome: Outcome,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const iso = DateTime.formatIso(DateTime.makeUnsafe(now));
    const unconsumed = yield* sql`SELECT fire_id FROM kin_trigger_inbox
      WHERE org_id = ${orgId} AND fire_id = ${fire.fireId} AND consumed_at IS NULL ORDER BY fire_id`;
    if (unconsumed.length === 0) return;
    if (outcome._tag === "recheck") {
      yield* inbox.put(
        {
          fireId: KinTriggerInbox.recheckFireId(orgId, fire.fireId),
          orgId,
          dueAt: iso,
          firedAt: iso,
          lateByMs: 0,
          payload: {
            kind: "github_recheck",
            repo: null,
            reason: outcome.reason,
            sourceFireId: fire.fireId,
          },
        },
        now,
      );
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
            scheduledTaskId: fire.payload.scheduledTaskId,
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
              finding: `GitHub condition met: ${event.event}.${event.action ?? ""} ${event.repo}#${event.number ?? ""}${outcome.merged === true ? " (merged)" : ""}`,
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
      .listPending(orgId, 100, undefined, ["github"])
      .pipe(Effect.mapError((cause) => new KinGithubEventsError({ orgId, cause })));
    for (const fire of pending) {
      if (fire.payload.kind !== "github") continue;
      const github = { ...fire, payload: fire.payload };
      yield* Effect.gen(function* () {
        const outcome = yield* read(orgId, github);
        yield* sql.withTransaction(write(orgId, github, outcome));
      }).pipe(
        Effect.mapError((cause) =>
          isSqlError(cause) ? toPersistenceSqlError("KinGithubEvents.drain")(cause) : cause,
        ),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            const consume = isPermanent(cause) || now - Date.parse(fire.dueAt) > DAY_MS;
            // Retries recur every tick for up to 24 h, so only the final drop warns.
            yield* (consume ? Effect.logWarning : Effect.logDebug)(
              "Kin GitHub fire processing failed",
              {
                orgId,
                fireId: fire.fireId,
                errorTag: cause._tag,
                message: cause.message,
                disposition: consume ? "consumed" : "retry",
              },
            );
            if (consume)
              yield* inbox
                .markConsumed(orgId, [fire.fireId])
                .pipe(Effect.mapError((cause) => new KinGithubEventsError({ orgId, cause })));
          }),
        ),
      );
    }
  });

  yield* ticks.register(
    "kin-github-events",
    Effect.gen(function* () {
      // Scheduler maintenance scans organizations; each drain is org-scoped.
      const orgs = yield* sql<{
        org_id: string;
      }>`SELECT DISTINCT org_id FROM kin_webhook_sources ORDER BY org_id`;
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
