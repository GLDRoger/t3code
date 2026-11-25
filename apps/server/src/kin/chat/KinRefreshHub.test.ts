// @effect-diagnostics nodeBuiltinImport:off -- the guard reads source files synchronously, outside any Effect.
import { assert, describe, it } from "@effect/vitest";
import {
  KIN_STREAMS,
  AuthSessionId,
  AuthStandardClientScopes,
  KinConnectionId,
  KinOrgId,
  KinPersonId,
  ProviderInstanceId,
  type KinMyMailbox,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { pairSession } from "../auth/ProofKeySessions.testkit.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as RetiredActions from "../approvals/retiredActions.ts";
import { KinConnections } from "../connections/ConnectionsService.ts";
import * as KinEventQueue from "../lead/KinEventQueue.ts";
import * as Provision from "../lead/KinLeadProvision.ts";
import * as KinShell from "../shell/KinShell.ts";
import * as KinRecords from "../work/KinRecords.ts";
import * as Money from "../work/ownerMoney.ts";
import { defineList, proposalFor } from "../work/registers.ts";
import * as WorkStream from "../work/workStream.ts";
import { newCompanyProfileJson, setProfile } from "../work/companyProfile.ts";
import { KinIdentity } from "./KinIdentity.ts";
import * as RefreshHub from "./KinRefreshHub.ts";
import { announceRefreshes, subscribeRefreshes } from "./refreshes.ts";

const layer = Layer.mergeAll(Provision.layer, RetiredActions.hostLayer).pipe(
  Layer.provideMerge(RefreshHub.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(ServerSettings.layerTest({})),
);
const paired = Layer.effectDiscard(pairSession("phone")).pipe(Layer.provideMerge(layer));
const withRecords = KinRecords.layer.pipe(
  Layer.provideMerge(KinEventQueue.layer),
  Layer.provideMerge(paired),
);
const owner: Provision.LeadCreator = {
  _tag: "session",
  session: {
    sessionId: AuthSessionId.make("phone"),
    subject: "phone",
    method: "bearer-access-token",
    scopes: AuthStandardClientScopes,
  },
};
const lead = (name: string, domain: string) => ({
  creator: owner,
  name,
  domain,
  charter: "",
  model: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-4-6" },
  workerProjects: [],
});
const watch = (orgId: KinOrgId) =>
  Effect.gen(function* () {
    const hub = yield* RefreshHub.KinRefreshHub;
    const queue = yield* Stream.toQueue(hub.changes(orgId), { capacity: "unbounded" });
    return { queue, first: yield* Queue.take(queue) };
  });

describe("KinRefreshHub", () => {
  it.effect("moves a topic once per commit, and not for a rollback or another org", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { touch } = yield* RefreshHub.KinRefreshObserver;
      const orgId = KinOrgId.make("org");
      const { queue, first } = yield* watch(orgId);
      assert.strictEqual(first.company, 0);
      yield* sql
        .withTransaction(touch(orgId, "company").pipe(Effect.andThen(Effect.fail("rollback"))))
        .pipe(Effect.flip);
      yield* touch(KinOrgId.make("other"), "company");
      yield* sql.withTransaction(
        Effect.all([touch(orgId, "company"), touch(orgId, "company"), touch(orgId, "memory")]),
      );
      yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
      const next = yield* Queue.take(queue);
      assert.deepInclude(next, { company: 1, memory: 1, people: 0 });
      assert.strictEqual(yield* Queue.size(queue), 0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("turns a burst of hundreds of commits into one change", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { touch } = yield* RefreshHub.KinRefreshObserver;
      const orgId = KinOrgId.make("org");
      const { queue } = yield* watch(orgId);
      for (let row = 0; row < 300; row += 1)
        yield* sql.withTransaction(touch(orgId, row % 2 === 0 ? "memory" : "recipes"));
      yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
      assert.deepInclude(yield* Queue.take(queue), { memory: 150, recipes: 150 });
      assert.strictEqual(yield* Queue.size(queue), 0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect(
    "tells a teammate only about their own lead list, people, the time zone, the lists she sees, the stop switch and what needs attention, never the owner's reads",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { owner: me } = yield* KinIdentity;
        const finance = (yield* Provision.create(lead("Finance", "finance"))).lead;
        const tech = (yield* Provision.create(lead("Tech", "engineering"))).lead;
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
          VALUES ('priya', ${me.orgId}, 'priya', 'Priya', '2026-11-09T00:00:00.000Z')`;
        const priya = { ...me, personId: KinPersonId.make("priya") };
        // She already has her chat with Finance, as anyone may.
        yield* Provision.allow({
          editor: owner,
          orgId: me.orgId,
          agentId: finance.agentId,
          personId: priya.personId,
        });
        // A company created now, its country not chosen yet.
        yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
            updated_by_kind, updated_by_id)
          VALUES (${me.orgId}, ${yield* newCompanyProfileJson}, 1, 0, 'person', ${me.personId})`;
        const { boot } = yield* RefreshHub.KinRefreshHub;
        const ownerSees = yield* Stream.toQueue(subscribeRefreshes([me], { orgId: me.orgId }), {
          capacity: "unbounded",
        });
        const priyaSees = yield* Stream.toQueue(subscribeRefreshes([priya], { orgId: me.orgId }), {
          capacity: "unbounded",
        });
        const start = yield* Queue.take(ownerSees);
        assert.deepStrictEqual(yield* Queue.take(priyaSees), {
          timeZone: 0,
          people: 0,
          leads: 0,
          pulse: 0,
          workLists: 0,
          stop: 0,
          watches: 0,
          shell: 0,
          numbers: 0,
          company: 0,
          boot,
          streams: KIN_STREAMS,
        });

        // Things only the owner reads: the company, and a lead's charter.
        yield* setProfile(
          me.orgId,
          { _tag: "person", personId: me.personId },
          { legalName: "Acme Tools" },
          0,
        );
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        yield* Provision.update({
          editor: owner,
          orgId: me.orgId,
          agentId: tech.agentId,
          fields: { charter: "Private: the Acme migration." },
        });
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        assert.deepInclude(yield* Queue.take(ownerSees), {
          company: (start.company ?? 0) + 1,
          leads: start.leads,
        });
        assert.deepInclude(yield* Queue.take(ownerSees), { leads: (start.leads ?? 0) + 1 });
        // A list definition she sees no entry of, such as a money list the owner renamed.
        yield* sql.withTransaction(
          (yield* RefreshHub.KinRefreshObserver).touch(me.orgId, "workLists"),
        );
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        assert.deepInclude(yield* Queue.take(ownerSees), {
          workLists: (start.workLists ?? 0) + 1,
        });

        // The owner restricts Priya from Finance: her chat with it closes and her list changed, so
        // hers is the next thing she hears.
        yield* Provision.disallow({
          editor: owner,
          orgId: me.orgId,
          agentId: finance.agentId,
          personId: priya.personId,
        });
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        const moved = {
          timeZone: 0,
          people: 0,
          leads: 1,
          pulse: 0,
          workLists: 0,
          stop: 0,
          watches: 0,
          shell: 0,
          numbers: 0,
          company: 0,
          boot,
          streams: KIN_STREAMS,
        };
        assert.deepStrictEqual(yield* Queue.take(priyaSees), moved);
        assert.strictEqual(yield* Queue.size(priyaSees), 0);
        // Her reconnect with nothing moved since hears the same numbers, so she reads nothing again.
        const again = yield* Stream.toQueue(subscribeRefreshes([priya], { orgId: me.orgId }), {
          capacity: "unbounded",
        });
        assert.deepStrictEqual(yield* Queue.take(again), moved);
        // The country chosen, her company topic moves once, so her Money step clears.
        yield* setProfile(
          me.orgId,
          { _tag: "person", personId: me.personId },
          { country: "GB" },
          undefined,
        );
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        assert.deepStrictEqual(yield* Queue.take(priyaSees), { ...moved, company: 1 });
        // The owner stops every agent: she hears it, so her chat says why nobody answers.
        yield* sql.withTransaction((yield* RefreshHub.KinRefreshObserver).touch(me.orgId, "stop"));
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        assert.deepStrictEqual(yield* Queue.take(priyaSees), { ...moved, company: 1, stop: 1 });
        yield* KinShell.KinShell.use((shell) =>
          shell.set(me.orgId, me.personId, 0, [{ id: "deals", on: false }]),
        ).pipe(Effect.provide(KinShell.layer));
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        assert.deepStrictEqual(yield* Queue.take(priyaSees), {
          ...moved,
          company: 1,
          stop: 1,
          shell: 1,
          pulse: 1,
        });
      }).pipe(Effect.scoped, Effect.provide(paired)),
  );

  let statements = 0;
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        if (typeof span.attributes.get("db.query.text") === "string") statements += 1;
      };
      return span;
    },
  });
  it.effect(
    "reads a person's view once a burst for all their screens, and a demoted co-owner's next as a member's",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { touch } = yield* RefreshHub.KinRefreshObserver;
        const { owner: me } = yield* KinIdentity;
        yield* Provision.create(lead("Finance", "finance"));
        yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at,
            access)
          VALUES ('meera', ${me.orgId}, 'meera', 'Meera', '2026-11-09T00:00:00.000Z', 'member'),
            ('zoya', ${me.orgId}, 'zoya', 'Zoya', '2026-11-09T00:00:00.000Z', 'co_owner')`;
        const screens = (personId: string, count: number) =>
          Effect.forEach(Array.from({ length: count }), () =>
            Effect.gen(function* () {
              const queue = yield* Stream.toQueue(
                subscribeRefreshes([{ ...me, personId: KinPersonId.make(personId) }], {
                  orgId: me.orgId,
                }),
                { capacity: "unbounded" },
              );
              yield* Queue.take(queue);
              return queue;
            }),
          );
        const burst = Effect.fn("test.burst")(function* (
          queues: Effect.Success<ReturnType<typeof screens>>,
        ) {
          statements = 0;
          yield* sql.withTransaction(
            Effect.all([touch(me.orgId, "people"), touch(me.orgId, "leads")]),
          );
          yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
          const seen = yield* Effect.forEach(queues, Queue.take);
          return { statements, seen };
        });
        const one = yield* Effect.scoped(
          Effect.gen(function* () {
            return (yield* burst(yield* screens("meera", 1))).statements;
          }),
        );
        const three = yield* Effect.scoped(
          Effect.gen(function* () {
            return (yield* burst(yield* screens("meera", 3))).statements;
          }),
        );
        assert.isAbove(one, 0);
        assert.strictEqual(three, one, "her three screens share one read of her view");

        const hers = yield* screens("zoya", 2);
        const before = yield* burst(hers);
        for (const seen of before.seen) assert.property(seen, "memory", "a co-owner's topics");
        yield* sql`UPDATE kin_people SET access = 'member' WHERE person_id = 'zoya'`;
        const after = yield* burst(hers);
        for (const seen of after.seen) {
          assert.notProperty(seen, "memory", "a demoted co-owner hears only a member's topics");
          assert.property(seen, "leads");
        }
      }).pipe(Effect.withTracer(tracer), Effect.scoped, Effect.provide(paired)),
  );

  it.effect("moves a member's list refresh when team sharing opens or closes a list", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { owner: rhea } = yield* KinIdentity;
      const { orgId } = rhea;
      const arjun = { ...rhea, personId: KinPersonId.make("arjun") };
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at)
        VALUES (${arjun.personId}, ${orgId}, 'arjun', 'Arjun', '2026-11-09T00:00:00.000Z')`;
      const refreshes = subscribeRefreshes([arjun], { orgId });
      const queue = yield* Stream.toQueue(refreshes, { capacity: "unbounded" });
      const first = yield* Queue.take(queue);
      yield* defineList(orgId, yield* proposalFor(orgId, { name: "Bookings" }), 0);
      assert.deepStrictEqual(yield* Stream.runHead(refreshes), Option.some(first));
      assert.strictEqual(yield* Queue.size(queue), 0);
      const change = (team: boolean, rev: number) => {
        const input = { orgId, list: "bookings", rev, team };
        return Money.updateList([rhea], input);
      };
      yield* change(true, 1);
      assert.deepStrictEqual(
        yield* Stream.runHead(refreshes),
        Option.some({ ...first, workLists: 1 }),
      );
      yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
      assert.deepInclude(yield* Queue.take(queue), { workLists: 1 });
      yield* change(false, 2);
      yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
      assert.deepInclude(yield* Queue.take(queue), { workLists: 2 });
    }).pipe(Effect.scoped, Effect.provide(paired)),
  );

  it.effect("a member hears connections only when their own connections read changed", () => {
    const mailboxes = new Map<KinPersonId, KinMyMailbox>();
    const connections = Layer.mock(KinConnections)({
      mine: (people, { orgId }) =>
        Effect.sync(() => {
          const person = people.find((person) => person.orgId === orgId);
          return (
            (person && mailboxes.get(person.personId)) ?? {
              orgId,
              mailbox: null,
              mailboxes: [],
              services: [
                { service: "google", label: "Google", ready: true },
                { service: "microsoft", label: "Microsoft", ready: false },
              ],
              signInAddress: "https://ambermill.example/sign-in",
            }
          );
        }),
    });
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { touch } = yield* RefreshHub.KinRefreshObserver;
      const { owner: rhea } = yield* KinIdentity;
      const { orgId } = rhea;
      const zoya = { ...rhea, personId: KinPersonId.make("zoya") };
      const arjun = { ...rhea, personId: KinPersonId.make("arjun") };
      yield* sql`INSERT INTO kin_people (person_id, org_id, handle, display_name, created_at, access)
        VALUES (${zoya.personId}, ${orgId}, 'zoya', 'Zoya', '2026-11-09T00:00:00.000Z', 'member'),
          (${arjun.personId}, ${orgId}, 'arjun', 'Arjun', '2026-11-09T00:00:00.000Z', 'member')`;
      const zoyaRefreshes = subscribeRefreshes([zoya], { orgId });
      const zoyaQueue = yield* Stream.toQueue(zoyaRefreshes, { capacity: "unbounded" });
      const arjunQueue = yield* Stream.toQueue(subscribeRefreshes([arjun], { orgId }), {
        capacity: "unbounded",
      });
      const rheaQueue = yield* Stream.toQueue(subscribeRefreshes([rhea], { orgId }), {
        capacity: "unbounded",
      });
      const zoyaFirst = yield* Queue.take(zoyaQueue);
      const arjunFirst = yield* Queue.take(arjunQueue);
      const rheaFirst = yield* Queue.take(rheaQueue);
      assert.strictEqual(zoyaFirst.connections, 0);
      assert.strictEqual(arjunFirst.connections, 0);
      assert.strictEqual(rheaFirst.connections, 0);

      const connect = (personId: KinPersonId, first: KinMyMailbox) => {
        const mailbox = {
          connectionId: KinConnectionId.make(`${personId}-mail`),
          preset: "google",
          account: `${personId}@ambermill.example`,
          state: "active",
        } satisfies KinMyMailbox["mailbox"];
        mailboxes.set(personId, { ...first, mailbox, mailboxes: [mailbox] });
      };
      const { mine } = yield* KinConnections;
      const burst = sql
        .withTransaction(touch(orgId, "connections"))
        .pipe(Effect.andThen(TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE)));
      connect(zoya.personId, yield* mine([zoya], { orgId }));
      yield* burst;
      const zoyaNext = yield* Queue.take(zoyaQueue);
      assert.strictEqual(zoyaNext.connections, (zoyaFirst.connections ?? 0) + 1);
      assert.strictEqual(yield* Queue.size(arjunQueue), 0);
      assert.strictEqual((yield* Queue.take(rheaQueue)).connections, 1);

      yield* burst;
      assert.strictEqual(yield* Queue.size(zoyaQueue), 0);
      assert.strictEqual(yield* Queue.size(arjunQueue), 0);
      assert.strictEqual((yield* Queue.take(rheaQueue)).connections, 2);

      connect(arjun.personId, yield* mine([arjun], { orgId }));
      yield* burst;
      assert.strictEqual(
        (yield* Queue.take(arjunQueue)).connections,
        (arjunFirst.connections ?? 0) + 1,
      );
      assert.strictEqual(yield* Queue.size(zoyaQueue), 0);
      assert.strictEqual((yield* Queue.take(rheaQueue)).connections, 3);

      assert.deepStrictEqual(yield* Stream.runHead(zoyaRefreshes), Option.some(zoyaNext));
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(paired, connections)));
  });

  it.effect("moves the lists a new company made while waiting when its country is saved", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { owner: me } = yield* KinIdentity;
      yield* sql`INSERT INTO kin_company_profile (org_id, profile_json, rev, updated_at,
          updated_by_kind, updated_by_id)
        VALUES (${me.orgId}, ${yield* newCompanyProfileJson}, 1, 0, 'person', ${me.personId})`;
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json, rev)
        VALUES (${me.orgId}, 'expenses', 'Expenses', 'EXP', 0, 0,
          ${JSON.stringify({ currency: "INR", currencyPending: true })}, 1)`;
      const { queue, first } = yield* watch(me.orgId);
      yield* setProfile(
        me.orgId,
        { _tag: "person", personId: me.personId },
        { country: "GB" },
        undefined,
      );
      yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
      assert.deepInclude(yield* Queue.take(queue), {
        company: (first.company ?? 0) + 1,
        workLists: (first.workLists ?? 0) + 1,
      });
    }).pipe(Effect.scoped, Effect.provide(paired)),
  );

  it.effect(
    "refuses to start Kin's services on the no-op observer, which would drop every notice",
    () =>
      Effect.gen(function* () {
        const bare = yield* Effect.exit(RefreshHub.requireRefreshObserver(Context.empty()));
        assert.isTrue(Exit.hasDies(bare));
        const wired = yield* Effect.context<never>();
        assert.isTrue(Exit.isSuccess(yield* Effect.exit(RefreshHub.requireRefreshObserver(wired))));
      }).pipe(Effect.provide(layer)),
  );

  it.effect(
    "moves Work choices when a client changes, and takes the owner's word for another process's writes",
    () =>
      Effect.gen(function* () {
        const { owner: me } = yield* KinIdentity;
        const records = yield* KinRecords.KinRecords;
        const ownerSees = yield* Stream.toQueue(subscribeRefreshes([me], { orgId: me.orgId }), {
          capacity: "unbounded",
        });
        const work = yield* Stream.toQueue(records.changes(me.orgId), { capacity: "unbounded" });
        const start = yield* Queue.take(ownerSees);
        const first = yield* Queue.take(work);
        yield* records.create(
          me.orgId,
          { actor: { _tag: "system" }, via: "import" },
          {
            list: "clients",
            title: "Invented Acme",
            owner: { _tag: "person", personId: me.personId },
            originKey: "acme",
          },
        );
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        assert.deepInclude(yield* Queue.take(ownerSees), {
          workChoices: (start.workChoices ?? 0) + 1,
        });
        const created = yield* Queue.take(work);
        assert.isAbove(created.seq, first.seq);
        assert.strictEqual(created.key, "C-1");

        // What the `kin` CLI wrote in its own process reaches these listeners through the owner.
        yield* announceRefreshes([me], {
          orgId: me.orgId,
          topics: ["leads", "workChoices", "leads"],
          records: true,
        });
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        assert.deepInclude(yield* Queue.take(ownerSees), {
          leads: (start.leads ?? 0) + 1,
          workChoices: (start.workChoices ?? 0) + 2,
        });
        const announced = yield* Queue.take(work);
        assert.strictEqual(announced.seq, created.seq + 1);
        // Everyone's own number moves too, so a viewer who resumes later reads again.
        assert.deepStrictEqual([...(announced.team?.keys() ?? [])], [me.personId]);
        // An owner's open Work screens read again only once the number they were told moves.
        const rows = yield* WorkStream.makeWorkStream([me], { orgId: me.orgId, acceptRows: true });
        yield* rows.start(created.seq);
        const told = yield* rows.batch(rows.pendingOf(announced));
        assert.deepStrictEqual(
          told.map((event) => [event._tag, event.seq]),
          [
            ["snapshot-required", announced.seq],
            ["counts", announced.seq],
          ],
        );
        const someone = { ...me, personId: KinPersonId.make("someone") };
        assert.include(
          yield* announceRefreshes([someone], {
            orgId: me.orgId,
            topics: ["leads"],
            records: true,
          }).pipe(Effect.flip),
          { reason: "not_allowed" },
        );
        assert.strictEqual(yield* Queue.size(work), 0);
      }).pipe(Effect.scoped, Effect.provide(withRecords)),
  );

  // Every write to a table behind one of these reads is in a file that tells the hub. A new file
  // that writes one fails here until it touches the topic and is listed.
  it("finds no write to a refreshed table outside the files that touch its topic", () => {
    const root = NodePath.resolve(import.meta.dirname, "..");
    const writers: Record<string, ReadonlyArray<string>> = {
      kin_number_values: ["numbers/KinNumbers.ts"],
      // The repository writes only a new company's first profile, at first start, before any client.
      kin_company_profile: ["work/companyProfile.ts", "chat/KinChatRepository.ts"],
      kin_recipe_defaults: ["gendocs/recipeDefaults.ts"],
      kin_recipe_labels: ["gendocs/recipeLabels.ts"],
      kin_memory_heads: ["memory/Memory.ts"],
      // Binding a suggestion as it is shown, in `bindSuggestions`, is part of reading the list.
      kin_memory_labels: ["memory/sensitivity.ts"],
      // The repository writes only the first-start owner, before any client, and test seeds.
      kin_people: [
        "people/KinPeople.ts",
        "chat/KinChatRepository.ts",
        "lead/peopleUpdate.ts",
        "lead/awaySet.ts",
        // A person's own morning page setting, pinned below: no people screen reads it.
        "pulse/checkIns.ts",
      ],
      // A sign-out's cascade (auth/linkedDevices.ts) runs in the session store, below Kin's hub,
      // and returns the companies it changed: the session store tells the hub after commit.
      kin_people_invites: ["people/KinPeople.ts", "auth/linkedDevices.ts"],
      kin_session_bindings: ["people/KinPeople.ts", "auth/linkedDevices.ts"],
      // The runner's thread and the hidden level are never part of a lead's list.
      kin_leads: ["lead/KinLeadProvision.ts", "lead/WakeupRunner.ts", "lead/KinLevels.ts"],
      kin_lead_access: ["lead/KinLeadProvision.ts", "people/KinPeople.ts"],
      kin_team_agents: ["lead/KinLeadProvision.ts"],
      kin_trigger_settings: ["triggers/routines.ts"],
      kin_visual_hosts: ["chat/KinVisualHosts.ts"],
      kin_money_budgets: ["work/budgets.ts"],
      kin_github_watch: ["github/GitHubWatch.ts"],
      kin_github_branch_guards: ["github/branchGuard.ts"],
      kin_github_owner_uses: [
        "github/KinGitHubApp.ts",
        "github/branchGuard.ts",
        "github/appRepos.ts",
      ],
      kin_budget_limits: ["lead/KinBudget.ts"],
      // Pause and resume touch `stop`. The heartbeat and pending offline notices have no stop state.
      kin_org_state: ["lead/KinStop.ts", "host/offlineCatchUp.ts"],
      // A zone change renames due-keyed facts; KinRoutines.configure touches pulse (pinned below).
      kin_pulse_facts: ["pulse/KinPulse.ts", "work/allDayZone.ts"],
      // Lists read only rows a company defined (`built_in = 0`). The deals files write the built-in
      // deals row's stages and pipeline flag, and KinRecords a built-in row and the next number,
      // which no list read selects.
      kin_registers: [
        "work/registers.ts",
        "work/ownerMoney.ts",
        "work/companyProfile.ts",
        "work/importUndo.ts",
        "work/deals.ts",
        "work/dealStages.ts",
        "work/KinRecords.ts",
      ],
      // Cash and the outlook read statements once `read`. The other writers set them unreadable,
      // scanned, a draft or its proof rounds, none of which those reads show.
      kin_bank_statements: [
        "work/statements/statementReview.ts",
        "work/statements/statementApply.ts",
        "work/ownerStatements.ts",
        "work/leadStatements.ts",
        "work/statements/statementReading.ts",
      ],
      kin_bank_statement_entries: [
        "work/statements/statementReview.ts",
        "work/statements/statementApply.ts",
        // A zone change moves undo days; KinRoutines.configure touches moneyStatements (below).
        "work/allDayZone.ts",
      ],
      // An import's and an undo's own row: each chunk moves `imports`, as does each run's end.
      kin_import_runs: ["work/KinImport.ts", "work/importUndo.ts"],
      // A key's last use, written as the key is admitted, shows at the next read.
      kin_tasks_keys: ["tasksKey/TasksKeys.ts", "people/KinPeople.ts", "auth/linkedDevices.ts"],
      // A clear stamps open suggestions in the repository; `KinChatService.clear` tells the hub.
      kin_recommendations: [
        "chat/KinChatRepository.ts",
        "recommend/KinRecommend.ts",
        "recommend/card.ts",
      ],
      kin_company_shell: ["shell/KinShell.ts"],
      // The watch repository alone writes these; the topic moves on visible writes.
      kin_watches: ["watches/KinWatches.ts"],
      kin_watch_looks: ["watches/KinWatches.ts"],
    };
    const write = new RegExp(
      `(?:INSERT INTO|UPDATE|DELETE FROM)\\s+(${Object.keys(writers).join("|")})\\b`,
      "g",
    );
    const found: Array<string> = [];
    for (const file of NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".ts") || /\.test\.ts$|\.testkit\.ts$|migrations\//.test(file)) continue;
      for (const match of NodeFS.readFileSync(NodePath.join(root, file), "utf8").matchAll(write))
        if (!writers[match[1]!]!.includes(file)) found.push(`${file}: ${match[1]}`);
    }
    assert.deepStrictEqual(found, []);
    const watchWriters = NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
      (file) =>
        file.endsWith(".ts") &&
        !/\.test\.ts$/.test(file) &&
        /from "(?:\.\.?\/)+(?:watches\/)?KinWatches\.ts"/.test(
          NodeFS.readFileSync(NodePath.join(root, file), "utf8"),
        ),
    );
    assert.deepStrictEqual(watchWriters.toSorted(), [
      "lead/Retirement.ts",
      "persistence/KinRetention.ts",
      "tasksKey/acts.ts",
      "watches/KinWatchRounds.ts",
      "watches/rpcHandlers.ts",
      "work/deals.ts",
    ]);
    const watches = NodeFS.readFileSync(NodePath.join(root, "watches/KinWatches.ts"), "utf8");
    assert.strictEqual(watches.match(/touch\(orgId, "watches"\)/g)?.length, 9);
    const routines = NodeFS.readFileSync(NodePath.join(root, "triggers/routines.ts"), "utf8");
    assert.include(routines, "keepAllDayDays(settings.orgId, before, settings.timeZone)");
    for (const topic of ["pulse", "moneyStatements"])
      assert.include(routines, `refresh.touch(settings.orgId, "${topic}")`);
    const briefs = NodeFS.readFileSync(NodePath.join(root, "pulse/checkIns.ts"), "utf8");
    const sets = [...briefs.matchAll(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+kin_people\b([^`]*)`/g)];
    assert.deepStrictEqual(
      sets.map((one) =>
        /^ SET morning_json = \$\{morningJson\(\{[^}]*\}\)\}\s+WHERE /.test(one[1]!),
      ),
      [true],
    );
    const readers = NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
      (file) =>
        file.endsWith(".ts") &&
        !/\.test\.ts$|migrations\//.test(file) &&
        NodeFS.readFileSync(NodePath.join(root, file), "utf8").includes("morning_json"),
    );
    assert.deepStrictEqual(readers.toSorted(), ["pulse/checkIns.ts", "pulse/personMorning.ts"]);
  });
});
