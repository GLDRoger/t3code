import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KinAgentId,
  type KinChatId,
  KinOrgId,
  KinPersonId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as ChatService from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinLevels from "./KinLevels.ts";
import * as Provision from "./KinLeadProvision.ts";
import { RETIRED_ACTION_REASON, RETIRED_WORKER_REASON } from "./Retirement.ts";

const layer = Provision.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make("work")]: { driver: ProviderDriverKind.make("claudeAgent") },
        [ProviderInstanceId.make("mine")]: { driver: ProviderDriverKind.make("codex") },
      },
    }),
  ),
);
// The owner's phone, paired; `session(...)` stands for it.
const paired = Layer.effectDiscard(pairSession("phone")).pipe(Layer.provideMerge(layer));
const session = (scopes: AuthenticatedSession["scopes"]): Provision.LeadCreator => ({
  _tag: "session",
  session: {
    sessionId: AuthSessionId.make("phone"),
    subject: "phone",
    method: "bearer-access-token",
    scopes,
  },
});
const owner = session(AuthStandardClientScopes);
const project = ProjectId.make("project-a");
const input = (who: Provision.LeadCreator = owner, workerProjects = [project]) => ({
  creator: who,
  name: "Ada",
  domain: "engineering",
  charter: "",
  models: {
    // The default Claude instance, and a custom one that settings name as Claude.
    strong: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-4-6" },
    cheap: { instanceId: ProviderInstanceId.make("work"), model: "claude-haiku-4-5" },
  },
  workerProjects,
});
const counts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql`SELECT (SELECT COUNT(*) FROM kin_agents) AS agents,
    (SELECT COUNT(*) FROM kin_chats) AS chats, (SELECT COUNT(*) FROM kin_chat_members) AS members,
    (SELECT COUNT(*) FROM kin_leads) AS leads`;
});
const seedProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${project}, 'A', '/tmp/a', '[]', '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z')`;
});
const isRefusal = Schema.is(Provision.KinLeadProvisionError);
const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (isRefusal(error) ? error.reason : error)),
  );

describe("KinLeadProvision", () => {
  it.effect("creates an L0 lead with the owner's direct chat, and a re-run changes nothing", () =>
    Effect.gen(function* () {
      const now = Date.parse("2026-11-09T08:00:00.000Z");
      yield* TestClock.setTime(now);
      yield* seedProject;
      const sql = yield* SqlClient.SqlClient;
      const repo = yield* Repository.KinChatRepository;
      const created = yield* Provision.create(input());
      assert.strictEqual(created._tag, "created");
      const { lead } = created;
      assert.strictEqual(yield* KinLevels.effectiveLevel(lead), "L0");
      assert.deepStrictEqual(
        yield* sql`SELECT level_since FROM kin_leads WHERE org_id = ${lead.orgId} AND agent_id = ${lead.agentId} ORDER BY agent_id`,
        [{ level_since: now }],
      );
      assert.deepStrictEqual(lead.workerProjects, [project]);
      const chat = Option.getOrThrow(yield* repo.getChat({ ...lead, chatId: lead.ownerChatId }));
      assert.strictEqual(chat.kind, "direct");
      const members = yield* repo.listMembers(chat);
      assert.sameDeepMembers(
        members.map(({ principal, role }) => ({ principal, role })),
        [
          { principal: { _tag: "agent", agentId: lead.agentId }, role: "member" },
          { principal: { _tag: "person", personId: lead.ownerPersonId }, role: "owner" },
        ],
      );

      assert.strictEqual(lead.createdByPersonId, lead.ownerPersonId);
      // It works at L2 in that chat from creation, as in groups its owner owns.
      assert.strictEqual(
        yield* KinLevels.effectiveLevel({ ...lead, chatId: lead.ownerChatId }),
        "L2",
      );

      const before = yield* counts;
      const again = yield* Provision.create(
        input({ _tag: "person", personId: lead.ownerPersonId }),
      );
      assert.deepStrictEqual(again, { _tag: "existing", lead });
      assert.deepStrictEqual(yield* counts, before);
    }).pipe(Effect.provide(paired)),
  );

  it.effect(
    "refuses anyone but the host's Kin owner, unknown worker projects and non-Claude models",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org-b', 'B', '2026-11-09T00:00:00.000Z')`;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('person-b', 'org-b', 'b', 'B', '2026-11-09T00:00:00.000Z')`;
        const before = yield* counts;
        assert.strictEqual(
          yield* refusal(
            Provision.create(input({ _tag: "person", personId: KinPersonId.make("person-b") })),
          ),
          "not_owner",
        );
        assert.strictEqual(
          yield* refusal(Provision.create(input(session(AuthStandardClientScopes.slice(1))))),
          "not_owner",
        );
        assert.strictEqual(yield* refusal(Provision.create(input())), "unknown_project");
        // Only Claude sessions get LeadIsolation's no-shell tools, so either model elsewhere is refused.
        for (const [role, instanceId] of [
          ["strong", "codex"],
          ["cheap", "mine"],
          ["cheap", "missing"],
        ] as const) {
          const models = { ...input().models };
          models[role] = { instanceId: ProviderInstanceId.make(instanceId), model: "gpt-5.5" };
          assert.strictEqual(
            yield* refusal(Provision.create({ ...input(owner, []), models })),
            "not_claude",
          );
        }
        assert.deepStrictEqual(yield* counts, before);
      }).pipe(Effect.provide(paired)),
  );

  it.effect("creates a second and third lead per domain, each with its own chat, owner-only", () =>
    Effect.gen(function* () {
      const repo = yield* Repository.KinChatRepository;
      const sql = yield* SqlClient.SqlClient;
      const tech = (yield* Provision.create(input(owner, []))).lead;
      yield* TestClock.adjust("1 minute");
      const growth = yield* Provision.create({
        ...input({ _tag: "person", personId: tech.ownerPersonId }, []),
        name: "Growth",
        domain: "growth",
        charter: "Grow signups. Own launch posts and the waitlist.",
      });
      assert.strictEqual(growth._tag, "created");
      // No models named: the org's first lead's.
      const { models: _models, ...noModels } = input(owner, []);
      yield* TestClock.adjust("1 minute");
      const finance = yield* Provision.create({
        ...noModels,
        name: "Finance",
        domain: "finance",
        charter: "Invoices and chasing what's overdue.",
      });
      assert.deepStrictEqual(finance.lead.models, tech.models);
      assert.deepStrictEqual(
        (yield* Provision.list()).map(({ name, domain, charter, level }) => ({
          name,
          domain,
          charter,
          level,
        })),
        [
          { name: "Ada", domain: "engineering", charter: "", level: "L0" },
          {
            name: "Growth",
            domain: "growth",
            charter: "Grow signups. Own launch posts and the waitlist.",
            level: "L0",
          },
          {
            name: "Finance",
            domain: "finance",
            charter: "Invoices and chasing what's overdue.",
            level: "L0",
          },
        ],
      );
      const chats = new Set([tech, growth.lead, finance.lead].map((lead) => lead.ownerChatId));
      assert.strictEqual(chats.size, 3);
      for (const lead of [growth.lead, finance.lead]) {
        const members = yield* repo.listMembers({ orgId: lead.orgId, chatId: lead.ownerChatId });
        assert.sameDeepMembers(
          members.map(({ principal }) => principal),
          [
            { _tag: "agent", agentId: lead.agentId },
            { _tag: "person", personId: tech.ownerPersonId },
          ],
        );
      }

      // Only the owner changes a charter, from the host; it reads per wake-up.
      const changed = yield* Provision.setCharter(growth.lead.agentId, {
        charter: "Grow revenue.",
      });
      assert.deepStrictEqual(changed.lead, { ...growth.lead, charter: "Grow revenue." });
      assert.strictEqual(
        yield* refusal(Provision.setCharter(KinAgentId.make("missing"), { charter: "" })),
        "not_found",
      );

      // A member of the org can't create one yet, though members will.
      const teammate = KinPersonId.make("teammate");
      yield* repo.insertPerson({
        orgId: tech.orgId,
        personId: teammate,
        handle: "teammate",
        displayName: "Teammate",
        githubLogin: null,
        createdAt: "2026-11-09T00:00:00.000Z",
      });
      const before = yield* counts;
      assert.strictEqual(
        yield* refusal(
          Provision.create({
            ...input({ _tag: "person", personId: teammate }, []),
            domain: "social",
          }),
        ),
        "not_owner",
      );
      assert.deepStrictEqual(yield* counts, before);
      assert.deepStrictEqual(
        yield* sql`SELECT COUNT(*) AS n FROM kin_leads WHERE created_by_person_id = ${teammate} ORDER BY n`,
        [{ n: 0 }],
      );
    }).pipe(Effect.provide(paired)),
  );

  it.effect(
    "retires an agent without deleting it, keeps the owner one to talk to, and restores it",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const identity = yield* KinIdentity;
        const ada = (yield* Provision.create(input(owner, []))).lead;
        const by = { by: owner, orgId: ada.orgId };
        // The owner's only agent stays: there must be someone to talk to.
        assert.strictEqual(
          yield* refusal(Provision.retire({ ...by, agentId: ada.agentId })),
          "last_agent",
        );
        assert.strictEqual(yield* refusal(Provision.retireOnHost(ada.agentId)), "last_agent");
        yield* TestClock.adjust("1 minute");
        const growth = (yield* Provision.create({
          ...input(owner, []),
          name: "Growth",
          domain: "growth",
        })).lead;
        assert.strictEqual(
          yield* refusal(Provision.retire({ ...by, agentId: KinAgentId.make("missing") })),
          "not_found",
        );

        const retired = yield* Provision.retire({ ...by, agentId: growth.agentId });
        assert.strictEqual(retired._tag, "retired");
        const at = "1970-01-01T00:01:00.000Z";
        assert.deepStrictEqual(retired.profile.retired, { at, byPersonId: ada.ownerPersonId });
        assert.deepStrictEqual(retired.lead, {
          ...growth,
          retiredAt: at,
          retiredByPersonId: ada.ownerPersonId,
        });
        // Nothing is deleted: its chat and membership stay readable.
        assert.deepStrictEqual(
          yield* sql`SELECT chat_id, left_at FROM kin_chat_members
            WHERE agent_id = ${growth.agentId} ORDER BY chat_id`,
          [{ chat_id: growth.ownerChatId, left_at: null }],
        );
        const level = yield* Effect.flip(KinLevels.effectiveLevel(growth));
        assert.strictEqual(level._tag === "KinLevelRefused" && level.reason, "not_a_lead");
        assert.deepStrictEqual(
          (yield* Provision.retire({ ...by, agentId: growth.agentId })).lead,
          retired.lead,
        );
        // Now Ada is the last again.
        assert.strictEqual(yield* refusal(Provision.retireOnHost(ada.agentId)), "last_agent");

        // Lists leave it out unless asked, and then show it after the live ones.
        const person = { ...identity.owner, personId: ada.ownerPersonId };
        assert.deepStrictEqual(
          (yield* Provision.profiles(person)).map((lead) => lead.agentId),
          [ada.agentId],
        );
        const all = yield* Provision.profiles(person, { includeRetired: true });
        assert.deepStrictEqual(
          all.map((lead) => [lead.agentId, lead.retired]),
          [
            [ada.agentId, undefined],
            [growth.agentId, { at, byPersonId: ada.ownerPersonId }],
          ],
        );
        assert.deepStrictEqual(yield* Provision.list(), [ada, retired.lead]);

        const restored = yield* Provision.restore({ ...by, agentId: growth.agentId });
        assert.strictEqual(restored._tag, "restored");
        assert.deepStrictEqual(restored.lead, growth);
        assert.isUndefined(restored.profile.retired);
        assert.strictEqual(yield* KinLevels.effectiveLevel(growth), "L0");
        assert.strictEqual(
          (yield* Provision.restore({ ...by, agentId: growth.agentId }))._tag,
          "already_live",
        );

        // The host's command retires through the same method, recording no person; a new lead
        // with its name then holds it, so the old one can't come back beside it.
        yield* TestClock.adjust("1 minute");
        const byHost = yield* Provision.retireOnHost(growth.agentId);
        assert.strictEqual(byHost.lead.retiredByPersonId, null);
        const twin = yield* Provision.create({
          ...input(owner, []),
          name: "Growth",
          domain: "growth",
        });
        assert.strictEqual(twin._tag, "created");
        assert.strictEqual(yield* refusal(Provision.restoreOnHost(growth.agentId)), "conflict");
      }).pipe(Effect.provide(paired)),
  );

  it.effect(
    "lets only the owner, or an agent's own creator once members may create, retire or restore it",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* Repository.KinChatRepository;
        const ada = (yield* Provision.create(input(owner, []))).lead;
        const growth = (yield* Provision.create({
          ...input(owner, []),
          name: "Growth",
          domain: "growth",
        })).lead;
        const teammate = KinPersonId.make("teammate");
        yield* repo.insertPerson({
          orgId: ada.orgId,
          personId: teammate,
          handle: "teammate",
          displayName: "Teammate",
          githubLogin: null,
          createdAt: "2026-11-09T00:00:00.000Z",
        });
        // A lead the teammate brought, as members will: written directly, as no path makes one yet.
        yield* repo.insertAgent({
          orgId: ada.orgId,
          agentId: KinAgentId.make("lead-sam"),
          displayName: "Sam's",
          role: "lead",
          ownerPersonId: teammate,
          createdAt: "2026-11-09T00:00:00.000Z",
        });
        yield* sql`INSERT INTO kin_leads (org_id, agent_id, name, level, level_since,
            models_json, worker_projects_json, owner_chat_id)
          SELECT org_id, 'lead-sam', 'Sam''s', level, level_since, models_json,
            worker_projects_json, owner_chat_id FROM kin_leads WHERE agent_id = ${ada.agentId}`;
        const before = yield* sql`SELECT agent_id, retired_at FROM kin_agents ORDER BY agent_id`;
        const asTeammate = {
          by: { _tag: "person", personId: teammate } as const,
          orgId: ada.orgId,
        };
        for (const run of [Provision.retire, Provision.restore]) {
          // Someone else's agent reads as not there; their own waits for members to create.
          assert.strictEqual(
            yield* refusal(run({ ...asTeammate, agentId: growth.agentId })),
            "not_found",
          );
          assert.strictEqual(
            yield* refusal(run({ ...asTeammate, agentId: KinAgentId.make("lead-sam") })),
            "not_owner",
          );
          // A session that isn't the owner's, and another org, change nothing either.
          assert.strictEqual(
            yield* refusal(
              run({
                by: session(AuthStandardClientScopes.slice(1)),
                orgId: ada.orgId,
                agentId: growth.agentId,
              }),
            ),
            "not_owner",
          );
          assert.strictEqual(
            yield* refusal(
              run({ by: owner, orgId: KinOrgId.make("org-b"), agentId: growth.agentId }),
            ),
            "not_found",
          );
        }
        assert.deepStrictEqual(
          yield* sql`SELECT agent_id, retired_at FROM kin_agents ORDER BY agent_id`,
          before,
        );
        // The owner retires any agent in the org, a teammate's included.
        assert.strictEqual(
          (yield* Provision.retire({
            by: owner,
            orgId: ada.orgId,
            agentId: KinAgentId.make("lead-sam"),
          }))._tag,
          "retired",
        );
      }).pipe(Effect.provide(paired)),
  );

  it.effect(
    "stops what a retired agent has in flight in one transaction, and restore resumes what it can",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ada = (yield* Provision.create(input(owner, []))).lead;
        const growth = (yield* Provision.create({
          ...input(owner, []),
          name: "Growth",
          domain: "growth",
        })).lead;
        const { orgId } = growth;
        const due = Date.parse("2026-11-12T09:00:00.000Z");
        // A turn under way holding one event, another event waiting, one already answered.
        yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status, event_ids)
          VALUES ('w-run', ${orgId}, ${growth.agentId}, 'test', 0, 'running', '[]')`;
        const event = (id: string, state: string, wakeupId: string | null) =>
          sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, dedupe_key,
              received_at, queued_at, state, wakeup_id)
            VALUES (${id}, ${orgId}, ${growth.agentId}, 'routine', 'P2', '{}', ${id}, 0, 0, ${state},
              ${wakeupId})`;
        yield* event("e-claimed", "claimed", "w-run");
        yield* event("e-queued", "queued", null);
        yield* event("e-done", "done", "w-run");
        const worker = (id: string, endedAt: number | null) =>
          sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id,
              model_json, provenance_json, status, started_at, ended_at)
            VALUES (${id}, ${orgId}, ${growth.agentId}, 'w-run', 'build', ${id}, '{}', '{}', 'running',
              5, ${endedAt})`;
        yield* worker("wk-open", null);
        yield* worker("wk-ended", 9);
        // Timers: a reminder in its own chat waits; one in Ada's chat is Ada's and runs on.
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_role, kind, body, mentions_json, status, created_at)
          VALUES ('card-g', ${orgId}, ${growth.ownerChatId}, 1, 'system', 'owner', 'system', '', '[]', 'posted', '2026-11-09T00:00:00.000Z'),
            ('card-a', ${orgId}, ${ada.ownerChatId}, 1, 'system', 'owner', 'system', '', '[]', 'posted', '2026-11-09T00:00:00.000Z')`;
        const timer = (kind: "deferral" | "scheduled", itemId: string, chatId: KinChatId) =>
          Effect.gen(function* () {
            const message = chatId === growth.ownerChatId ? "card-g" : "card-a";
            yield* sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class,
                type, revision, state_json, awaiting_json, updated_at)
              VALUES (${`${kind}:${orgId}:${itemId}`}, ${orgId}, ${chatId}, ${message}, 'native', 'card',
                1, '{}', '[]', '2026-11-09T00:00:00.000Z')`;
            if (kind === "deferral")
              yield* sql`INSERT INTO kin_deferral_runs (org_id, item_id, state, due_at, on_due, snapshot_json, updated_at)
                VALUES (${orgId}, ${itemId}, 'armed', ${due}, 'remind', '{}', 0)`;
            else
              yield* sql`INSERT INTO kin_scheduled_tasks (org_id, item_id, chat_id, state, paused, recorded_at, updated_at)
                VALUES (${orgId}, ${itemId}, ${chatId}, 'active', 0, '2026-11-09T00:00:00.000Z', 0)`;
            const triggerId = kind === "deferral" ? `deferral:${itemId}:due` : `schedule:${itemId}`;
            yield* sql`INSERT INTO kin_triggers (trigger_id, org_id, subject_json, schedule_json, time_zone, enabled, next_run_at, created_at, updated_at)
              VALUES (${triggerId}, ${orgId}, '{}', '{}', 'UTC', 1, ${due}, 0, 0)`;
          });
        yield* timer("deferral", "growth-call", growth.ownerChatId);
        yield* timer("scheduled", "growth-weekly", growth.ownerChatId);
        yield* timer("deferral", "ada-call", ada.ownerChatId);
        // Native schedules: one on, and one the owner had already paused.
        const native = (id: string, enabled: number) =>
          sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id,
              workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
              created_by, creation_source, created_at, updated_at, last_run_status, run_count)
            VALUES (${id}, ${id}, 'Invented', ${enabled}, '{"type":"fixed_time","timeOfDay":"09:00"}',
              'project', '{}', '{}', 'approval-required', 'plan', 'system', 'server',
              '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z', 'never', 0)`.pipe(
            Effect.andThen(
              sql`INSERT INTO kin_schedules (task_id, org_id, schedule_id, agent_id, chat_id,
                  source_event, said_by, audience, content_sha256, inbox_thread_id, created_at, updated_at)
                VALUES (${id}, ${orgId}, ${id}, ${growth.agentId}, ${growth.ownerChatId}, 'event',
                  'owner', 'owner_only', 'hash', 'inbox', 0, 1)`,
            ),
          );
        yield* native("sch-on", 1);
        yield* native("sch-off", 0);
        // Approval requests it raised (one waiting, one approved and not yet run) and one of Ada's.
        const action = (id: string, agentId: KinAgentId, state: string) =>
          sql`INSERT INTO kin_pending_actions (action_id, org_id, idempotency_key, kind, target_json,
              resolved_json, target_digest, nonce, revision, reason, requested_by_agent_id,
              requested_by_thread_id, provenance_json, required_approvers_json, state, created_at,
              updated_at, expires_at)
            VALUES (${id}, ${orgId}, ${id}, 'register_approver_key', '{}', '{"_tag":"none"}', 'digest',
              'nonce', 0, 'Invented', ${agentId}, 'thread', '{}', '[]', ${state}, 0, 0, ${due})`;
        yield* action("act-wait", growth.agentId, "awaiting_approval");
        yield* action("act-ok", growth.agentId, "approved");
        yield* action("act-ada", ada.agentId, "awaiting_approval");

        const state = Effect.gen(function* () {
          return {
            wakeups: yield* sql`SELECT wakeup_id, status, aborted_at IS NOT NULL AS aborted
              FROM kin_wakeups ORDER BY wakeup_id`,
            events: yield* sql`SELECT event_id, state FROM kin_events ORDER BY event_id`,
            attempts: yield* sql`SELECT worker_id, stopped_at IS NOT NULL AS stopped, stop_reason,
                stop_key FROM kin_worker_attempts ORDER BY worker_id`,
            triggers: yield* sql`SELECT trigger_id, enabled, next_run_at FROM kin_triggers
              ORDER BY trigger_id`,
            schedules:
              yield* sql`SELECT task_id, pending_enabled FROM kin_schedules ORDER BY task_id`,
            actions: yield* sql`SELECT action_id, state, state_reason FROM kin_pending_actions
              ORDER BY action_id`,
          };
        });
        yield* TestClock.adjust("1 minute");
        yield* Provision.retireOnHost(growth.agentId);
        const retiredKey = "kin-retired:wk-open:1970-01-01T00:01:00.000Z";
        const stoppedAttempts = [
          {
            worker_id: "wk-open",
            stopped: 1,
            stop_reason: RETIRED_WORKER_REASON,
            stop_key: retiredKey,
          },
        ];
        const expiredEvents = [
          { event_id: "e-claimed", state: "expired" },
          { event_id: "e-done", state: "done" },
          { event_id: "e-queued", state: "expired" },
        ];
        const closedActions = [
          { action_id: "act-ada", state: "awaiting_approval", state_reason: null },
          { action_id: "act-ok", state: "voided", state_reason: RETIRED_ACTION_REASON },
          { action_id: "act-wait", state: "cancelled", state_reason: RETIRED_ACTION_REASON },
        ];
        assert.deepStrictEqual(yield* state, {
          wakeups: [{ wakeup_id: "w-run", status: "running", aborted: 1 }],
          events: expiredEvents,
          attempts: stoppedAttempts,
          triggers: [
            { trigger_id: "deferral:ada-call:due", enabled: 1, next_run_at: due },
            { trigger_id: "deferral:growth-call:due", enabled: 0, next_run_at: due },
            { trigger_id: "schedule:growth-weekly", enabled: 0, next_run_at: due },
          ],
          schedules: [
            { task_id: "sch-off", pending_enabled: null },
            { task_id: "sch-on", pending_enabled: 0 },
          ],
          actions: closedActions,
        });

        // A time zone change meanwhile clears a disabled timer's next run; restore puts it back.
        yield* sql`UPDATE kin_triggers SET next_run_at = NULL WHERE trigger_id = 'deferral:growth-call:due'`;
        // The drain has since applied the pause to the native task, as a card's Pause would.
        yield* sql`UPDATE kin_schedules SET pending_enabled = NULL WHERE task_id = 'sch-on'`;
        yield* sql`UPDATE scheduled_tasks SET enabled = 0 WHERE task_id = 'sch-on'`;
        yield* Provision.restoreOnHost(growth.agentId);
        assert.deepStrictEqual(yield* state, {
          wakeups: [{ wakeup_id: "w-run", status: "running", aborted: 1 }],
          // Expired events, stopped workers and closed requests stay so.
          events: expiredEvents,
          attempts: stoppedAttempts,
          triggers: [
            { trigger_id: "deferral:ada-call:due", enabled: 1, next_run_at: due },
            { trigger_id: "deferral:growth-call:due", enabled: 1, next_run_at: due },
            { trigger_id: "schedule:growth-weekly", enabled: 1, next_run_at: due },
          ],
          // Only what retiring paused resumes; the owner's own pause stays.
          schedules: [
            { task_id: "sch-off", pending_enabled: null },
            { task_id: "sch-on", pending_enabled: 1 },
          ],
          actions: closedActions,
        });
        assert.deepStrictEqual(yield* sql`SELECT COUNT(*) AS n FROM kin_retirement_holds`, [
          { n: 0 },
        ]);
      }).pipe(Effect.provide(paired)),
  );

  it.effect(
    "replaces a live lead's worker projects, refusing unknown, retired and other-org leads",
    () =>
      Effect.gen(function* () {
        yield* seedProject;
        const sql = yield* SqlClient.SqlClient;
        const { lead } = yield* Provision.create(input(owner, []));
        const updated = yield* Provision.setWorkerProjects(lead.agentId, [project, project]);
        assert.deepStrictEqual(updated, {
          _tag: "updated",
          lead: { ...lead, workerProjects: [project] },
        });
        assert.deepStrictEqual(yield* Provision.list(), [updated.lead]);
        assert.strictEqual(
          yield* refusal(
            Provision.setWorkerProjects(lead.agentId, [project, ProjectId.make("missing")]),
          ),
          "unknown_project",
        );

        yield* sql`INSERT INTO kin_orgs (org_id, name, created_at) VALUES ('org-b', 'B', '2026-11-09T00:00:00.000Z')`;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('person-b', 'org-b', 'b', 'B', '2026-11-09T00:00:00.000Z')`;
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
        VALUES ('lead-b', 'org-b', 'B', 'lead', 'person-b', '2026-11-09T00:00:00.000Z')`;
        yield* sql`INSERT INTO kin_chats (chat_id, org_id, kind, last_seq, created_at) VALUES ('chat-b', 'org-b', 'team_group', 0, '2026-11-09T00:00:00.000Z')`;
        yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level_since, models_json, worker_projects_json, owner_chat_id)
        VALUES ('lead-b', 'org-b', 'B', 0, '{}', '[]', 'chat-b')`;
        assert.strictEqual(
          yield* refusal(Provision.setWorkerProjects(KinAgentId.make("lead-b"), [project])),
          "not_found",
        );
        assert.deepStrictEqual(
          yield* sql`SELECT worker_projects_json FROM kin_leads WHERE agent_id = 'lead-b' ORDER BY agent_id`,
          [{ worker_projects_json: "[]" }],
        );

        // Its only lead can't be retired through the service, so mark it as an older build did.
        yield* sql`UPDATE kin_agents SET retired_at = '2026-11-09T00:00:00.000Z'
          WHERE agent_id = ${lead.agentId}`;
        assert.strictEqual(
          yield* refusal(Provision.setWorkerProjects(lead.agentId, [])),
          "retired",
        );
        const [after] = yield* Provision.list();
        assert.deepStrictEqual(after?.workerProjects, [project]);
      }).pipe(Effect.provide(paired)),
  );
  it.effect(
    "shows a person their own live leads with what each has in hand, and no one else's",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const identity = yield* KinIdentity;
        const tech = (yield* Provision.create(input(owner, []))).lead;
        yield* TestClock.adjust("1 minute");
        const growth = (yield* Provision.create({
          ...input(owner, []),
          name: "Growth",
          domain: "growth",
          charter: "Grow signups.",
        })).lead;
        const person = { ...identity.owner, personId: tech.ownerPersonId };
        const quiet = {
          orgId: tech.orgId,
          agentId: tech.agentId,
          name: "Ada",
          domain: "engineering",
          charter: "",
          intro: "",
          model: "claude-opus-4-6",
          ownerChatId: tech.ownerChatId,
          working: false,
          tracking: [],
        };
        assert.deepStrictEqual(yield* Provision.profiles(person), [
          quiet,
          {
            ...quiet,
            agentId: growth.agentId,
            name: "Growth",
            domain: "growth",
            charter: "Grow signups.",
            ownerChatId: growth.ownerChatId,
          },
        ]);

        // Ada is on a turn, has a worker running, a reminder waiting and a task scheduled. A
        // reminder already given, a paused task and a finished worker are not in hand; nor is
        // one whose fire already went out, or a task she cancelled, which stops its trigger at once.
        const trigger = (triggerId: string, nextRunAt: number | null) =>
          sql`INSERT INTO kin_triggers (trigger_id, org_id, subject_json, schedule_json, time_zone, enabled, next_run_at, created_at, updated_at)
            VALUES (${triggerId}, ${orgId}, '{}', '{}', 'UTC', ${nextRunAt === null ? 0 : 1}, ${nextRunAt}, 0, 0)`;
        const { orgId } = tech;
        yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status, event_ids)
          VALUES ('wake', ${orgId}, ${tech.agentId}, 'test', 0, 'running', '[]')`;
        const worker = (id: string, title: string, endedAt: number | null) =>
          sql`INSERT INTO kin_workers (worker_id, org_id, agent_id, wakeup_id, kind, thread_id, model_json, provenance_json, status, started_at, ended_at, title, chat_id)
            VALUES (${id}, ${orgId}, ${tech.agentId}, 'wake', 'build', ${id}, '{}', '{}', 'queued', 5, ${endedAt}, ${title}, ${tech.ownerChatId})`;
        yield* worker("wk-open", "Add a README section", null);
        yield* worker("wk-done", "Old task", 9);
        yield* sql`INSERT INTO kin_messages (message_id, org_id, chat_id, seq, author_kind, author_role, kind, body, mentions_json, status, created_at)
          VALUES ('card', ${orgId}, ${tech.ownerChatId}, 1, 'system', 'owner', 'system', '', '[]', 'posted', '2026-11-09T00:00:00.000Z')`;
        const card = (widgetId: string, title: string) =>
          sql`INSERT INTO kin_widgets (widget_id, org_id, chat_id, message_id, widget_class, type, revision, state_json, awaiting_json, updated_at)
            VALUES (${widgetId}, ${orgId}, ${tech.ownerChatId}, 'card', 'native', 'card', 1, ${JSON.stringify({ title })}, '[]', '2026-11-09T00:00:00.000Z')`;
        const deferral = (
          itemId: string,
          state: string,
          onDue: string,
          dueAt: number,
          nextRunAt: number | null = dueAt,
        ) =>
          sql`INSERT INTO kin_deferral_runs (org_id, item_id, state, due_at, on_due, snapshot_json, updated_at)
            VALUES (${orgId}, ${itemId}, ${state}, ${dueAt}, ${onDue}, '{}', 0)`.pipe(
            Effect.andThen(card(`deferral:${orgId}:${itemId}`, `Title of ${itemId}`)),
            Effect.andThen(trigger(`deferral:${itemId}:due`, nextRunAt)),
          );
        const due = Date.parse("2026-11-12T09:00:00.000Z");
        yield* deferral("later", "armed", "start", due + 1000);
        // Snoozed an hour before it was due: it is tracked at the time it will come back.
        yield* deferral("soon", "snoozed", "remind", due - 3_600_000, due);
        yield* deferral("given", "reminded", "remind", due, null);
        yield* deferral("fired", "armed", "remind", due - 1000, null);
        const scheduled = (itemId: string, paused: number, nextRunAt: number | null = due) =>
          sql`INSERT INTO kin_scheduled_tasks (org_id, item_id, chat_id, state, paused, recorded_at, updated_at)
            VALUES (${orgId}, ${itemId}, ${tech.ownerChatId}, 'active', ${paused}, '2026-11-09T00:00:00.000Z', 0)`.pipe(
            Effect.andThen(card(`scheduled:${orgId}:${itemId}`, `Title of ${itemId}`)),
            Effect.andThen(trigger(`schedule:${itemId}`, nextRunAt)),
          );
        yield* scheduled("daily", 0);
        yield* scheduled("resting", 1, null);
        yield* scheduled("dropped", 0, null);
        // A native schedule is tracked by its own lead while its task is on.
        const native = (id: string, enabled: number) =>
          sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id,
              workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
              created_by, creation_source, created_at, updated_at, last_run_status, run_count)
            VALUES (${`scheduled-task:kin:schedule:${orgId}:${id}`}, ${`Native ${id}`}, 'Invented', ${enabled},
              '{"type":"fixed_time","timeOfDay":"09:00"}', 'project', '{}', '{}', 'approval-required',
              'plan', 'system', 'server', '2026-11-09T00:00:00.000Z', '2026-11-09T00:00:00.000Z',
              'never', 0)`.pipe(
            Effect.andThen(
              sql`INSERT INTO kin_schedules (task_id, org_id, schedule_id, agent_id, chat_id,
                  source_event, said_by, audience, content_sha256, inbox_thread_id, created_at,
                  updated_at)
                VALUES (${`scheduled-task:kin:schedule:${orgId}:${id}`}, ${orgId}, ${id},
                  ${tech.agentId}, ${tech.ownerChatId}, 'event', 'owner', 'owner_only', 'hash',
                  'inbox', 0, 1)`,
            ),
          );
        yield* native("sch-on", 1);
        yield* native("sch-off", 0);
        const chatId = tech.ownerChatId;
        const [ada, other] = yield* Provision.profiles(person);
        assert.deepInclude(ada, {
          working: true,
          tracking: [
            { kind: "work", title: "Add a README section", chatId },
            { kind: "reminder", title: "Title of soon", dueAt: "2026-11-12T09:00:00.000Z", chatId },
            {
              kind: "follow_up",
              title: "Title of later",
              dueAt: "2026-11-12T09:00:01.000Z",
              chatId,
            },
            { kind: "scheduled", title: "Title of daily", chatId },
            { kind: "scheduled", title: "Native sch-on", chatId },
          ],
        });
        assert.deepInclude(other, { working: false, tracking: [] });

        // A teammate has no leads; a retired lead leaves the list.
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
          VALUES ('teammate', ${orgId}, 'teammate', 'Teammate', '2026-11-09T00:00:00.000Z')`;
        assert.deepStrictEqual(
          yield* Provision.profiles({ ...person, personId: KinPersonId.make("teammate") }),
          [],
        );
        yield* Provision.retireOnHost(growth.agentId);
        assert.lengthOf(yield* Provision.profiles(person), 1);
      }).pipe(Effect.provide(paired)),
  );

  it.effect("lets only the owner rename a lead of theirs and change what it is for", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tech = (yield* Provision.create(input(owner, []))).lead;
      const growth = (yield* Provision.create({
        ...input(owner, []),
        name: "Growth",
        domain: "growth",
      })).lead;
      const edit = (
        fields: Parameters<typeof Provision.update>[0]["fields"],
        agentId = tech.agentId,
        editor = owner,
      ) => Provision.update({ editor, orgId: tech.orgId, agentId, fields });
      assert.deepInclude(yield* edit({ name: "Tech lead", charter: "Ship the app." }), {
        agentId: tech.agentId,
        name: "Tech lead",
        domain: "engineering",
        charter: "Ship the app.",
      });
      // Chats show the agent's name; the lead keeps its chat, level and projects.
      assert.deepStrictEqual(
        yield* sql`SELECT a.display_name AS name, l.name AS lead, l.level, l.owner_chat_id AS chat
          FROM kin_agents a JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
          WHERE a.org_id = ${tech.orgId} AND a.agent_id = ${tech.agentId} ORDER BY a.agent_id`,
        [{ name: "Tech lead", lead: "Tech lead", level: "L0", chat: tech.ownerChatId }],
      );
      // An omitted field stays; two live leads can't share a name and domain.
      assert.deepInclude(yield* edit({ domain: "platform" }), {
        name: "Tech lead",
        charter: "Ship the app.",
      });
      assert.strictEqual(yield* refusal(edit({ name: "Growth", domain: "growth" })), "conflict");

      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('teammate', ${tech.orgId}, 'teammate', 'Teammate', '2026-11-09T00:00:00.000Z')`;
      const teammate = { _tag: "person", personId: KinPersonId.make("teammate") } as const;
      assert.strictEqual(
        yield* refusal(edit({ name: "Mine" }, tech.agentId, teammate)),
        "not_owner",
      );
      assert.strictEqual(
        yield* refusal(
          edit({ name: "Mine" }, tech.agentId, session(AuthStandardClientScopes.slice(1))),
        ),
        "not_owner",
      );
      assert.strictEqual(
        yield* refusal(edit({ name: "X" }, KinAgentId.make("lead-nowhere"))),
        "not_found",
      );
      assert.strictEqual(
        yield* refusal(
          Provision.update({
            editor: owner,
            orgId: KinOrgId.make("org-b"),
            agentId: tech.agentId,
            fields: { name: "X" },
          }),
        ),
        "not_found",
      );
      yield* Provision.retireOnHost(growth.agentId);
      assert.strictEqual(yield* refusal(edit({ name: "X" }, growth.agentId)), "retired");
    }).pipe(Effect.provide(paired)),
  );
  it.effect(
    "lets only the owner choose who may message a lead, in a chat that is that person's own",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const repo = yield* Repository.KinChatRepository;
        const chats = yield* ChatService.KinChatService;
        const finance = (yield* Provision.create({
          ...input(owner, []),
          name: "Finance",
          domain: "finance",
          charter: "Private: chase the Acme invoice.",
        })).lead;
        const tech = (yield* Provision.create(input(owner, []))).lead;
        for (const name of ["Priya", "Sam"])
          yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
            VALUES (${name.toLowerCase()}, ${finance.orgId}, ${name.toLowerCase()}, ${name}, '2026-11-09T00:00:00.000Z')`;
        const priyaId = KinPersonId.make("priya");
        const priya = { _tag: "person", orgId: finance.orgId, personId: priyaId } as const;
        const on = { editor: owner, orgId: finance.orgId, agentId: finance.agentId };
        const her = { ...on, personId: priyaId };
        const member = (chatId: KinChatId) =>
          repo
            .listMembers({ orgId: finance.orgId, chatId })
            .pipe(
              Effect.map((members) =>
                members.find(
                  ({ principal }) => principal._tag === "person" && principal.personId === priyaId,
                ),
              ),
            );

        // Nobody but the owner, until the owner says so.
        assert.deepStrictEqual(yield* Provision.access(on), { people: [] });
        assert.deepStrictEqual(yield* Provision.contacts(priya), []);
        assert.include(yield* chats.createDirect(priya, finance).pipe(Effect.flip), {
          reason: "not_allowed",
        });

        assert.deepStrictEqual(
          (yield* Provision.allow(her)).people.map(({ personId, displayName }) => ({
            personId,
            displayName,
          })),
          [{ personId: priyaId, displayName: "Priya" }],
        );
        const [contact] = yield* Provision.contacts(priya);
        assert.isDefined(contact);
        // What a teammate is told about the lead: never its charter, domain, model or work.
        assert.deepStrictEqual(contact, {
          orgId: finance.orgId,
          agentId: finance.agentId,
          name: "Finance",
          intro: "",
          chatId: contact.chatId,
          // The owner runs the machine and can read this chat; the teammate is told so.
          ownerName: "Owner",
        });
        // Her own chat with it: the owner is not in it, and she doesn't hold the owner's role.
        assert.notStrictEqual(contact.chatId, finance.ownerChatId);
        assert.sameDeepMembers(
          (yield* repo.listMembers({ orgId: finance.orgId, chatId: contact.chatId })).map(
            ({ principal, role, leftAt }) => ({ principal, role, leftAt }),
          ),
          [
            {
              principal: { _tag: "agent", agentId: finance.agentId },
              role: "member",
              leftAt: null,
            },
            { principal: { _tag: "person", personId: priyaId }, role: "member", leftAt: null },
          ],
        );
        // The lead may talk there and no more; in a chat nobody placed it in, it stays silent.
        assert.strictEqual(
          yield* KinLevels.effectiveLevel({ ...finance, chatId: contact.chatId }),
          "L1",
        );
        // Allowing her twice, or her asking to start the chat, gives the same chat.
        const before = yield* counts;
        yield* Provision.allow(her);
        assert.strictEqual((yield* chats.createDirect(priya, finance)).chatId, contact.chatId);
        assert.deepStrictEqual(yield* counts, before);
        // Access to one lead is access to that lead only.
        assert.include(yield* chats.createDirect(priya, tech).pipe(Effect.flip), {
          reason: "not_allowed",
        });

        yield* Provision.update({ ...on, fields: { intro: " Handles invoices. " } });
        assert.strictEqual((yield* Provision.contacts(priya))[0]?.intro, "Handles invoices.");
        assert.strictEqual(
          (yield* Provision.profiles((yield* KinIdentity).owner)).find(
            (lead) => lead.agentId === finance.agentId,
          )?.intro,
          "Handles invoices.",
        );

        // Only the owner, and only for a live lead of theirs and a person of the org.
        const teammate = { _tag: "person", personId: priyaId } as const;
        const sam = KinPersonId.make("sam");
        assert.strictEqual(
          yield* refusal(Provision.access({ ...on, editor: teammate })),
          "not_owner",
        );
        for (const editor of [teammate, session(AuthStandardClientScopes.slice(1))]) {
          assert.strictEqual(
            yield* refusal(Provision.allow({ ...her, editor, personId: sam })),
            "not_owner",
          );
          assert.strictEqual(yield* refusal(Provision.disallow({ ...her, editor })), "not_owner");
        }
        for (const target of [
          { ...her, agentId: KinAgentId.make("lead-nowhere") },
          { ...her, orgId: KinOrgId.make("org-b") },
          { ...her, personId: KinPersonId.make("nobody") },
          { ...her, personId: finance.ownerPersonId },
        ])
          assert.strictEqual(yield* refusal(Provision.allow(target)), "not_found");
        // A lead someone else owns is not the owner's to share.
        yield* sql`UPDATE kin_agents SET owner_person_id = 'sam' WHERE agent_id = ${tech.agentId}`;
        assert.strictEqual(
          yield* refusal(Provision.access({ ...on, agentId: tech.agentId })),
          "not_found",
        );
        assert.strictEqual(
          yield* refusal(Provision.allow({ ...her, agentId: tech.agentId })),
          "not_found",
        );

        // Taken away before she wrote anything: the chat leaves her list.
        assert.deepStrictEqual(yield* Provision.disallow(her), { people: [] });
        assert.deepStrictEqual(yield* Provision.contacts(priya), []);
        assert.isNotNull((yield* member(contact.chatId))?.leftAt);
        assert.include(yield* chats.createDirect(priya, finance).pipe(Effect.flip), {
          reason: "not_allowed",
        });
        // Allowed again: the same chat, hers to write in.
        yield* Provision.allow(her);
        assert.strictEqual((yield* Provision.contacts(priya))[0]?.chatId, contact.chatId);
        assert.include(yield* member(contact.chatId), { role: "member", leftAt: null });

        const say = (id: string) =>
          chats.send(priya, {
            chatId: contact.chatId,
            clientMessageId: id as never,
            body: "Is the invoice out?",
          });
        yield* say("one");
        yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, dedupe_key, received_at, queued_at)
          VALUES ('waiting', ${finance.orgId}, ${finance.agentId}, 'chat.message', 'P1',
            ${JSON.stringify({ chatId: contact.chatId })}, 'waiting', 0, 0)`;
        // Taken away after she wrote: what waited is dropped, and the chat is hers to read only.
        yield* Provision.disallow(her);
        assert.deepStrictEqual(
          yield* sql`SELECT state FROM kin_events WHERE event_id = 'waiting'`,
          [{ state: "expired" }],
        );
        assert.include(yield* member(contact.chatId), { role: "guest", leftAt: null });
        assert.include(yield* say("two").pipe(Effect.flip), { reason: "not_allowed" });
        assert.lengthOf(
          (yield* chats.history(priya, { chatId: contact.chatId, beforeSeq: 100, limit: 10 }))
            .messages,
          1,
        );
        assert.deepStrictEqual(yield* Provision.contacts(priya), []);
        yield* Provision.allow(her);
        assert.include(yield* member(contact.chatId), { role: "member", leftAt: null });
        yield* say("three");
      }).pipe(Effect.provide(paired)),
  );
});
