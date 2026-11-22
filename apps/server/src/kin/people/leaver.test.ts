import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { kinSecretsTest } from "../lead/layer.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KinAgentId,
  KinChatError,
  KinPersonId,
  KinWidgetId,
  KIN_LEFT_FIELD,
  ProviderInstanceId,
  ThreadId,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { SessionStore } from "../../auth/SessionStore.ts";
import { KinChatService } from "../chat/KinChatService.ts";
import { KinIdentity, type PersonIdentity } from "../chat/KinIdentity.ts";
import { environment } from "../chat/TaskCard.testkit.ts";
import { authorityLayer } from "../chat/WakeupAuthority.testkit.ts";
import * as Kin from "../layer.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import type { Services } from "../KinServer.ts";
import * as Deals from "../work/deals.ts";
import { KinRecords } from "../work/KinRecords.ts";
import * as Clients from "../work/ownerClients.ts";
import * as People from "./KinPeople.ts";

// Invented: Rhea's Ambermill. Zoya sells and leaves; Arjun sells too; Meera is a co-owner; Dev
// delivers with Clients off and holds no client.
const at = "1970-01-01T00:00:00.000Z";
const chief = KinAgentId.make("chief");
const models = JSON.stringify({
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
});
const ownerSession = {
  sessionId: AuthSessionId.make("owner"),
  subject: "browser",
  method: "browser-session-cookie" as const,
  scopes: AuthStandardClientScopes,
};
const isChatError = Schema.is(KinChatError);
const zoyaId = KinPersonId.make("zoya");
const arjunId = KinPersonId.make("arjun");
const meeraId = KinPersonId.make("meera");
const devId = KinPersonId.make("dev");
const HELD = "1 open deal, 1 prospect, 1 client, 1 follow-up and 1 promise";

const seed = Effect.fn("LeaverTest.seed")(function* (services: Context.Context<Services>) {
  const identity = Context.get(services, KinIdentity);
  const chats = Context.get(services, KinChatService);
  const records = Context.get(services, KinRecords);
  const sql = yield* SqlClient.SqlClient;
  yield* pairSession(ownerSession.sessionId);
  const owner = (yield* identity.resolve(ownerSession))[0]!;
  const { orgId } = owner;
  yield* sql`INSERT INTO kin_agents (agent_id, org_id, display_name, role, owner_person_id, created_at)
    VALUES (${chief}, ${orgId}, 'Chief of staff', 'lead', ${owner.personId}, ${at})`;
  const ownerChat = yield* chats.createDirect(owner, { orgId, agentId: chief });
  const threadId = ThreadId.make("chief-thread");
  yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, thread_id, models_json, worker_projects_json, owner_chat_id, domain, charter)
    VALUES (${chief}, ${orgId}, 'Chief of staff', 'L0', 0, ${threadId}, ${models}, '[]',
      ${ownerChat.chatId}, 'chief-of-staff', 'Runs the company.')`;
  yield* identity.registerAgentThread({ orgId, agentId: chief, threadId });
  yield* sql`UPDATE kin_people SET display_name = 'Rhea' WHERE person_id = ${owner.personId}`;
  yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access,
      sees_clients) VALUES (${zoyaId}, ${orgId}, 'zoya', 'Zoya', ${at}, 'member', 1),
      (${arjunId}, ${orgId}, 'arjun', 'Arjun', ${at}, 'member', 1),
      (${meeraId}, ${orgId}, 'meera', 'Meera', ${at}, 'co_owner', 1),
      (${devId}, ${orgId}, 'dev', 'Dev', ${at}, 'member', 0)`;
  yield* sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by, granted_at, revoked_at)
    VALUES (${orgId}, ${chief}, ${arjunId}, ${owner.personId}, 0, NULL)`;
  // Kin's own sessions only: a link accepted signs a phone in, a removal signs it out.
  let issued = 0;
  const sessions = {
    issue: () =>
      Effect.sync(() => {
        issued += 1;
        return {
          sessionId: AuthSessionId.make(`phone-${issued}`),
          token: `token-${issued}`,
          expiresAt: DateTime.makeUnsafe(Date.UTC(2027, 0, 1)),
        };
      }),
    revoke: () => Effect.succeed(true),
  } as never;
  const people = yield* People.make.pipe(
    Effect.provideContext(services),
    Effect.provideService(SessionStore, sessions),
  );
  const person = (personId: KinPersonId): PersonIdentity => ({ _tag: "person", orgId, personId });
  const zoya: KinWorkPrincipal = { _tag: "person", personId: zoyaId };
  const byOwner = {
    actor: { _tag: "person" as const, personId: owner.personId },
    via: "owner" as const,
  };
  // Zoya looks after a prospect, a client and a deal, a follow-up and a promise; Dev a plain task.
  const party = (name: string, prospect: boolean) =>
    Clients.createParty([owner], {
      orgId,
      name,
      clientRequestId: name,
      ...(prospect ? { prospect: true } : {}),
    }).pipe(Effect.map((made) => made.key));
  const tallmoor = yield* party("Invented Tallmoor Logistics", true);
  const brightwater = yield* party("Invented Brightwater", false);
  for (const key of [tallmoor, brightwater])
    yield* records.update(orgId, byOwner, key, { owner: zoya });
  const deal = (yield* Deals.create([owner], {
    orgId,
    party: brightwater,
    title: "Invented stock system",
    clientRequestId: "deal",
    owner: zoya,
  })).deal.key;
  const partyId = (yield* records.get(orgId, brightwater))!.recordId;
  const task = (title: string, owner: KinWorkPrincipal, extra: object) =>
    records
      .create(orgId, byOwner, { title, owner, originKey: title, ...extra })
      .pipe(Effect.map((made) => made.row.key));
  const followUp = yield* task("Invented: call Brightwater back", zoya, { partyId });
  const promise = yield* task("Invented: send the revised quote", zoya, { category: "obligation" });
  yield* task("Invented: fix the booking page", { _tag: "person", personId: devId }, {});
  // 10:00 on everyone's own clock, whatever zone the tests run in: a notice is posted, not held.
  yield* sql`UPDATE kin_people SET time_zone = 'UTC' WHERE org_id = ${orgId}`;
  yield* TestClock.setTime(10 * 60 * 60 * 1000);
  return {
    services,
    sql,
    orgId,
    owner,
    chats,
    records,
    people,
    person,
    ownerChat: ownerChat.chatId,
    keys: [tallmoor, brightwater, deal, followUp, promise],
    deal,
  };
});
const setup = Effect.gen(function* () {
  const services = Option.getOrThrow((yield* Kin.KinServer).services);
  return yield* seed(services).pipe(Effect.provideContext(services));
});
type Ctx = Effect.Success<typeof setup>;

const run = <A, E>(test: (ctx: Ctx) => Effect.Effect<A, E, SqlClient.SqlClient | Services>) =>
  Effect.gen(function* () {
    const ctx = yield* setup;
    return yield* test(ctx).pipe(Effect.provideContext(ctx.services));
  }).pipe(
    Effect.provide(
      Kin.layer.pipe(
        Layer.provide(kinSecretsTest),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ KIN_ENABLED: true }))),
        Layer.provideMerge(environment),
        Layer.provideMerge(authorityLayer),
      ),
    ),
  );

type Card = {
  readonly widgetId: KinWidgetId;
  readonly chatId: string;
  readonly closed: boolean;
  readonly question: string;
  readonly whileOpen: string | undefined;
  readonly labels: ReadonlyArray<string>;
  readonly outcome: { readonly title: string; readonly text: string } | undefined;
};
/** Kin's leaver cards, with whose chat each is in. */
const cards = (ctx: Ctx) =>
  ctx.sql<{ widgetId: string; chatId: string; closedAt: string | null; state: string }>`SELECT
      DISTINCT w.widget_id AS "widgetId", w.chat_id AS "chatId", w.closed_at AS "closedAt",
      w.state_json AS state
    FROM kin_card_plans p JOIN kin_widgets w ON w.org_id = p.org_id AND w.widget_id = p.widget_id
    WHERE p.org_id = ${ctx.orgId} AND json_extract(p.plan_json, '$.kind') = 'leaver'
    ORDER BY w.updated_at, w.widget_id`.pipe(
    Effect.map((rows) =>
      rows.map((row): Card => {
        const state = JSON.parse(row.state) as {
          question: string;
          whileOpen?: string;
          options: ReadonlyArray<{ label: string }>;
          outcome?: { title: string; text: string };
        };
        return {
          widgetId: KinWidgetId.make(row.widgetId),
          chatId: row.chatId,
          closed: row.closedAt !== null,
          question: state.question,
          whileOpen: state.whileOpen,
          labels: state.options.map((option) => option.label),
          outcome: state.outcome,
        };
      }),
    ),
  );
/** The chat each owner-level person reads it in: Rhea's with the lead, Meera's own with it. */
const chatOf = (ctx: Ctx, personId: KinPersonId) =>
  personId === ctx.owner.personId
    ? Effect.succeed(ctx.ownerChat as string)
    : ctx.sql<{ chatId: string }>`SELECT c.chat_id AS "chatId" FROM kin_chats c
        JOIN kin_chat_members m ON m.org_id = c.org_id AND m.chat_id = c.chat_id
          AND m.person_id = ${personId}
        WHERE c.org_id = ${ctx.orgId} AND c.kind = 'direct' ORDER BY c.chat_id LIMIT 1`.pipe(
        Effect.map((rows) => rows[0]?.chatId ?? "none"),
      );
const tap = (ctx: Ctx, personId: KinPersonId, card: Card, label: string) =>
  ctx.chats.act(ctx.person(personId), {
    widgetId: card.widgetId,
    revision: 1,
    actionId: "choose",
    value: `option-${card.labels.indexOf(label) + 1}`,
    clientActionId: `${card.widgetId}:${personId}:${label}`,
  });
const refusal = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => (isChatError(error) ? error.message : "not a refusal")),
  );
const holders = (ctx: Ctx) =>
  Effect.forEach(ctx.keys, (key) =>
    ctx.records.get(ctx.orgId, key).pipe(Effect.map((row) => row?.ownerId)),
  );
const bringBack = (ctx: Ctx, displayName: string, personId: KinPersonId) =>
  Effect.gen(function* () {
    const link = yield* ctx.people.createInvite(ownerSession, {
      orgId: ctx.orgId,
      displayName,
      personId,
    });
    yield* ctx.people.accept({ secret: link.secret });
  });
/** What a record's Activity carries, newest first: who, and the fields each change named. */
const activity = (ctx: Ctx, key: string) =>
  ctx.sql<{ actor: string; fields: string }>`SELECT c.actor_id AS actor, c.fields_json AS fields
    FROM kin_record_changes c JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
    WHERE r.org_id = ${ctx.orgId} AND r.key = ${key} ORDER BY c.seq DESC`.pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        actor: row.actor,
        fields: (JSON.parse(row.fields) as ReadonlyArray<{ field: string }>).map((f) => f.field),
      })),
    ),
  );

it.effect(
  "a leaver's card: once per removal for the owner and each co-owner, none for someone who held nothing; a co-owner gives it all and the owner's copy closes; the receiver is told once and keeps it when they come back",
  () =>
    run((ctx) =>
      Effect.gen(function* () {
        // Dev holds only a plain task: removing Dev asks nothing, as before.
        yield* ctx.people.removeAccess(ownerSession, { orgId: ctx.orgId, personId: devId });
        assert.deepStrictEqual(yield* cards(ctx), []);

        yield* ctx.people.removeAccess(ownerSession, { orgId: ctx.orgId, personId: zoyaId });
        // A retried removal asks nothing more.
        yield* ctx.people.removeAccess(ownerSession, { orgId: ctx.orgId, personId: zoyaId });
        const asked = yield* cards(ctx);
        assert.deepStrictEqual(
          asked.map((card) => card.chatId).toSorted(),
          [yield* chatOf(ctx, ctx.owner.personId), yield* chatOf(ctx, meeraId)].toSorted(),
        );
        for (const card of asked) {
          assert.strictEqual(
            card.question,
            `Zoya left the team and looked after ${HELD}. Who takes them?`,
          );
          // Shown only while nobody has chosen, on every copy.
          assert.strictEqual(
            card.whileOpen,
            "Until someone chooses, they stay in Zoya's name and can still be found.",
          );
          // Dev has Clients off: never offered.
          assert.deepStrictEqual(card.labels, [
            "Give them to Arjun",
            "Give them to Meera",
            "Give them to Rhea",
            "Leave them as they are",
          ]);
        }
        const meeras = asked.find((card) => card.chatId !== ctx.ownerChat)!;
        const rheas = asked.find((card) => card.chatId === ctx.ownerChat)!;
        // Arjun can't answer it: it isn't in a chat of his.
        assert.isTrue(
          (yield* tap(ctx, arjunId, rheas, "Give them to Arjun").pipe(Effect.result))._tag ===
            "Failure",
        );

        yield* tap(ctx, meeraId, meeras, "Give them to Arjun");
        assert.deepStrictEqual(
          yield* holders(ctx),
          ctx.keys.map(() => arjunId),
        );
        const after = "To move one on, change who looks after it on its page.";
        const settled = yield* cards(ctx);
        assert.deepStrictEqual(settled.find((card) => card.widgetId === meeras.widgetId)?.outcome, {
          title: "Given to Arjun",
          text: `Arjun now looks after ${HELD} that Zoya looked after, and was told. ${after}`,
        });
        const closed = settled.find((card) => card.widgetId === rheas.widgetId)!;
        assert.isTrue(closed.closed);
        assert.deepStrictEqual(closed.outcome, {
          title: "Given to Arjun",
          text: `Meera gave Arjun ${HELD} that Zoya looked after. ${after}`,
        });
        // Answered once for all: Rhea's copy takes no tap.
        assert.isTrue(
          (yield* tap(ctx, ctx.owner.personId, rheas, "Leave them as they are").pipe(Effect.result))
            ._tag === "Failure",
        );
        assert.deepStrictEqual(
          yield* holders(ctx),
          ctx.keys.map(() => arjunId),
        );
        const told = yield* ctx.sql<{ body: string }>`SELECT m.body FROM kin_messages m
          JOIN kin_chat_members cm ON cm.org_id = m.org_id AND cm.chat_id = m.chat_id
            AND cm.person_id = ${arjunId}
          WHERE m.org_id = ${ctx.orgId} AND m.message_id LIKE 'kin-holder-%' ORDER BY m.seq`;
        assert.deepStrictEqual(
          told.map((row) => row.body),
          [`Meera gave you what Zoya looked after: ${HELD}. Each one's Activity says so.`],
        );
        const given = (yield* activity(ctx, ctx.deal))[0]!;
        assert.strictEqual(given.actor, meeraId);
        assert.includeMembers([...given.fields], ["owner", KIN_LEFT_FIELD]);

        // Zoya comes back with a new link: what was given stays with Arjun.
        yield* bringBack(ctx, "Zoya", zoyaId);
        assert.deepStrictEqual(
          yield* holders(ctx),
          ctx.keys.map(() => arjunId),
        );
        assert.deepStrictEqual((yield* activity(ctx, ctx.deal))[0], given);
      }),
    ),
);

it.effect(
  "leaving them as they are moves nothing and comes back with the leaver; a teammate and someone with Clients off are refused; coming back closes an unanswered card",
  () =>
    run((ctx) =>
      Effect.gen(function* () {
        yield* ctx.people.removeAccess(ownerSession, { orgId: ctx.orgId, personId: zoyaId });
        const [rheas, meeras] = yield* cards(ctx).pipe(
          Effect.map((all) => all.toSorted((a) => (a.chatId === ctx.ownerChat ? -1 : 1))),
        );
        // Arjun's Clients went off after the card was drawn: Rhea's tap is refused, nothing moves.
        yield* ctx.people.setPlaces(ownerSession, {
          orgId: ctx.orgId,
          personId: arjunId,
          clients: false,
        });
        assert.strictEqual(
          yield* refusal(tap(ctx, ctx.owner.personId, rheas!, "Give them to Arjun")),
          "Arjun can't take them: Clients is off for Arjun. Give them to the owner, a co-owner or someone with Clients on.",
        );
        // Meera is a member now, still let message the Chief of staff: her copy is no longer hers
        // to answer.
        yield* ctx.sql`INSERT INTO kin_lead_access (org_id, agent_id, person_id, granted_by,
            granted_at, revoked_at)
          VALUES (${ctx.orgId}, ${chief}, ${meeraId}, ${ctx.owner.personId}, 0, NULL)`;
        yield* ctx.people.setAccess(ownerSession, {
          orgId: ctx.orgId,
          personId: meeraId,
          access: "member",
        });
        assert.strictEqual(
          yield* refusal(tap(ctx, meeraId, meeras!, "Give them to Meera")),
          "Only the owner or a co-owner gives away what someone who left looked after.",
        );
        assert.deepStrictEqual(
          yield* holders(ctx),
          ctx.keys.map(() => zoyaId),
        );

        yield* tap(ctx, ctx.owner.personId, rheas!, "Leave them as they are");
        const text = `${HELD} stay in Zoya's name. If Zoya comes back with a new link, they are Zoya's again.`;
        const settled = yield* cards(ctx);
        assert.deepStrictEqual(
          [rheas!, meeras!].map((one) => {
            const card = settled.find((each) => each.widgetId === one.widgetId)!;
            return [card.closed, card.outcome];
          }),
          [
            [true, { title: "Left as they are", text }],
            [true, { title: "Left as they are", text: `Rhea left them as they are. ${text}` }],
          ],
        );
        assert.deepStrictEqual(
          yield* holders(ctx),
          ctx.keys.map(() => zoyaId),
        );

        // Back with a new link, they are hers again; each says she left and came back.
        yield* bringBack(ctx, "Zoya", zoyaId);
        assert.deepStrictEqual(
          yield* holders(ctx),
          ctx.keys.map(() => zoyaId),
        );
        for (const key of ctx.keys) {
          const [back, gone] = yield* activity(ctx, key);
          assert.deepStrictEqual(
            [back, gone],
            [
              { actor: zoyaId, fields: ["accessBack"] },
              { actor: ctx.owner.personId, fields: ["accessRemoved"] },
            ],
          );
        }

        // Removed again, a new card; back before anyone answers, it closes and says why.
        yield* TestClock.adjust("1 hour");
        yield* ctx.people.removeAccess(ownerSession, { orgId: ctx.orgId, personId: zoyaId });
        const again = (yield* cards(ctx)).slice(2);
        assert.deepStrictEqual(
          again.map((card) => [card.chatId, card.closed]),
          [[ctx.ownerChat, false]],
        );
        yield* bringBack(ctx, "Zoya", zoyaId);
        assert.deepStrictEqual((yield* cards(ctx)).slice(2)[0]?.outcome, {
          title: "Back on the team",
          text: "Zoya came back, so what Zoya looked after is Zoya's again.",
        });
      }),
    ),
);

// Every column that holds a person or an agent, as last reviewed. A new one fails here until
// someone decides what removing the person (`KinPeople.removeAccess`) and retiring the agent
// (`lead/Retirement.ts`) do to it, tests that, and lists it.
const HOLDS_SOMEONE: Record<string, string> = {
  kin_agent_threads: "agent_id",
  kin_agents: "agent_id owner_person_id retired_by_person_id",
  kin_bank_statements: "agent_id applied_by",
  kin_chat_levels: "agent_id",
  kin_chat_members: "agent_id member_id person_id",
  kin_chats: "lead_agent_id",
  kin_client_touches: "logged_by_id person_id",
  kin_company_profile: "updated_by_id",
  kin_connection_asks: "agent_id decided_by",
  kin_connection_calls: "agent_id",
  // A person's own mailbox: removing them removes it and stales its asks (`KinPeople.test.ts`).
  kin_connections: "person_id",
  kin_discussions: "ask_agent_id decider_agent_id opened_by_agent_id",
  kin_doc_jobs: "agent_id answered_author_id asked_by_person_id",
  kin_doc_versions: "actor_id answered_author_id",
  kin_events: "agent_id",
  kin_floor_grants: "agent_id",
  kin_floor_notices: "agent_id",
  kin_floor_runs: "opened_by",
  kin_github_handled: "agent_id",
  kin_handoffs: "from_agent_id to_agent_id",
  kin_held_posts: "agent_id person_id",
  kin_holds: "for_person_id lifted_by_id set_by_id",
  kin_import_runs: "person_id",
  kin_issued_numbers: "issued_by_id",
  kin_lead_access: "agent_id granted_by person_id",
  kin_lead_deliveries: "agent_id",
  kin_leads: "agent_id created_by_person_id",
  kin_list_proposals: "agent_id",
  kin_memory_shared_writes: "person_id",
  kin_messages: "author_agent_id author_member_id author_owner_person_id author_person_id sent_by",
  kin_money_budgets: "set_by_id",
  kin_org_state: "paused_by",
  kin_pending_actions: "requested_by_agent_id",
  kin_people: "person_id",
  kin_people_invites: "made_by_person_id person_id sees_by_person_id",
  kin_ping_deliveries: "person",
  kin_ping_items: "person",
  kin_ping_ledger: "person",
  kin_pr_review_posts: "agent_id",
  kin_profile_changes: "agent_id",
  kin_pull_requests: "author",
  kin_pulse_facts: "handled_by_id",
  kin_pulse_nudges: "agent_id person_id",
  kin_pulse_told: "person_id",
  kin_push_devices: "person_id",
  kin_push_rings: "person_id",
  kin_questions: "agent_id for_person_id person_id",
  kin_reach_limits: "lifted_by_person_id one_id other_id set_by_person_id",
  kin_reactions: "member_id",
  kin_read_state: "member_id",
  kin_receipt_proposals: "agent_id",
  kin_recipe_defaults: "set_by_person_id",
  kin_recipe_labels: "cleared_by_person_id",
  kin_recommendations: "decided_by",
  kin_record_changes: "actor_id asked_by_person_id",
  kin_record_comments: "asked_by_person_id author_id removed_by_id",
  kin_record_cursors: "agent_id",
  kin_record_payments: "created_by_id",
  kin_records:
    "asked_by_person_id assigned_by_agent_id assigned_by_person_id created_by_id handed_back_id marked_by_person_id notes_by owner_id title_by waiting_on_id",
  kin_retirement_holds: "agent_id",
  kin_schedules: "agent_id said_by",
  kin_session_bindings: "person_id",
  kin_shadow_entries: "agent_id",
  kin_social_posts: "agent_id confirmed_by",
  kin_tasks_keys: "person_id",
  kin_team_agents: "agent_id set_by",
  kin_team_memory: "set_by",
  kin_team_seqs: "person_id",
  kin_turn_figures: "agent_id",
  kin_visual_hosts: "added_by",
  kin_waiting: "person_id",
  kin_wakeups: "agent_id",
  kin_worker_attempts: "agent_id approved_by declined_by",
  kin_worker_network: "changed_by",
  kin_workers: "agent_id",
};
const holdsSomeone = (column: string, columns: ReadonlyArray<string>) =>
  /(?:^|_)(?:person|agent|member|author|actor|holder|asker|decider|principal)(?:_id)?$|_by(?:_person_id|_agent_id|_id)?$/.test(
    column,
  ) ||
  (column.endsWith("_id") && columns.includes(column.replace(/_id$/, "_kind")));

it.effect("lists every column that holds a person or an agent, so leaving covers new ones", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{ name: string }>`SELECT name FROM sqlite_master
      WHERE type = 'table' AND substr(name, 1, 4) = 'kin_' ORDER BY name`;
    const found: Record<string, string> = {};
    for (const { name } of tables) {
      const columns = (yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${name})
        ORDER BY name`).map((one) => one.name);
      const held = columns.filter((column) => holdsSomeone(column, columns));
      if (held.length > 0) found[name] = held.join(" ");
    }
    assert.deepStrictEqual(found, HOLDS_SOMEONE);
  }).pipe(
    Effect.provide(
      KinPersistence.layer.pipe(
        Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
      ),
    ),
  ),
);
