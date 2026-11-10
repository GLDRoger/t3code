import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KinAgentId,
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
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as KinLevels from "./KinLevels.ts";
import * as Provision from "./KinLeadProvision.ts";

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

  it.effect("retires a lead, lists it as retired, and lets a new lead follow", () =>
    Effect.gen(function* () {
      const first = yield* Provision.create(input(owner, []));
      const { agentId } = first.lead;
      assert.strictEqual(yield* refusal(Provision.retire(KinAgentId.make("missing"))), "not_found");
      const retired = yield* Provision.retire(agentId);
      assert.strictEqual(retired._tag, "retired");
      assert.isNotNull(retired.lead.retiredAt);
      const level = yield* Effect.flip(KinLevels.effectiveLevel(first.lead));
      assert.strictEqual(level._tag === "KinLevelRefused" && level.reason, "not_a_lead");
      assert.deepStrictEqual(yield* Provision.retire(agentId), {
        _tag: "already_retired",
        lead: retired.lead,
      });
      assert.deepStrictEqual(yield* Provision.list(), [retired.lead]);

      yield* TestClock.adjust("1 minute");
      const next = yield* Provision.create(input(owner, []));
      assert.strictEqual(next._tag, "created");
      assert.notStrictEqual(next.lead.agentId, agentId);
      assert.deepStrictEqual(yield* Provision.list(), [retired.lead, next.lead]);
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

        yield* Provision.retire(lead.agentId);
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
        // reminder already given, a paused task and a finished worker are not in hand.
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
        const deferral = (itemId: string, state: string, onDue: string, dueAt: number) =>
          sql`INSERT INTO kin_deferral_runs (org_id, item_id, state, due_at, on_due, snapshot_json, updated_at)
            VALUES (${orgId}, ${itemId}, ${state}, ${dueAt}, ${onDue}, '{}', 0)`.pipe(
            Effect.andThen(card(`deferral:${orgId}:${itemId}`, `Title of ${itemId}`)),
          );
        const due = Date.parse("2026-11-12T09:00:00.000Z");
        yield* deferral("later", "armed", "start", due + 1000);
        yield* deferral("soon", "snoozed", "remind", due);
        yield* deferral("given", "reminded", "remind", due);
        const scheduled = (itemId: string, paused: number) =>
          sql`INSERT INTO kin_scheduled_tasks (org_id, item_id, chat_id, state, paused, recorded_at, updated_at)
            VALUES (${orgId}, ${itemId}, ${tech.ownerChatId}, 'active', ${paused}, '2026-11-09T00:00:00.000Z', 0)`.pipe(
            Effect.andThen(card(`scheduled:${orgId}:${itemId}`, `Title of ${itemId}`)),
          );
        yield* scheduled("daily", 0);
        yield* scheduled("resting", 1);
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
        yield* Provision.retire(growth.agentId);
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
      yield* Provision.retire(growth.agentId);
      assert.strictEqual(yield* refusal(edit({ name: "X" }, growth.agentId)), "retired");
    }).pipe(Effect.provide(paired)),
  );
});
