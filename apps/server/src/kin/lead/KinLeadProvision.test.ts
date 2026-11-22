import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KIN_HOST_TROUBLE_CARD,
  KinAgentId,
  KinEventId,
  KinHostTroubleCard,
  type KinAgentPage,
  type KinChatId,
  KinOrgId,
  KinPersonId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import type { AuthenticatedSession } from "../../auth/EnvironmentAuth.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import { ServerConfig } from "../../config.ts";
import { ProviderRegistry } from "../../provider/ProviderRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as ChatService from "../chat/KinChatService.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as HostCare from "../host/KinHostCare.ts";
import * as RefreshHub from "../chat/KinRefreshHub.ts";
import * as ArrivalStore from "../arrivals/ArrivalStore.ts";
import * as KinWatches from "../watches/KinWatches.ts";
import * as WatchReads from "../watches/readRpcs.ts";
import { KIN_OWNER_LEVEL } from "../work/teamView.ts";
import * as KinLevels from "./KinLevels.ts";
import * as RetiredActions from "../approvals/retiredActions.ts";
import * as Provision from "./KinLeadProvision.ts";
import { ownerLevelAgentPage, ownerLevelSetCharacter } from "./agentPage.ts";
import { seedCharacters } from "./characters.ts";
import { seedPlaybooks } from "../work/playbookSeeds.ts";
import * as KinRecords from "../work/KinRecords.ts";
import { KinLevelGate } from "./LevelGate.ts";
import * as KinEventQueue from "./KinEventQueue.ts";
import { RETIRED_ACTION_REASON } from "./Retirement.ts";

const decodeTroubleCard = Schema.decodeUnknownSync(Schema.fromJsonString(KinHostTroubleCard));

const layer = Layer.merge(Provision.layer, RetiredActions.hostLayer).pipe(
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
  model: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-4-6" },
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
const decodeProvider = Schema.decodeEffect(ServerProvider);
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
    "refuses anyone but the host's Kin owner, unknown worker projects and models on a provider Kin may not use",
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
        // A provider Kin plans no session for, or Codex with the switch off, is refused.
        for (const instanceId of ["codex", "mine", "missing"]) {
          const model = { instanceId: ProviderInstanceId.make(instanceId), model: "gpt-5.5" };
          assert.strictEqual(
            yield* refusal(Provision.create({ ...input(owner, []), model })),
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
      // No model named: the org's first lead's.
      const { model: _model, ...noModel } = input(owner, []);
      yield* TestClock.adjust("1 minute");
      const finance = yield* Provision.create({
        ...noModel,
        name: "Finance",
        domain: "finance",
        charter: "Invoices and chasing what's overdue.",
      });
      assert.deepStrictEqual(finance.lead.model, tech.model);
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

        const at0 = "1970-01-01T00:00:00.000Z";
        // The owner wrote to it and it hadn't answered yet: retiring tells him so, once.
        const chats = yield* ChatService.KinChatService;
        const me = { ...identity.owner, personId: ada.ownerPersonId };
        const asked = yield* chats.send(me, {
          chatId: growth.ownerChatId,
          body: "Draft the launch post?",
          clientMessageId: "before-retire",
        });
        yield* sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, dedupe_key, received_at, queued_at)
          VALUES ('unanswered', ${growth.orgId}, ${growth.agentId}, 'chat.message', 'P0',
            ${JSON.stringify({ chatId: growth.ownerChatId, messageId: asked.messageId })},
            'unanswered', 0, 0)`;
        const { orgId, agentId } = growth;
        yield* sql`INSERT INTO kin_watches (org_id, watch_id, kind, source, source_key, about,
            closes_when, agent_id, audience, why, set_by_kind, set_by_id, latest_by, next_look_at,
            interval_ms, state, closed_at, closed_how, closed_by_kind, closed_by_id,
            created_at, updated_at)
          VALUES (${orgId}, 'open-watch', 'task_out', 'agent', 'open-watch', 'a task',
              'the task is done', ${agentId}, 'owner', 'asked', 'agent', ${agentId}, 120000,
              60000, 60000, 'open', NULL, NULL, NULL, NULL, 0, 0),
            (${orgId}, 'closed-watch', 'task_out', 'agent', 'closed-watch', 'an old task',
              'the task is done', ${agentId}, 'owner', 'asked', 'agent', ${agentId}, 120000,
              60000, 60000, 'closed', 60000, 'done', 'agent', ${agentId}, 0, 60000)`;
        const reader = { personId: ada.ownerPersonId, viewer: KIN_OWNER_LEVEL };
        const closedWatch = sql`SELECT * FROM kin_watches
          WHERE org_id = ${orgId} AND watch_id = 'closed-watch'`;
        const closedBefore = yield* closedWatch;
        const [stale] = yield* KinWatches.openWatches(orgId);
        yield* sql`INSERT INTO kin_connections (org_id, connection_id, label, kind, url_host,
            auth, reach, state, created_at, updated_at)
          VALUES (${orgId}, 'arrival-mailbox', 'Invented mail', 'builtin', 'mail.example.invalid',
            'none', 'closed', 'active', 0, 0)`;
        yield* sql`INSERT INTO kin_arrivals (org_id, arrival_id, connection_id, message_id,
            noticed_at, state, agent_id, event_id)
          VALUES (${orgId}, 'arrival-1', 'arrival-mailbox', 'mail-1', 0, 'looking', ${agentId},
            'unanswered')`;
        const arrival = sql`SELECT * FROM kin_arrivals WHERE org_id = ${orgId}
          AND arrival_id = 'arrival-1'`;
        const arrivalBefore = yield* arrival;
        const refresh = (yield* RefreshHub.KinRefreshHub).changes(orgId).pipe(Stream.runHead);
        const initialRevision = Option.getOrThrow(yield* refresh).watches;
        const care = yield* HostCare.KinHostCare;
        yield* sql`UPDATE kin_events SET not_before = 120000 WHERE org_id = ${orgId}
          AND event_id = 'unanswered'`;
        yield* sql`INSERT INTO kin_events
            (event_id, org_id, agent_id, tag, priority, json, received_at, queued_at, state, not_before)
          VALUES ('growth-spent', ${orgId}, ${agentId}, 'routine', 'P1', '{}', 0, 0, 'failed', 120000),
            ('ada-held', ${orgId}, ${ada.agentId}, 'routine', 'P1', '{}', 0, 0, 'queued', 120000)`;
        for (const [cause, troubleAgent, event] of [
          ["signin", agentId, "unanswered"],
          ["signin", ada.agentId, "ada-held"],
          ["model", agentId, "growth-spent"],
        ] as const) {
          yield* care.failed({
            orgId,
            agentId: troubleAgent,
            cause,
            eventIds: [KinEventId.make(event)],
          });
        }
        const troubleCards = sql<{ state: string; closed: string | null }>`SELECT
            state_json AS state, closed_at AS closed FROM kin_widgets
          WHERE org_id = ${orgId} AND type = ${KIN_HOST_TROUBLE_CARD} ORDER BY widget_id`.pipe(
          Effect.map((rows) =>
            rows.map((row) => ({
              ...decodeTroubleCard(row.state),
              open: row.closed === null,
            })),
          ),
        );
        assert.deepStrictEqual(
          (yield* troubleCards).map((card) => [card.cause, card.open]),
          [
            ["model", true],
            ["signin", true],
          ],
        );
        const retired = yield* Provision.retire({ ...by, agentId });
        assert.strictEqual(retired._tag, "retired");
        assert.strictEqual(Option.getOrThrow(yield* refresh).watches, initialRevision + 1);
        assert.deepStrictEqual(yield* KinWatches.openWatches(orgId), []);
        assert.deepInclude(yield* WatchReads.one(orgId, reader, "open-watch"), {
          agentId,
          state: "closed",
          closedHow: "its agent was retired",
          nextLookAt: null,
          latestBy: "1970-01-01T00:02:00.000Z",
        });
        assert.deepStrictEqual(yield* closedWatch, closedBefore);
        assert.deepStrictEqual(yield* arrival, arrivalBefore);
        assert.deepStrictEqual(
          yield* ArrivalStore.known(orgId, "arrival-mailbox", ["mail-1"]),
          new Set(["mail-1"]),
        );
        assert.deepStrictEqual(yield* ArrivalStore.parkedDue(orgId, "arrival-mailbox", 60000), []);
        assert.deepStrictEqual(
          yield* sql`SELECT state FROM kin_events WHERE org_id = ${orgId} AND agent_id = ${agentId}
            ORDER BY event_id`,
          [{ state: "expired" }, { state: "expired" }],
        );
        const afterRetirement = yield* care.status(orgId);
        assert.strictEqual(afterRetirement.agents.held, 1);
        assert.deepStrictEqual(
          afterRetirement.agents.troubles.map(({ card }) => [card.cause, card.count]),
          [["signin", 1]],
        );
        assert.deepStrictEqual(
          (yield* troubleCards).map((card) => [
            card.cause,
            card.open,
            card.count,
            card.agents.map((agent) => agent.name),
          ]),
          [
            ["model", false, 0, ["Growth"]],
            ["signin", true, 1, ["Ada"]],
          ],
        );
        assert.deepStrictEqual(yield* care.retry(orgId), { requeued: 1 });
        yield* sql`UPDATE kin_events SET not_before = 120000 WHERE org_id = ${orgId}
          AND event_id = 'ada-held'`;
        yield* care.succeeded(orgId, ada.agentId);
        assert.isFalse(yield* care.troubleOpen(orgId, "signin"));
        assert.deepStrictEqual(
          yield* sql`SELECT event_id, state, not_before FROM kin_events WHERE org_id = ${orgId}
            AND held_by IS NOT NULL ORDER BY event_id`,
          [
            { event_id: "ada-held", state: "queued", not_before: 60000 },
            { event_id: "growth-spent", state: "expired", not_before: 120000 },
            { event_id: "unanswered", state: "expired", not_before: 120000 },
          ],
        );
        assert.isFalse(
          yield* care.failed({
            orgId,
            agentId,
            cause: "model",
            eventIds: [KinEventId.make("growth-spent")],
          }),
        );
        const closedTroubleCards = yield* troubleCards;
        assert.deepStrictEqual(
          closedTroubleCards.map((card) => [card.cause, card.open]),
          [
            ["model", false],
            ["signin", false],
          ],
        );
        const troubleMessages = sql`SELECT m.message_id FROM kin_messages m JOIN kin_troubles t
          ON t.org_id = m.org_id AND t.trouble_id = m.message_id WHERE m.org_id = ${orgId}
          ORDER BY m.message_id`;
        const toldOnce = yield* troubleMessages;
        assert.lengthOf(toldOnce, 2);
        for (const id of ["open-watch", "closed-watch"])
          assert.deepInclude(yield* KinWatches.again(orgId, reader, id).pipe(Effect.flip), {
            reason: "invalid_state",
          });
        assert.strictEqual(
          yield* KinWatches.upsert({
            orgId,
            at: 60000,
            kind: { kind: "task_out", source: "task" },
            found: [
              {
                sourceKey: "found-before-retiring",
                subjectRef: null,
                recordId: null,
                about: "another task",
                closesWhen: "the task is done",
                why: "a task was found",
                agentId,
              },
            ],
          }),
          0,
        );
        assert.strictEqual(
          yield* KinWatches.settleClock({
            orgId,
            at: 60000,
            moved: new Set(),
            asleep: new Map([["open-watch", null]]),
            watches: [stale!],
          }),
          0,
        );
        yield* KinWatches.recordRound({
          orgId,
          at: 60000,
          looks: [
            {
              watch: stale!,
              why: "routine",
              outcome: { _tag: "nothing_new", evidence: [] },
              checksWork: true,
            },
          ],
        });
        assert.deepStrictEqual(
          (yield* WatchReads.log(orgId, reader, {
            watchId: "open-watch",
            timeZone: "UTC",
          })).rows.map((row) => row._tag === "look" && row.look.line),
          ["its agent was retired"],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT body FROM kin_messages WHERE chat_id = ${growth.ownerChatId}
            AND author_kind = 'system'`,
          [{ body: "Growth has been retired, so it won't see this or reply." }],
        );
        // Writing to it now is refused when sent, saying why, rather than met with silence.
        assert.deepInclude(
          yield* chats
            .send(me, {
              chatId: growth.ownerChatId,
              body: "Still there?",
              clientMessageId: "after-retire",
            })
            .pipe(Effect.flip),
          { reason: "not_allowed", message: "Growth has been retired, so this wasn't sent." },
        );
        // So is writing to a live agent no turn answers.
        yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
          VALUES ('helper', ${growth.orgId}, 'Helper', 'specialist', ${ada.ownerPersonId}, ${at0})`;
        const helper = yield* chats.createDirect(me, {
          orgId: growth.orgId,
          agentId: KinAgentId.make("helper"),
        });
        assert.deepInclude(
          yield* chats
            .send(me, { chatId: helper.chatId, body: "Hello?", clientMessageId: "to-helper" })
            .pipe(Effect.flip),
          {
            reason: "not_allowed",
            message: "Helper doesn't answer messages here, so this wasn't sent.",
          },
        );
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
        yield* care.refresh(orgId);
        assert.deepStrictEqual(yield* care.retry(orgId), { requeued: 0 });
        assert.deepStrictEqual(yield* troubleCards, closedTroubleCards);
        assert.deepStrictEqual(yield* troubleMessages, toldOnce);
        assert.strictEqual(Option.getOrThrow(yield* refresh).watches, initialRevision + 2);
        assert.deepInclude(yield* WatchReads.one(orgId, reader, "open-watch"), {
          state: "open",
          closedHow: null,
          nextLookAt: "1970-01-01T00:01:00.000Z",
        });
        assert.deepStrictEqual(yield* closedWatch, closedBefore);
        assert.deepStrictEqual(yield* arrival, arrivalBefore);
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
        yield* care.failed({ orgId, agentId, cause: "model", eventIds: [] });
        const byHost = yield* Provision.retireOnHost(growth.agentId).pipe(
          Effect.updateContext((services: Context.Context<Provision.Requirements>) =>
            Context.omit(HostCare.KinHostCare)(services),
          ),
        );
        assert.strictEqual(byHost.lead.retiredByPersonId, null);
        assert.isFalse(yield* care.troubleOpen(orgId, "model"));
        assert.lengthOf(
          (yield* troubleCards).filter((card) => card.open),
          1,
        );
        yield* care.refresh(orgId, { closedOnly: true });
        assert.lengthOf(
          (yield* troubleCards).filter((card) => card.open),
          0,
        );
        const twin = yield* Provision.create({
          ...input(owner, []),
          name: "Growth",
          domain: "growth",
        });
        assert.strictEqual(twin._tag, "created");
        assert.strictEqual(yield* refusal(Provision.restoreOnHost(growth.agentId)), "conflict");
      }).pipe(
        Effect.provide(
          HostCare.layer.pipe(
            Layer.provideMerge(KinEventQueue.layer),
            Layer.provideMerge(RefreshHub.layer),
            Layer.provideMerge(paired),
            Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "kin-retirement-" })),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
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
        yield* sql`UPDATE kin_people SET access = 'member' WHERE person_id = ${teammate}`;
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
        type Change = Parameters<typeof Provision.retire>[0];
        for (const run of [
          (change: Change) => Provision.retire(change).pipe(Effect.asVoid),
          (change: Change) => Provision.restore(change).pipe(Effect.asVoid),
        ]) {
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
        // Retired agents, and who retired them, are listed for the org's owner alone.
        const sam = { ...(yield* KinIdentity).owner, personId: teammate };
        assert.deepStrictEqual(yield* Provision.profiles(sam, { includeRetired: true }), []);
        assert.deepStrictEqual(yield* Provision.profiles(sam), []);
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
          // Expired events and closed requests stay so.
          events: expiredEvents,
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

        // Retired again: the timers and schedules the restore resumed wait again, and a second
        // restore resumes them; what the first retirement stopped or closed stays as it was.
        yield* TestClock.adjust("1 minute");
        yield* Provision.retireOnHost(growth.agentId);
        const held = yield* state;
        assert.deepStrictEqual(held.triggers, [
          { trigger_id: "deferral:ada-call:due", enabled: 1, next_run_at: due },
          { trigger_id: "deferral:growth-call:due", enabled: 0, next_run_at: due },
          { trigger_id: "schedule:growth-weekly", enabled: 0, next_run_at: due },
        ]);
        assert.deepStrictEqual(held.schedules, [
          { task_id: "sch-off", pending_enabled: null },
          { task_id: "sch-on", pending_enabled: 0 },
        ]);
        assert.deepStrictEqual(held.actions, closedActions);
        assert.deepStrictEqual(
          yield* sql`SELECT kind, target_id FROM kin_retirement_holds ORDER BY kind, target_id`,
          [
            { kind: "schedule", target_id: "sch-on" },
            { kind: "trigger", target_id: "deferral:growth-call:due" },
            { kind: "trigger", target_id: "schedule:growth-weekly" },
          ],
        );
        yield* Provision.restoreOnHost(growth.agentId);
        const resumed = yield* state;
        assert.deepStrictEqual(resumed.triggers, [
          { trigger_id: "deferral:ada-call:due", enabled: 1, next_run_at: due },
          { trigger_id: "deferral:growth-call:due", enabled: 1, next_run_at: due },
          { trigger_id: "schedule:growth-weekly", enabled: 1, next_run_at: due },
        ]);
        assert.deepStrictEqual(resumed.schedules, [
          { task_id: "sch-off", pending_enabled: null },
          { task_id: "sch-on", pending_enabled: 1 },
        ]);
        assert.deepStrictEqual(yield* sql`SELECT COUNT(*) AS n FROM kin_retirement_holds`, [
          { n: 0 },
        ]);
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
          roleTags: [],
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

        // Ada is on a turn, has a reminder waiting and a task scheduled. A reminder already given
        // and a paused task are not in hand; nor is one whose fire already went out, or a task
        // she cancelled, which stops its trigger at once.
        const trigger = (triggerId: string, nextRunAt: number | null) =>
          sql`INSERT INTO kin_triggers (trigger_id, org_id, subject_json, schedule_json, time_zone, enabled, next_run_at, created_at, updated_at)
            VALUES (${triggerId}, ${orgId}, '{}', '{}', 'UTC', ${nextRunAt === null ? 0 : 1}, ${nextRunAt}, 0, 0)`;
        const { orgId } = tech;
        yield* sql`INSERT INTO kin_wakeups (wakeup_id, org_id, agent_id, model, started_at, status, event_ids)
          VALUES ('wake', ${orgId}, ${tech.agentId}, 'test', 0, 'running', '[]')`;
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
        // N3: a task it holds that waits on the owner says so, not that it is under way.
        yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
            created_at) VALUES (${orgId}, 'work', 'Work', 'W', 1, 0) ON CONFLICT DO NOTHING`;
        yield* sql`INSERT INTO kin_records (org_id, record_id, register_id, key, title, state,
            owner_kind, owner_id, waiting_on_kind, waiting_on_id, created_by_kind, origin_key,
            created_at, updated_at)
          VALUES (${orgId}, 'held', 'work', 'W-7', 'Invented: review the checklist', 'waiting',
            'agent', ${tech.agentId}, 'person', ${tech.ownerPersonId}, 'person', 'held', 0, 0)`;
        const chatId = tech.ownerChatId;
        const [ada, other] = yield* Provision.profiles(person);
        assert.deepInclude(ada, {
          working: true,
          tracking: [
            {
              kind: "work",
              title: "Invented: review the checklist",
              chatId: null,
              key: "W-7",
              state: "waiting",
              waitingOn: { _tag: "person", personId: tech.ownerPersonId },
            },
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
    "changes an agent's model and the company default, pauses and resumes it, and refuses a teammate",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const tech = (yield* Provision.create(input(owner, []))).lead;
        // A custom instance that settings name as Claude.
        const sonnet = { instanceId: ProviderInstanceId.make("work"), model: "claude-sonnet-4-6" };
        const provider = yield* decodeProvider({
          instanceId: sonnet.instanceId,
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "unknown" },
          checkedAt: "1970-01-01T00:00:00.000Z",
          models: [
            {
              slug: sonnet.model,
              name: "Invented listed model",
              isCustom: false,
              capabilities: null,
            },
          ],
        });
        const listed = Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider]) });
        const unknown = { ...sonnet, model: "invented-unlisted" };
        const create = Provision.create({
          ...input(owner, []),
          name: "Invented analyst",
          model: unknown,
        });
        assert.match(
          (yield* create.pipe(Effect.provide(listed), Effect.flip)).message,
          /invented-unlisted.*work.*Settings/,
        );
        const fromCache = yield* Effect.gen(function* () {
          const config = yield* ServerConfig;
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(
            `${config.providerStatusCacheDir}/work.json`,
            JSON.stringify(provider),
          );
          return yield* Effect.flip(create);
        }).pipe(
          Effect.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "kin-model-catalog-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
        assert.match(fromCache.message, /invented-unlisted.*work.*Settings/);
        const edit = (
          fields: Parameters<typeof Provision.update>[0]["fields"],
          editor: Provision.LeadCreator = owner,
        ) => Provision.update({ editor, orgId: tech.orgId, agentId: tech.agentId, fields });
        assert.match(
          (yield* edit({ model: unknown }).pipe(Effect.provide(listed), Effect.flip)).message,
          /invented-unlisted.*work.*Settings/,
        );
        assert.strictEqual(
          (yield* edit({ model: sonnet }).pipe(Effect.provide(listed))).model,
          sonnet.model,
        );
        // The runner reads this row at each wake-up, so the next turn runs on it.
        const [row] = yield* sql<{ model: string }>`SELECT models_json AS model FROM kin_leads
          WHERE org_id = ${tech.orgId} AND agent_id = ${tech.agentId}`;
        assert.strictEqual(JSON.parse(row!.model).model, "claude-sonnet-4-6");
        const codex = { instanceId: ProviderInstanceId.make("mine"), model: "gpt" };
        assert.strictEqual(yield* refusal(edit({ model: codex })), "not_claude");

        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
          VALUES ('teammate', ${tech.orgId}, 'teammate', 'Teammate', '2026-11-09T00:00:00.000Z')`;
        const teammate = { _tag: "person", personId: KinPersonId.make("teammate") } as const;
        assert.strictEqual(yield* refusal(edit({ model: sonnet }, teammate)), "not_owner");
        assert.strictEqual(
          yield* refusal(Provision.agentDefaults(teammate, tech.orgId)),
          "not_owner",
        );
        assert.strictEqual(
          yield* refusal(Provision.setAgentDefaults(teammate, tech.orgId, sonnet)),
          "not_owner",
        );

        // New agents start on the company default once it is chosen.
        // Until one is chosen, new agents start on the first agent's.
        assert.deepInclude(yield* Provision.agentDefaults(owner, tech.orgId), { chosen: false });
        assert.strictEqual(
          (yield* Provision.agentDefaults(owner, tech.orgId)).model?.model,
          "claude-sonnet-4-6",
        );
        yield* Provision.setAgentDefaults(owner, tech.orgId, sonnet);
        const { model: _given, ...unnamed } = input(owner, []);
        const growth = (yield* Provision.create({ ...unnamed, name: "Growth", domain: "growth" }))
          .lead;
        assert.strictEqual(growth.model.model, "claude-sonnet-4-6");

        const pause = (paused: boolean, by: Provision.LeadActor = owner) =>
          Provision.setPaused({ by, orgId: tech.orgId, agentId: tech.agentId, paused });
        assert.isDefined((yield* pause(true)).paused);
        // Paused twice is still paused, and a teammate can't touch it.
        assert.isDefined((yield* pause(true)).paused);
        assert.strictEqual(yield* refusal(pause(false, teammate)), "not_found");
        assert.isUndefined((yield* pause(false)).paused);
      }).pipe(Effect.provide(paired)),
  );
  it.effect("shows an agent's page and keeps an edited character's old version", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tech = (yield* Provision.create(input(owner, []))).lead;
      yield* seedCharacters(tech.orgId);
      const target = { by: owner, orgId: tech.orgId, agentId: tech.agentId };
      const page = yield* ownerLevelAgentPage(target);
      assert.strictEqual(page.model.model, "claude-opus-4-6");
      assert.deepStrictEqual(page.runsOn, page.model);
      assert.isNull(page.modelNote);
      assert.include(page.character?.body ?? "", "# Ada");
      // Each page lists the playbooks its area works by: code review is Ada's, not Social's.
      yield* seedPlaybooks(tech.orgId, (yield* KinIdentity).owner.personId);
      const reviewing = "Reviewing and merging code";
      const titles = (shown: KinAgentPage) => shown.playbooks.map((one) => one.title);
      assert.include(titles(yield* ownerLevelAgentPage(target)), reviewing);
      const social = (yield* Provision.create({
        ...input(owner, []),
        name: "Social",
        domain: "social",
      })).lead;
      const socialPage = yield* ownerLevelAgentPage({ ...target, agentId: social.agentId });
      assert.deepStrictEqual(titles(socialPage), ["Winning customers"]);
      // Kin's part, named for Ada; hers starts empty, and the single field still carries it all.
      const kin = page.kinCharacter ?? "";
      assert.isTrue(kin.startsWith("# Ada"));
      assert.strictEqual(page.ownCharacter, "");
      assert.strictEqual(page.character?.body, kin);
      const edited = yield* ownerLevelSetCharacter({ ...target, body: "Dry and exact." });
      assert.strictEqual(edited.ownCharacter?.trim(), "Dry and exact.");
      assert.strictEqual(edited.kinCharacter, kin);
      assert.strictEqual(edited.character?.body, `${kin}\n\nDry and exact.`);
      // An older page sends the single field back whole: Kin's part is not stored as hers.
      const again = yield* ownerLevelSetCharacter({ ...target, body: edited.character!.body });
      assert.strictEqual(again.ownCharacter, edited.ownCharacter);
      const versions = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_doc_versions v
        JOIN kin_records r ON r.org_id = v.org_id AND r.record_id = v.record_id
        WHERE r.key = ${edited.character!.key}`;
      assert.strictEqual(versions[0]!.n, 2);

      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('teammate', ${tech.orgId}, 'teammate', 'Teammate', '2026-11-09T00:00:00.000Z')`;
      const teammate = { _tag: "person", personId: KinPersonId.make("teammate") } as const;
      assert.strictEqual(
        yield* refusal(ownerLevelAgentPage({ ...target, by: teammate })),
        "not_found",
      );
      assert.strictEqual(
        yield* refusal(ownerLevelSetCharacter({ ...target, by: teammate, body: "Loud." })),
        "not_found",
      );
    }).pipe(
      Effect.provide(
        KinRecords.layer.pipe(
          Layer.provideMerge(Layer.mock(KinLevelGate)({})),
          Layer.provideMerge(KinEventQueue.layer),
          Layer.provideMerge(paired),
        ),
      ),
    ),
  );
  it.effect(
    "lets anyone message a lead unless the owner restricts them, in a chat that is that person's own",
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

        // Everyone of the company but its owner may message it, with no grant.
        const sam = KinPersonId.make("sam");
        const listed = Effect.map(Provision.access(on), (result) => ({
          everyone: result.everyone,
          people: result.people.map((row) => [row.personId, row.ownerLevel]),
        }));
        // The owner is listed as never restricted, so no phone offers to add him.
        const open = [
          [finance.ownerPersonId, true],
          [priyaId, false],
          [sam, false],
        ];
        assert.deepStrictEqual(yield* listed, { everyone: false, people: open });
        // The team agent is everyone's, and its list says so.
        yield* sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
          VALUES (${finance.orgId}, ${finance.agentId}, ${finance.ownerPersonId}, 0)`;
        assert.deepStrictEqual(yield* listed, { everyone: true, people: open });
        // With someone restricted from it, older phones get the list: who can, and who to add back.
        yield* Provision.disallow({ ...on, personId: sam });
        assert.deepStrictEqual(yield* listed, { everyone: false, people: open.slice(0, 2) });
        yield* Provision.allow({ ...on, personId: sam });
        yield* sql`DELETE FROM kin_team_agents`;
        // Every live agent she may message is hers to start, with no chat yet.
        const startable = (personId: KinPersonId) =>
          Effect.map(
            Provision.messageable({ _tag: "person", orgId: finance.orgId, personId }),
            (rows) => rows.map((row) => row.agentId),
          );
        assert.sameDeepMembers(
          [...(yield* Provision.messageable(priya))],
          [
            { ...finance, name: "Finance" },
            { ...tech, name: tech.name },
          ].map(({ orgId, agentId, name }) => ({
            orgId,
            agentId,
            name,
            intro: "",
            ownerName: "Owner",
          })),
        );
        yield* Provision.disallow({ ...on, personId: sam });
        assert.deepStrictEqual(yield* startable(sam), [tech.agentId]);
        yield* Provision.allow({ ...on, personId: sam });
        yield* sql`UPDATE kin_agents SET retired_at = '2026-11-10T00:00:00.000Z' WHERE agent_id = ${tech.agentId}`;
        assert.deepStrictEqual(yield* startable(priyaId), [finance.agentId]);
        assert.include(yield* chats.createDirect(priya, tech).pipe(Effect.flip), {
          reason: "not_allowed",
        });
        yield* sql`UPDATE kin_agents SET retired_at = NULL WHERE agent_id = ${tech.agentId}`;
        // Her chat with it is there once she starts it.
        assert.deepStrictEqual(yield* Provision.contacts(priya), []);
        yield* chats.createDirect(priya, finance);
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
        // Letting her when nothing restricts her, or her asking again, gives the same chat.
        const before = yield* counts;
        yield* Provision.allow(her);
        assert.strictEqual((yield* chats.createDirect(priya, finance)).chatId, contact.chatId);
        assert.deepStrictEqual(yield* counts, before);
        // Any other lead is hers to message too.
        yield* chats.createDirect(priya, tech);

        yield* Provision.update({ ...on, fields: { intro: " Handles invoices. " } });
        assert.strictEqual(
          (yield* Provision.contacts(priya)).find((lead) => lead.agentId === finance.agentId)
            ?.intro,
          "Handles invoices.",
        );
        assert.strictEqual(
          (yield* Provision.profiles((yield* KinIdentity).owner)).find(
            (lead) => lead.agentId === finance.agentId,
          )?.intro,
          "Handles invoices.",
        );

        // Only the owner, and only for a live lead of theirs and a person of the org.
        const teammate = { _tag: "person", personId: priyaId } as const;
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

        // Restricted before she wrote anything: the chat leaves her list, both ways. Sam owns
        // an agent now, so he is owner-level and listed as never restricted.
        assert.deepStrictEqual(yield* listed, {
          everyone: false,
          people: [open[0], [priyaId, false], [sam, true]],
        });
        assert.deepStrictEqual(
          (yield* Provision.disallow(her)).people.map((row) => row.personId),
          [finance.ownerPersonId, sam],
        );
        assert.isTrue(
          (yield* Provision.contacts(priya)).every((one) => one.agentId !== finance.agentId),
        );
        assert.isNotNull((yield* member(contact.chatId))?.leftAt);
        assert.include(yield* chats.createDirect(priya, finance).pipe(Effect.flip), {
          reason: "not_allowed",
        });
        // Lifted: the same chat, hers to write in.
        yield* Provision.allow(her);
        assert.strictEqual(
          (yield* Provision.contacts(priya)).find((one) => one.agentId === finance.agentId)?.chatId,
          contact.chatId,
        );
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
        // Restricted after she wrote: what waited is dropped, and the chat is hers to read only.
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
        assert.isTrue(
          (yield* Provision.contacts(priya)).every((one) => one.agentId !== finance.agentId),
        );
        yield* Provision.allow(her);
        assert.include(yield* member(contact.chatId), { role: "member", leftAt: null });
        yield* say("three");

        const queue = (id: string) =>
          sql`INSERT INTO kin_events (event_id, org_id, agent_id, tag, priority, json, dedupe_key, received_at, queued_at)
            VALUES (${id}, ${finance.orgId}, ${finance.agentId}, 'chat.message', 'P1',
              ${JSON.stringify({ chatId: contact.chatId })}, ${id}, 0, 0)`;
        // A co-owner is never restricted: refused, and nothing is dropped or closed.
        yield* sql`UPDATE kin_people SET access = 'co_owner' WHERE person_id = ${priyaId}`;
        assert.deepStrictEqual(
          (yield* Provision.access(on)).people.map((row) => [row.personId, row.ownerLevel]),
          [open[0], [priyaId, true], [sam, true]],
        );
        yield* queue("co-owner-waits");
        assert.strictEqual(yield* refusal(Provision.disallow(her)), "conflict");
        assert.include(yield* member(contact.chatId), { role: "member", leftAt: null });
        assert.deepStrictEqual(
          yield* sql`SELECT state FROM kin_events WHERE event_id = 'co-owner-waits'`,
          [{ state: "queued" }],
        );
        yield* say("as-co-owner");
        // The team agent is restricted like any other: the restriction is the owner's word.
        yield* sql`UPDATE kin_people SET access = 'member' WHERE person_id = ${priyaId}`;
        yield* sql`INSERT INTO kin_team_agents (org_id, agent_id, set_by, set_at)
          VALUES (${finance.orgId}, ${finance.agentId}, ${finance.ownerPersonId}, 0)`;
        yield* Provision.disallow(her);
        assert.include(yield* member(contact.chatId), { role: "guest", leftAt: null });
        assert.include(yield* say("restricted").pipe(Effect.flip), { reason: "not_allowed" });
        // Settings' list: the pair that binds, and only she may still be restricted.
        const reach = yield* Provision.reachList({ editor: owner, orgId: finance.orgId });
        assert.deepStrictEqual(reach.restrictable, [priyaId]);
        assert.deepStrictEqual(
          reach.limits.map(({ one, other }) => [one, other]),
          [
            [
              { kind: "agent", agentId: finance.agentId },
              { kind: "person", personId: priyaId },
            ],
          ],
        );
        yield* sql`UPDATE kin_people SET access = 'co_owner' WHERE person_id = ${priyaId}`;
        assert.deepStrictEqual(
          yield* Provision.reachList({ editor: owner, orgId: finance.orgId }),
          {
            limits: [],
            restrictable: [],
          },
        );
      }).pipe(Effect.provide(paired)),
  );

  it.effect(
    "retiring an agent closes its questions with the reason; restoring reopens only those",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ada = (yield* Provision.create(input(owner, []))).lead;
        const finance = (yield* Provision.create({
          ...input(owner, []),
          name: "Finance",
          domain: "finance",
        })).lead;
        const { orgId } = finance;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES ('meera', ${orgId}, 'meera', 'Meera', '2026-11-09T00:00:00.000Z')`;
        const ask = (id: string, agentId: KinAgentId, state: string, closedAt: number | null) =>
          sql`INSERT INTO kin_questions (question_id, org_id, agent_id, person_id, chat_id, kind,
            question, safe, asked_at, due_at, act_at, state, closed_at)
          VALUES (${id}, ${orgId}, ${agentId}, 'meera', ${finance.ownerChatId}, 'text',
            'Invented?', 0, 0, 1000, 1000, ${state}, ${closedAt})`;
        yield* ask("q-open", finance.agentId, "open", null);
        yield* ask("q-answered", finance.agentId, "answered", 500);
        yield* ask("q-withdrawn", finance.agentId, "withdrawn", 600);
        yield* ask("q-ada", ada.agentId, "open", null);
        const states = sql<{ id: string; state: string; due: number }>`SELECT question_id AS id,
          state, due_at AS due FROM kin_questions ORDER BY question_id`;

        yield* TestClock.adjust("1 minute");
        yield* Provision.retireOnHost(finance.agentId);
        assert.deepStrictEqual(
          (yield* states).map((row) => [row.id, row.state]),
          [
            ["q-ada", "open"],
            ["q-answered", "answered"],
            ["q-open", "withdrawn"],
            ["q-withdrawn", "withdrawn"],
          ],
        );
        yield* TestClock.adjust("1 day");
        yield* Provision.restoreOnHost(finance.agentId);
        const after = yield* states;
        assert.deepStrictEqual(
          after.map((row) => [row.id, row.state]),
          [
            ["q-ada", "open"],
            ["q-answered", "answered"],
            ["q-open", "open"],
            ["q-withdrawn", "withdrawn"],
          ],
        );
        // Reopened with a fresh day: nothing is taken or raised before the person has one.
        assert.isAbove(
          after.find((row) => row.id === "q-open")!.due,
          yield* Clock.currentTimeMillis,
        );
      }).pipe(Effect.provide(paired)),
  );

  const teamOf = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const ada = (yield* Provision.create(input(owner, []))).lead;
    const chief = (yield* Provision.create({
      ...input(owner, []),
      name: "Chief of staff",
      domain: "operations",
    })).lead;
    const { orgId } = chief;
    // Dev, a member signed in on a phone, talks to the team agent.
    yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
      VALUES ('dev', ${orgId}, 'dev', 'Dev', '2026-11-09T00:00:00.000Z', 'member')`;
    yield* sql`INSERT INTO kin_session_bindings (session_id, org_id, person_id, bound_at)
      VALUES ('dev-phone', ${orgId}, 'dev', 0)`;
    yield* Provision.setTeamAgent({ editor: owner, orgId, agentId: chief.agentId });
    const dev = { _tag: "person" as const, orgId, personId: KinPersonId.make("dev") };
    const contacts = Provision.contacts(dev).pipe(
      Effect.map((rows) => rows.map((row) => row.name)),
    );
    assert.deepStrictEqual(yield* contacts, ["Chief of staff"]);
    return { sql, ada, chief, orgId, contacts };
  });

  it.effect("retiring the team agent without naming the next is refused", () =>
    Effect.gen(function* () {
      const { sql, chief, ada, orgId, contacts } = yield* teamOf;
      // Switching to an agent restricted from Dev goes on: no chat is opened for him.
      yield* Provision.reachSet({
        editor: owner,
        orgId,
        a: { kind: "person", personId: KinPersonId.make("dev") },
        b: { kind: "agent", agentId: ada.agentId },
        restricted: true,
      });
      const chatsOfDev = sql`SELECT c.chat_id FROM kin_chats c
        JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
          AND m.person_id = 'dev' AND m.left_at IS NULL
        ORDER BY c.chat_id`;
      const before = yield* chatsOfDev;
      yield* Provision.setTeamAgent({ editor: owner, orgId, agentId: ada.agentId });
      assert.strictEqual(yield* Provision.teamAgent(orgId), ada.agentId);
      assert.deepStrictEqual(yield* chatsOfDev, before);
      yield* Provision.setTeamAgent({ editor: owner, orgId, agentId: chief.agentId });
      assert.strictEqual(yield* refusal(Provision.retireOnHost(chief.agentId)), "conflict");
      assert.strictEqual(
        yield* refusal(
          Provision.retire({
            by: owner,
            orgId,
            agentId: chief.agentId,
            nextTeamAgentId: chief.agentId,
          }),
        ),
        "not_found",
      );
      // Another agent retires as before.
      yield* Provision.retireOnHost(ada.agentId);
      assert.deepStrictEqual(yield* contacts, ["Chief of staff"]);
      assert.strictEqual((yield* Provision.teamAgent(orgId)) ?? "", chief.agentId);
    }).pipe(Effect.provide(paired)),
  );

  it.effect("with the next named, teammates' chats point at it", () =>
    Effect.gen(function* () {
      const { sql, chief, ada, orgId, contacts } = yield* teamOf;
      const retired = yield* Provision.retire({
        by: owner,
        orgId,
        agentId: chief.agentId,
        nextTeamAgentId: ada.agentId,
      });
      assert.strictEqual(retired._tag, "retired");
      assert.strictEqual(yield* Provision.teamAgent(orgId), ada.agentId);
      assert.deepStrictEqual(yield* contacts, ["Ada"]);
      // Switching closes no one's chat: the retired agent only leaves the list.
      assert.deepStrictEqual(
        yield* sql`SELECT m.left_at IS NOT NULL AS gone FROM kin_chats c
          JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
            AND m.person_id = 'dev'
          WHERE c.direct_key = ${`dev:${chief.agentId}`}`,
        [{ gone: 0 }],
      );
    }).pipe(Effect.provide(paired)),
  );
});
