import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KinAgentId,
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
      // It works at L2 in that chat from creation; the shadow week is for groups.
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
});
