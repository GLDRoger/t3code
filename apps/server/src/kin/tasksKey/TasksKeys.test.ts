import { assert, it } from "@effect/vitest";
import {
  type KinChatError,
  MemoryItemHead,
  AuthKinTasksScope,
  type AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentHttpApi,
  KIN_RECORD_COMMENTS_PAGE,
  type KinPersonId,
  type KinWorkPrincipal,
  type KinTasksKeysIssueInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Etag from "effect/http/Etag";
import * as FileSystem from "effect/FileSystem";
import * as HttpPlatform from "effect/http/HttpPlatform";
import { HttpEffect, HttpRouter, HttpServerRequest, type HttpServerResponse } from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { type AuthenticatedSession, EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../../auth/http.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { CloudLink } from "../../cloud/CloudLink.ts";
import * as CliAuth from "../auth/EnvironmentAuthRuntime.ts";
import { layerAuthTest, pairSession } from "../auth/ProofKeySessions.testkit.ts";
import { cliCommits } from "../cli/announce.ts";
import * as ServerConfig from "../../config.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import * as RefreshHub from "../chat/KinRefreshHub.ts";
import * as People from "../people/KinPeople.ts";
import * as Deals from "../work/deals.ts";
import * as Clients from "../work/ownerClients.ts";
import * as Records from "../work/KinRecords.ts";
import { dealLink } from "../work/promises.ts";
import * as Work from "../work/ownerWork.ts";
import { TasksKeyAudience } from "./audience.ts";
import { KinMemoryChanges } from "../memory/MemoryChanges.ts";
import * as MemoryChanges from "../memory/MemoryChanges.ts";
import { authorise, fingerprint } from "../memory/sensitivity.ts";
import * as Docs from "../work/docs.ts";
import { defineList, presetDefinition, proposalFor } from "../work/registers.ts";
import { lists, money, updateList } from "../work/ownerMoney.ts";
import { MATERIAL } from "../you/projection.ts";
import {
  findDocs,
  listClients,
  listProjects,
  moneySummary,
  openClient,
  openProject,
  readDoc,
  searchMemory,
  unknownKey,
} from "./reads.ts";
import * as Acts from "./acts.ts";
import { listPeople } from "./people.ts";
import {
  commentMine,
  createProject,
  createTask,
  getMine,
  listMine,
  listSeenBy,
  setStateMine,
  updateProject,
  updateTask,
} from "./tasks.ts";
import { admitted, layer, layerAt, team } from "./tasksKey.testkit.ts";
import * as TasksKeys from "./TasksKeys.ts";
import { KIN_GITHUB_HOOK_ROUTE } from "../github/appHook.ts";
import * as KinGitHubHookHttp from "../github/hookHttp.ts";
import { KinServer } from "../KinServer.ts";

const reason = <A, E extends { readonly reason?: string }, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.reason),
  );

it.effect("a person makes keys only for themself, three at most, even two at once", () =>
  Effect.gen(function* () {
    const { orgId, rhea, zoya, arjun } = yield* team;
    const sessions = yield* SessionStore;
    // Whoever the call names, the key is the caller's.
    const claimed = { orgId, label: "Invented laptop", personId: arjun.personId };
    const input: KinTasksKeysIssueInput = claimed;
    const first = yield* TasksKeys.issue(zoya.app, input);
    assert.deepInclude(first, { path: "/kin/you/mcp" });
    assert.deepInclude(first.key, { personId: zoya.personId, label: "Invented laptop" });
    assert.isNull(first.key.lastUsedAt);
    const issued = yield* sessions
      .verify(first.secret)
      .pipe(Effect.provideService(TasksKeyAudience, true));
    assert.deepStrictEqual(issued.scopes, [AuthKinTasksScope]);
    assert.strictEqual(issued.subject, TasksKeys.KIN_TASKS_KEY_SUBJECT);

    const second = yield* TasksKeys.issue(zoya.app, { orgId });
    // Two at once at two keys: exactly one is made.
    const both = yield* Effect.forEach(
      [zoya.app, zoya.app],
      (app) => Effect.result(TasksKeys.issue(app, { orgId })),
      { concurrency: 2 },
    );
    assert.deepStrictEqual(both.map((one) => one._tag).toSorted(), ["Failure", "Success"]);
    assert.strictEqual(yield* reason(TasksKeys.issue(zoya.app, { orgId })), "limit");
    assert.lengthOf((yield* TasksKeys.list(zoya.app, { orgId })).keys, 3);
    const keyRows = yield* (yield* SqlClient.SqlClient)<{ n: number }>`SELECT COUNT(*) AS n
      FROM kin_tasks_keys WHERE person_id = ${zoya.personId}`;
    assert.strictEqual(keyRows[0]?.n, 3);
    // Her three are hers: Arjun makes his own.
    yield* TasksKeys.issue(arjun.app, { orgId });

    // A session that is no person in Kin, as an agent's or a script's is, makes none.
    const script = yield* (yield* EnvironmentAuth).issueSession({ subject: "script" });
    const unpaired = yield* sessions.verify(script.token);
    assert.strictEqual(yield* reason(TasksKeys.issue(unpaired, { orgId })), "not_allowed");
    // Nor does a key make a key.
    assert.strictEqual(yield* reason(TasksKeys.issue(issued, { orgId })), "not_allowed");

    // Only the owner level reads another person's keys.
    assert.strictEqual(
      yield* reason(TasksKeys.list(zoya.app, { orgId, personId: arjun.personId })),
      "not_found",
    );
    assert.lengthOf((yield* TasksKeys.list(rhea.app, { orgId, personId: zoya.personId })).keys, 3);
    // A use is shown in the list, and an open list hears of it, once a minute at most.
    const touched: Array<string> = [];
    const observed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(RefreshHub.KinRefreshObserver, {
          touch: (_org, topic) => Effect.sync(() => void touched.push(topic)),
        }),
      );
    yield* observed(admitted(first.secret));
    yield* observed(admitted(first.secret));
    assert.deepStrictEqual(touched, ["people"]);
    const used = (yield* TasksKeys.list(zoya.app, { orgId })).keys.find(
      (one) => one.sessionId === first.key.sessionId,
    );
    assert.isNotNull(used?.lastUsedAt);
    // Last use is bookkeeping: when it can't be written, a live key still gets in.
    yield* (yield* SqlClient.SqlClient)`CREATE TRIGGER invented_last_use_fails
      BEFORE UPDATE OF last_used_at ON kin_tasks_keys
      BEGIN SELECT RAISE(ABORT, 'invented write failure'); END`;
    assert.strictEqual((yield* admitted(second.secret)).personId, zoya.personId);
    const unrecorded = (yield* TasksKeys.list(zoya.app, { orgId })).keys.find(
      (one) => one.sessionId === second.key.sessionId,
    );
    assert.isNull(unrecorded?.lastUsedAt);
  }).pipe(Effect.provide(layer)),
);

it.effect("a key reaches the tasks its person's screen shows, and changes them as them", () =>
  Effect.gen(function* () {
    const { orgId, rhea, zoya, arjun } = yield* team;
    const records = yield* Records.KinRecords;
    const sql = yield* SqlClient.SqlClient;
    const writer = (personId: KinPersonId) => ({
      actor: { _tag: "person" as const, personId },
      via: "owner" as const,
      askedBy: personId,
    });
    const make = (originKey: string, fields: Partial<Records.CreateInput> = {}) =>
      records
        .create(orgId, writer(rhea.personId), {
          originKey,
          title: `Invented: ${originKey}`,
          owner: { _tag: "person", personId: zoya.personId },
          ...fields,
        })
        .pipe(Effect.map(({ row }) => row));
    const client = yield* make("Lantern Co", {
      list: "clients",
      owner: writer(rhea.personId).actor,
    });
    // A project she is on, so its name is hers to see, as her app shows it.
    const project = yield* make("launch", {
      list: "projects",
      owner: writer(rhea.personId).actor,
      fields: { members: [`person:${zoya.personId}`] },
    });
    const hers = yield* make("book the hall", {
      notes: "Invented brief: two rooms",
      partyId: client.recordId,
      projectId: project.recordId,
      amount: { minor: 500_000, currency: "INR" },
      dueAt: Date.parse("2026-12-01T10:00:00.000Z"),
    });
    // Arjun's, shared with the team; one Zoya gave Arjun; the owner's own.
    const shared = yield* make("print flyers", {
      owner: { _tag: "person", personId: arjun.personId },
      team: true,
    });
    const { row: given } = yield* records.create(orgId, writer(zoya.personId), {
      originKey: "given",
      title: "Invented: order chairs",
      owner: { _tag: "person", personId: arjun.personId },
    });
    const owners = yield* make("sign the lease", { owner: writer(rhea.personId).actor });

    const zoyaKey = yield* admitted((yield* TasksKeys.issue(zoya.app, { orgId })).secret);
    const rheaKey = yield* admitted((yield* TasksKeys.issue(rhea.app, { orgId })).secret);
    const task = {
      key: hers.key,
      title: "Invented: book the hall",
      state: "open" as const,
      due: "2026-12-01T10:00:00.000Z",
      dueDay: "Tue 1 Dec 2026",
      project: "Invented: launch",
    };
    assert.deepStrictEqual(yield* listMine(zoyaKey), {
      tasks: [task],
      more: false,
      material: MATERIAL,
    });
    // No money and no client on a task: what her Tasks screen shows of it.
    assert.deepStrictEqual(yield* getMine(zoyaKey, hers.key), {
      ...task,
      checklist: [],
      brief: "Invented brief: two rooms",
      material: MATERIAL,
      comments: [],
    });
    // What her app shows her, her key reads: one shared with the team and one she gave away,
    // never the owner's own.
    assert.strictEqual((yield* getMine(zoyaKey, shared.key)).holder, "Arjun");
    assert.strictEqual((yield* getMine(zoyaKey, given.key)).holder, "Arjun");
    assert.strictEqual(yield* reason(getMine(zoyaKey, owners.key)), "not_found");
    // `list_my_tasks` stays what the person holds or is on, the owner's too.
    assert.deepStrictEqual(
      (yield* listMine(rheaKey)).tasks.map((one) => one.key),
      [owners.key],
    );
    // The owner's key reads and comments on Zoya's task, as the owner's app does.
    assert.strictEqual((yield* getMine(rheaKey, hers.key)).holder, "Zoya");
    // A task only its holder changes stays Arjun's: refused as her screen is.
    assert.strictEqual(
      yield* reason(setStateMine(zoyaKey, { key: shared.key, state: "done" })),
      "not_allowed",
    );
    assert.strictEqual((yield* records.get(orgId, shared.key))?.state, "open");

    // A comment is hers, through the key; the same words again are the same comment.
    const said = { key: hers.key, text: "Invented: the hall is booked" };
    assert.deepStrictEqual(yield* commentMine(zoyaKey, said), { key: hers.key, posted: true });
    assert.deepStrictEqual(yield* commentMine(zoyaKey, said), { key: hers.key, posted: false });
    const comments = yield* sql<{ kind: string; author: string; viaKey: string }>`SELECT
        author_kind AS kind, author_id AS author, coding_agent_key AS "viaKey"
      FROM kin_record_comments WHERE record_id = ${hers.recordId} ORDER BY seq`;
    assert.deepStrictEqual(comments, [
      { kind: "person", author: zoya.personId, viaKey: zoyaKey.sessionId },
    ]);

    const started = yield* setStateMine(zoyaKey, { key: hers.key, state: "doing" });
    assert.deepInclude(started, { key: hers.key, state: "doing" });
    assert.deepStrictEqual(started.comments, [
      { by: "you (the user)", at: started.comments[0]!.at, text: "Invented: the hall is booked" },
    ]);
    const [change] = yield* sql<{
      kind: string;
      actor: string;
      viaKey: string;
      fields: string;
    }>`SELECT actor_kind AS kind, actor_id AS actor, coding_agent_key AS "viaKey",
        fields_json AS fields
      FROM kin_record_changes WHERE record_id = ${hers.recordId} ORDER BY seq DESC LIMIT 1`;
    assert.deepInclude(change, { kind: "person", actor: zoya.personId, viaKey: zoyaKey.sessionId });
    assert.include(change?.fields, '"to":"doing"');
    // The stored sheet names the key it came through; who reads the name is `keyNamedFor`'s.
    yield* sql`UPDATE kin_tasks_keys SET label = 'Invented laptop'
      WHERE session_id = ${zoyaKey.sessionId}`;
    const shown = yield* records.detail((yield* records.get(orgId, hers.key))!, 5);
    assert.deepInclude(shown.changes[0], {
      by: writer(zoya.personId).actor,
      codingAgent: "Invented laptop",
    });
    assert.notProperty(shown.changes.at(-1), "codingAgent");
    assert.deepInclude(shown.comments?.[0], {
      by: writer(zoya.personId).actor,
      codingAgent: "Invented laptop",
    });
    // Notes taken back never hide one still standing, however many there are.
    for (let n = 0; n <= KIN_RECORD_COMMENTS_PAGE; n++)
      yield* commentMine(zoyaKey, { key: hers.key, text: `Invented: draft ${n}` });
    yield* sql`UPDATE kin_record_comments SET removed_at = 1, removed_by_kind = 'person',
        removed_by_id = ${zoya.personId}
      WHERE record_id = ${hers.recordId} AND body LIKE 'Invented: draft %'`;
    assert.deepStrictEqual(
      (yield* getMine(zoyaKey, hers.key)).comments.map((one) => one.text),
      ["Invented: the hall is booked"],
    );
    // Done, then back to open: both hers to set.
    assert.strictEqual(
      (yield* setStateMine(zoyaKey, { key: hers.key, state: "done" })).state,
      "done",
    );
    assert.strictEqual(
      (yield* setStateMine(zoyaKey, { key: hers.key, state: "open" })).state,
      "open",
    );
    // Once it is Arjun's, her key still reads it, as her app does on a project she is on, and
    // its state is Arjun's to change.
    yield* records.update(orgId, writer(rhea.personId), hers.key, {
      owner: { _tag: "person", personId: arjun.personId },
    });
    assert.strictEqual((yield* getMine(zoyaKey, hers.key)).holder, "Arjun");
    assert.strictEqual(
      yield* reason(setStateMine(zoyaKey, { key: hers.key, state: "done" })),
      "not_allowed",
    );
    // Put on it beside Arjun, her key lists it, naming who holds it, reads it and comments on
    // it; its state stays Arjun's to change, refused in the words her own screen gets.
    yield* records.update(orgId, writer(rhea.personId), hers.key, {
      fields: { alsoOn: [`person:${zoya.personId}`] },
    });
    assert.deepInclude(
      (yield* listMine(zoyaKey)).tasks.find((one) => one.key === hers.key),
      { holder: "Arjun" },
    );
    assert.strictEqual((yield* getMine(zoyaKey, hers.key)).key, hers.key);
    assert.deepStrictEqual(
      yield* commentMine(zoyaKey, { key: hers.key, text: "Invented: chairs ordered" }),
      { key: hers.key, posted: true },
    );
    assert.deepInclude(
      yield* Effect.flip(setStateMine(zoyaKey, { key: hers.key, state: "doing" })),
      {
        reason: "not_allowed",
        message:
          "You're on this task, not holding it: you can comment or leave. Arjun can change it.",
      },
    );
    assert.strictEqual((yield* getMine(zoyaKey, hers.key)).state, "open");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a key makes and changes tasks and projects as its person, as far as their screen does",
  () =>
    Effect.gen(function* () {
      const { orgId, rhea, zoya } = yield* team;
      const records = yield* Records.KinRecords;
      const sql = yield* SqlClient.SqlClient;
      const zoyaKey = yield* admitted((yield* TasksKeys.issue(zoya.app, { orgId })).secret);
      const rheaKey = yield* admitted((yield* TasksKeys.issue(rhea.app, { orgId })).secret);
      // Who "him" is: everyone by the name their screens use, a member's teammates as teammates.
      assert.deepStrictEqual((yield* listPeople(zoyaKey)).people, [
        { name: "Arjun", kind: "person", role: "teammate" },
        { name: "Rhea", kind: "person", role: "owner" },
        { name: "Zoya", kind: "person", role: "you" },
      ]);
      const asked = {
        title: "Invented: send the quote",
        brief: "Invented brief: two pages",
        holder: "Arjun",
        due: "2026-12-04",
      };
      const made = yield* createTask(rheaKey, asked);
      assert.deepInclude(made, {
        title: asked.title,
        brief: asked.brief,
        holder: "Arjun",
        due: "2026-12-04",
      });
      // The same request again is the same task; another person's key makes its own.
      assert.strictEqual((yield* createTask(rheaKey, asked)).key, made.key);
      const history = (key: string) =>
        sql<{ actor: string; viaKey: string | null }>`SELECT c.actor_id AS actor,
          c.coding_agent_key AS "viaKey"
        FROM kin_record_changes c JOIN kin_records r ON r.record_id = c.record_id
        WHERE r.key = ${key} ORDER BY c.seq`;
      assert.deepStrictEqual(yield* history(made.key), [
        { actor: rhea.personId, viaKey: rheaKey.sessionId },
      ]);
      // Everyone's tasks, by holder: Arjun's new one reads to the owner's key.
      assert.deepStrictEqual(
        (yield* listSeenBy(rheaKey, { holder: "Arjun" })).tasks.map((one) => one.key),
        [made.key],
      );
      assert.deepStrictEqual((yield* listSeenBy(zoyaKey, { holder: "Arjun" })).tasks, []);
      // Zoya can't see the owner's task to Arjun, so her key can't change it or give it away.
      assert.strictEqual(
        yield* reason(updateTask(zoyaKey, { key: made.key, holder: "Zoya" })),
        "not_found",
      );
      // Shared with the team she reads it; held by Arjun, it is not hers to give away.
      yield* records.update(orgId, writerFor(rhea.personId), made.key, { team: true });
      assert.strictEqual((yield* getMine(zoyaKey, made.key)).holder, "Arjun");
      assert.strictEqual(
        yield* reason(updateTask(zoyaKey, { key: made.key, holder: "Zoya", title: "Invented" })),
        "not_allowed",
      );
      assert.strictEqual((yield* records.get(orgId, made.key))?.title, asked.title);
      // The owner's key changes it and gives it to Zoya, each change marked as the key's.
      const moved = yield* updateTask(rheaKey, {
        key: made.key,
        title: "Invented: send the revised quote",
        due: null,
        holder: "Zoya",
      });
      assert.deepInclude(moved, {
        title: "Invented: send the revised quote",
        due: null,
        holder: "Zoya",
      });
      assert.strictEqual((yield* getMine(zoyaKey, made.key)).holder, undefined);
      // Made, shared by Rhea's own app, then changed and given away through her key.
      assert.deepStrictEqual(
        (yield* history(made.key)).map((one) => one.viaKey),
        [rheaKey.sessionId, null, rheaKey.sessionId, rheaKey.sessionId],
      );
      assert.strictEqual(
        yield* reason(updateTask(rheaKey, { key: made.key, holder: "Nobody at all" })),
        "not_found",
      );
      // Now hers, Zoya's key starts it.
      assert.strictEqual(
        (yield* setStateMine(zoyaKey, { key: made.key, state: "doing" })).state,
        "doing",
      );

      // Projects are the owner level's to make, as in the app.
      const fair = { title: "Invented: spring fair", lead: "Zoya", target: "2027-03-01" };
      const project = yield* createProject(rheaKey, fair);
      assert.strictEqual((yield* createProject(rheaKey, fair)).key, project.key);
      assert.deepStrictEqual(
        (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records
        WHERE register_id = 'projects' AND title = ${fair.title}`)[0]?.n,
        1,
      );
      assert.strictEqual(
        yield* reason(createProject(zoyaKey, { title: "Invented" })),
        "not_allowed",
      );
      yield* updateProject(rheaKey, { key: project.key, notes: "Invented: two stalls" });
      assert.strictEqual((yield* records.get(orgId, project.key))?.notes, "Invented: two stalls");
      assert.strictEqual(
        yield* reason(updateProject(zoyaKey, { key: project.key, notes: "Invented" })),
        "not_allowed",
      );
      assert.deepStrictEqual(yield* history(project.key), [
        { actor: rhea.personId, viaKey: rheaKey.sessionId },
        { actor: rhea.personId, viaKey: rheaKey.sessionId },
      ]);

      // Once revoked, the key makes nothing.
      yield* TasksKeys.revoke(rhea.app, { orgId, sessionId: rheaKey.sessionId });
      assert.strictEqual(
        yield* reason(createTask(rheaKey, { title: "Invented: after revoking" })),
        "not_allowed",
      );
      assert.isUndefined(
        (yield* sql<{ key: string }>`SELECT key FROM kin_records
        WHERE title = 'Invented: after revoking'`)[0],
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "a key does by hand what its person's screens do, marked as theirs, and nothing their screens refuse",
  () =>
    Effect.gen(function* () {
      const { orgId, rhea, zoya } = yield* team;
      const records = yield* Records.KinRecords;
      const sql = yield* SqlClient.SqlClient;
      const rheaKey = yield* admitted((yield* TasksKeys.issue(rhea.app, { orgId })).secret);
      const zoyaKey = yield* admitted((yield* TasksKeys.issue(zoya.app, { orgId })).secret);
      const marks = (key: string) =>
        sql<{ viaKey: string | null }>`SELECT c.coding_agent_key AS "viaKey"
          FROM kin_record_changes c JOIN kin_records r ON r.record_id = c.record_id
          WHERE r.key = ${key} ORDER BY c.seq`.pipe(
          Effect.map((rows) => rows.map((row) => row.viaKey)),
        );
      const count = (title: string) =>
        sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records WHERE title = ${title}`.pipe(
          Effect.map(([row]) => row?.n ?? 0),
        );

      // A client, with its first contact; the same request again is the same client.
      const client = { name: "Invented Lantern Co", contact: { name: "Invented Ira" } };
      const lantern = yield* Acts.createClient(rheaKey, client);
      assert.strictEqual(yield* Acts.createClient(rheaKey, client), lantern);
      assert.strictEqual(yield* count(client.name), 1);
      yield* Acts.updateClient(rheaKey, {
        key: lantern,
        notes: "Invented: prefers mornings",
        newContact: { name: "Invented Omar", role: "Buyer" },
      });
      const page = yield* Clients.party([{ _tag: "person", orgId, personId: rhea.personId }], {
        orgId,
        key: lantern,
      });
      assert.strictEqual(page.party.notes, "Invented: prefers mornings");
      assert.sameMembers(
        page.contacts.map((one) => one.name),
        ["Invented Ira", "Invented Omar"],
      );
      assert.isTrue((yield* marks(lantern)).every((viaKey) => viaKey === rheaKey.sessionId));
      // A call logged, with its follow-up the person's own task.
      yield* Acts.logContact(rheaKey, {
        client: lantern,
        kind: "call",
        note: "Invented: wants a quote",
        next: { title: "Invented: send the quote", due: "2026-12-02" },
      });
      assert.strictEqual(yield* count("Invented: send the quote"), 1);
      // Its history shows it came through her coding agent.
      const logged = yield* Clients.party([{ _tag: "person", orgId, personId: rhea.personId }], {
        orgId,
        key: lantern,
      });
      assert.strictEqual(logged.touches?.[0]?.who, "Rhea (coding agent)");

      // A deal on it, then moved on; and a promise to them, kept.
      const name = (who: KinWorkPrincipal) => (who._tag === "person" ? who.personId : who.agentId);
      const deal = yield* Acts.createDeal(
        rheaKey,
        {
          client: lantern,
          title: "Invented: spring order",
          value: { minor: 90_000, currency: "INR" },
        },
        name,
      );
      assert.deepInclude(deal, { title: "Invented: spring order", state: "open" });
      const won = yield* Acts.updateDeal(rheaKey, { key: deal.key, outcome: "won" }, name);
      assert.strictEqual(won.state, "won");
      assert.isTrue((yield* marks(deal.key)).every((viaKey) => viaKey === rheaKey.sessionId));
      const promise = yield* Acts.addPromise(rheaKey, {
        client: lantern,
        what: "Invented: samples by Friday",
        due: "2026-12-04",
      });
      assert.strictEqual((yield* Acts.closePromise(rheaKey, promise.key)).state, "done");

      // A doc gets a new version of one section; one read before it changed writes nothing.
      const doc = yield* Docs.create(
        orgId,
        { actor: { _tag: "person", personId: rhea.personId }, via: "owner" },
        {},
        {
          title: "Invented price list",
          body: "Intro.\n\n## Prices\n\nTea 10 invented credits.\n",
          owner: { _tag: "person", personId: rhea.personId },
          summary: "Created",
          company: true,
          originKey: "test:price-list",
        },
      );
      const wrote = yield* Acts.writeDoc(rheaKey, {
        key: doc.row.key,
        version: doc.version.version,
        section: "Prices",
        text: "Tea 12 invented credits.",
      });
      assert.strictEqual(wrote.version, doc.version.version + 1);
      assert.strictEqual(
        yield* reason(
          Acts.writeDoc(rheaKey, {
            key: doc.row.key,
            version: doc.version.version,
            section: "Prices",
            text: "Tea 9 invented credits.",
          }),
        ),
        "conflict",
      );
      const versions = yield* sql<{ body: string; summary: string }>`SELECT body, summary
        FROM kin_doc_versions WHERE record_id = ${doc.row.recordId} ORDER BY version`;
      assert.strictEqual(versions.at(-1)?.summary, 'Changed "Prices" through their coding agent');
      assert.deepStrictEqual(
        versions.map((one) => one.body.includes("Tea 10")),
        [true, false],
      );

      // The company's own list: an entry added once, then changed.
      yield* defineList(
        orgId,
        yield* proposalFor(orgId, {
          name: "Invented samples",
          fields: [{ label: "Colour", type: "text" }],
        }),
        0,
      );
      const listed = (yield* Acts.listLists(rheaKey)).lists.find(
        (one) => one.name === "Invented samples",
      );
      assert.isDefined(listed);
      // By hand, as in the app, entries go only on a list shared with the team.
      const refusedEntry = yield* Effect.flip(
        Acts.addEntry(rheaKey, { list: listed!.list, title: "Invented: too early" }),
      );
      assert.include(refusedEntry.message, "shared with the team");
      const rheaPerson = [{ _tag: "person" as const, orgId, personId: rhea.personId }];
      const definition = (yield* lists(rheaPerson, { orgId })).lists.find(
        (one) => one.list === listed!.list,
      );
      yield* updateList(rheaPerson, {
        orgId,
        list: listed!.list,
        rev: definition!.rev,
        team: true,
      });
      const entry = {
        list: listed!.list,
        title: "Invented: oak sample",
        fields: { colour: "Oak" },
      };
      const added = yield* Acts.addEntry(rheaKey, entry);
      assert.strictEqual((yield* Acts.addEntry(rheaKey, entry)).key, added.key);
      assert.strictEqual(
        (yield* Acts.updateEntry(rheaKey, { key: added.key, state: "done" })).state,
        "done",
      );
      assert.deepStrictEqual(
        (yield* Acts.listEntries(rheaKey, { list: listed!.list, state: "done" })).entries.map(
          (one) => one.key,
        ),
        [added.key],
      );
      assert.isTrue((yield* marks(added.key)).every((viaKey) => viaKey === rheaKey.sessionId));

      // What Zoya's screens refuse, her key is refused: making a project, and a client labelled
      // private.
      assert.strictEqual(
        yield* reason(createProject(zoyaKey, { title: "Invented: taxi" })),
        "not_allowed",
      );
      yield* records.update(orgId, writerFor(rhea.personId), lantern, { sensitive: true });
      for (const refused of [
        Acts.updateClient(rheaKey, { key: lantern, notes: "Invented" }),
        Acts.logContact(rheaKey, { client: lantern, kind: "call" }),
        Acts.addPromise(rheaKey, { client: lantern, what: "Invented" }).pipe(Effect.asVoid),
      ])
        assert.strictEqual(yield* reason(refused), "not_found");
      assert.isFalse(
        (yield* Acts.listWaiting(rheaKey)).waiting.some((one) => one.key === promise.key),
      );

      // Revoked, it does nothing more.
      yield* TasksKeys.revoke(rhea.app, { orgId, sessionId: rheaKey.sessionId });
      assert.strictEqual(
        yield* reason(Acts.createClient(rheaKey, { name: "Invented after" })),
        "not_allowed",
      );
      assert.strictEqual(yield* count("Invented after"), 0);
    }).pipe(Effect.provide(layer)),
);

const decodeHead = Schema.decodeUnknownSync(MemoryItemHead);
const writerFor = (personId: KinPersonId) => ({
  actor: { _tag: "person" as const, personId },
  via: "owner" as const,
  askedBy: personId,
});

it.effect(
  "nothing labelled sensitive reaches a key, whoever holds it, nor what sits under a labelled client or project",
  () =>
    Effect.gen(function* () {
      const { orgId, rhea, zoya, arjun } = yield* team;
      const records = yield* Records.KinRecords;
      const people = yield* People.KinPeople;
      const sql = yield* SqlClient.SqlClient;
      yield* people.setAccess(rhea.app, { orgId, personId: zoya.personId, access: "co_owner" });
      const make = (originKey: string, fields: Partial<Records.CreateInput> = {}) =>
        records
          .create(orgId, writerFor(rhea.personId), {
            originKey,
            title: `Invented: ${originKey}`,
            owner: { _tag: "person", personId: zoya.personId },
            ...fields,
          })
          .pipe(Effect.map(({ row }) => row));
      const label = (key: string) =>
        records.update(orgId, writerFor(rhea.personId), key, { sensitive: true });
      const audit = yield* make("quiet audit", { list: "projects" });
      const client = yield* make("Invented Lanterns", { list: "clients" });
      const quietClient = yield* make("Invented Kilns", { list: "clients", sensitive: true });
      const theirs = yield* make("kiln launch", {
        list: "projects",
        partyId: quietClient.recordId,
      });
      const secret = yield* make("salary review", { sensitive: true });
      const plain = yield* make("order clay");
      const underProject = yield* make("file the audit", { projectId: audit.recordId });
      const underClient = yield* make("send the quote", { partyId: client.recordId });
      const underTheirs = yield* make("book the hall", { projectId: theirs.recordId });
      // A promise sits on its deal (`promises.ts`): kept private, the deal takes it with it.
      const owner = [{ _tag: "person" as const, orgId, personId: rhea.personId }];
      const deal = yield* Deals.create(owner, {
        orgId,
        party: client.key,
        title: "Invented kiln order",
        clientRequestId: "kiln-order",
      });
      const promised = yield* make("send the kiln plan", {
        partyId: client.recordId,
        category: "obligation",
        links: [dealLink({ recordId: deal.deal.recordId, key: deal.deal.key })],
      });
      const key = yield* admitted((yield* TasksKeys.issue(zoya.app, { orgId })).secret);
      const listed = Effect.map(listMine(key), ({ tasks }) => tasks.map((one) => one.key));
      assert.includeMembers(yield* listed, [
        plain.key,
        underProject.key,
        underClient.key,
        promised.key,
      ]);
      yield* Deals.update(owner, {
        orgId,
        key: deal.deal.key,
        rev: deal.deal.rev,
        sensitive: true,
      });
      assert.notInclude(yield* listed, promised.key);

      // Labelled after the key was made, the project and the client take their tasks with them.
      yield* label(audit.key);
      yield* label(client.key);
      assert.deepStrictEqual(yield* listMine(key), {
        tasks: [
          {
            key: plain.key,
            title: "Invented: order clay",
            state: "open",
            due: null,
            project: null,
          },
        ],
        more: false,
        material: MATERIAL,
      });
      for (const hidden of [secret, underProject, underClient, underTheirs, promised]) {
        assert.strictEqual(yield* reason(getMine(key, hidden.key)), "not_found");
        assert.strictEqual(
          yield* reason(setStateMine(key, { key: hidden.key, state: "done" })),
          "not_found",
        );
        assert.strictEqual(
          yield* reason(commentMine(key, { key: hidden.key, text: "Invented: done" })),
          "not_found",
        );
        assert.strictEqual((yield* records.get(orgId, hidden.key))?.state, "open");
        assert.lengthOf(
          yield* sql`SELECT 1 FROM kin_record_comments WHERE record_id = ${hidden.recordId}`,
          0,
        );
      }

      // Every other tool too: what its person's screens show, minus what a person labelled, for
      // the owner's key, a co-owner's (Zoya), a lead's (Dev) and a member's (Arjun, no Money).
      const sessions = yield* SessionStore;
      const invite = yield* people.createInvite(rhea.app, { orgId, displayName: "Dev Malhotra" });
      const dev = yield* people.accept({ secret: invite.secret });
      const devApp = yield* sessions.verify(dev.accessToken);
      yield* make("glaze line", {
        list: "projects",
        owner: { _tag: "person", personId: dev.person.personId },
      });
      yield* sql`UPDATE kin_people SET sees_money = 0 WHERE person_id = ${arjun.personId}`;
      // Expenses are labelled by their list, which is no person's choice: one under an unlabelled
      // client reaches a key whose person has Money; one under the labelled client reaches none.
      // A doc sits under the labelled client.
      yield* sql`INSERT INTO kin_registers (org_id, register_id, name, key_prefix, built_in,
          created_at, definition_json)
        VALUES (${orgId}, 'expenses', 'Expenses', 'EXP', 0, 0,
          ${JSON.stringify(presetDefinition("expenses", "INR"))})`;
      const potters = yield* make("Invented Potters", { list: "clients" });
      const glaze = yield* make("glaze bill", {
        list: "expenses",
        owner: { _tag: "person", personId: rhea.personId },
        partyId: potters.recordId,
        amount: { minor: 1_717_100, currency: "INR" },
        state: "done",
        dateAt: 0,
      });
      const rent = yield* make("kiln rent", {
        list: "expenses",
        owner: { _tag: "person", personId: rhea.personId },
        partyId: quietClient.recordId,
        amount: { minor: 4_242_400, currency: "INR" },
        state: "done",
        dateAt: 0,
      });
      assert.strictEqual((yield* records.get(orgId, glaze.key))?.sensitive, 1);
      // Marked private by a person on purpose: at creation, and on one the default had labelled.
      const fees = yield* make("legal fees", {
        list: "expenses",
        owner: { _tag: "person", personId: rhea.personId },
        partyId: potters.recordId,
        amount: { minor: 6_060_600, currency: "INR" },
        state: "done",
        dateAt: 0,
        sensitive: true,
      });
      const bonus = yield* make("bonus", {
        list: "expenses",
        owner: { _tag: "person", personId: rhea.personId },
        partyId: potters.recordId,
        amount: { minor: 7_070_700, currency: "INR" },
        state: "done",
        dateAt: 0,
      });
      yield* records.update(orgId, writerFor(rhea.personId), bonus.key, { sensitive: true });
      const { row: kilnTerms } = yield* Docs.create(
        orgId,
        writerFor(rhea.personId),
        {},
        {
          title: "Invented: kiln terms",
          body: "Invented terms.\n",
          owner: { _tag: "person", personId: rhea.personId },
          summary: "Created",
          partyId: quietClient.recordId,
          originKey: "kiln terms",
        },
      );
      const head = (id: string) =>
        decodeHead({
          id,
          orgId,
          path: `claims/${id}.md`,
          kind: "claim",
          title: `Invented kiln ${id}`,
          status: "open",
          due: null,
          recorded_at: "1970-01-01T00:00:00.000Z",
          valid_from: "1970-01-01T00:00:00.000Z",
          invalid_at: null,
          superseded_by: null,
          review_by: null,
          source: "fixture",
          said_by: "Rhea",
          trust: "owner",
          links: [],
          sensitive: false,
        });
      const items = [
        { head: head("price"), body: "Invented price.\n" },
        { head: head("day"), body: "Invented day.\n" },
      ];
      yield* (yield* KinMemoryChanges).attachWriter({
        undo: () => Effect.die("Unused"),
        retire: () => Effect.die("Unused"),
        restore: () => Effect.die("Unused"),
        recordDecision: () => Effect.die("Unused"),
        relabel: () => Effect.die("Unused"),
        items: () => Effect.die("A key read must not load memory"),
        snapshot: () => Effect.succeed(items),
      });
      // "Only you": the price. The day the team may know.
      yield* authorise(orgId, "day", fingerprint(items[1]!), "owner_setting");
      // Rhea's own screen counts every expense, so the rent and the two she marked are there to
      // leave out; the mark is recorded on the one the default had already labelled.
      assert.deepStrictEqual(
        (yield* money([{ _tag: "person", orgId, personId: rhea.personId }], { orgId })).spent
          .thisMonth.total,
        [{ minor: 19_090_800, currency: "INR" }],
      );
      assert.strictEqual((yield* records.get(orgId, bonus.key))?.markedBy, rhea.personId);
      const labelled = [
        quietClient,
        client,
        audit,
        theirs,
        secret,
        underProject,
        underClient,
        underTheirs,
        rent,
        fees,
        bonus,
        kilnTerms,
      ];
      const never = [
        ...labelled.flatMap((one) => [JSON.stringify(one.key), JSON.stringify(one.title)]),
        "Invented kiln price",
        "4242400",
        "6060600",
        "7070700",
      ];
      const answer = <A, R>(read: Effect.Effect<A, KinChatError, R>) =>
        Effect.match(read, {
          onFailure: (error): unknown => error,
          onSuccess: (value): unknown => value,
        });
      const keys = {
        rhea: yield* admitted((yield* TasksKeys.issue(rhea.app, { orgId })).secret),
        zoya: key,
        dev: yield* admitted((yield* TasksKeys.issue(devApp, { orgId })).secret),
        arjun: yield* admitted((yield* TasksKeys.issue(arjun.app, { orgId })).secret),
      };
      for (const holder of Object.values(keys)) {
        const answers = [
          yield* answer(listMine(holder)),
          yield* answer(getMine(holder, secret.key)),
          yield* answer(listProjects(holder, {})),
          yield* answer(listProjects(holder, { text: "audit" })),
          yield* answer(listClients(holder, {})),
          yield* answer(findDocs(holder, {})),
          yield* answer(findDocs(holder, { client: quietClient.key })),
          yield* answer(openProject(holder, audit.key)),
          yield* answer(openProject(holder, theirs.key)),
          yield* answer(openClient(holder, quietClient.key)),
          yield* answer(openClient(holder, client.key)),
          yield* answer(readDoc(holder, { key: kilnTerms.key })),
          yield* answer(moneySummary(holder)),
          yield* answer(searchMemory(holder, "kiln")),
        ];
        const said = JSON.stringify(answers);
        for (const one of never) assert.notInclude(said, one);
        for (const opened of answers.slice(7, 12))
          if (opened instanceof Error && "reason" in opened && opened.reason === "not_found")
            assert.strictEqual(JSON.stringify(opened), JSON.stringify(unknownKey));
      }
      // The owner's key opens each labelled one as one never there, and says money was left out.
      for (const opened of [
        yield* Effect.flip(openClient(keys.rhea, quietClient.key)),
        yield* Effect.flip(openProject(keys.rhea, audit.key)),
        yield* Effect.flip(readDoc(keys.rhea, { key: kilnTerms.key })),
      ])
        assert.strictEqual(JSON.stringify(opened), JSON.stringify(unknownKey));
      // Those with Money read the list-labelled expense, the rent under the labelled client left
      // out and counted; a member without Money reads no money at all.
      for (const holder of [keys.rhea, keys.zoya]) {
        const figures = yield* moneySummary(holder);
        assert.deepStrictEqual(figures.spent.thisMonth.total, [
          { minor: 1_717_100, currency: "INR" },
        ]);
        assert.isTrue(figures.privateLeftOut);
      }
      assert.strictEqual((yield* Effect.flip(moneySummary(keys.arjun))).reason, "not_allowed");
      assert.deepStrictEqual(
        (yield* searchMemory(keys.rhea, "kiln")).lines.map((line) => line.title),
        ["Invented kiln day"],
      );
    }).pipe(Effect.provide(MemoryChanges.layer.pipe(Layer.provideMerge(layer)))),
);

it.effect("a key's list is soonest due first and counts only what it may show", () =>
  Effect.gen(function* () {
    const { orgId, rhea, zoya } = yield* team;
    const records = yield* Records.KinRecords;
    const day = (n: number) => Date.parse("2026-12-01T10:00:00.000Z") + n * 86_400_000;
    const make = (n: number, fields: Partial<Records.CreateInput> = {}) =>
      records
        .create(orgId, writerFor(rhea.personId), {
          originKey: `task ${n}`,
          title: `Invented: task ${n}`,
          owner: { _tag: "person", personId: zoya.personId },
          dueAt: day(n),
          ...fields,
        })
        .pipe(Effect.map(({ row }) => row));
    // Soonest of all, but labelled or under a labelled project: no place in the hundred, no `more`.
    yield* make(0, { sensitive: true });
    const quiet = (yield* records.create(orgId, writerFor(rhea.personId), {
      originKey: "quiet audit",
      title: "Invented: quiet audit",
      list: "projects",
      owner: writerFor(rhea.personId).actor,
      sensitive: true,
    })).row;
    yield* make(-1, { projectId: quiet.recordId });
    const open: Array<string> = [];
    for (let n = 1; n <= 100; n++) open.push((yield* make(n)).key);
    // Under way, but due last: due date orders the list, not state.
    yield* records.update(orgId, writerFor(rhea.personId), open[99]!, { state: "doing" });
    const key = yield* admitted((yield* TasksKeys.issue(zoya.app, { orgId })).secret);
    const listed = yield* listMine(key);
    assert.strictEqual(listed.more, false);
    assert.deepStrictEqual(
      listed.tasks.map((one) => one.key),
      open,
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a key acts only while its person has a screen to act from, as that screen reads now",
  () =>
    Effect.gen(function* () {
      const { orgId, rhea, zoya, arjun } = yield* team;
      const records = yield* Records.KinRecords;
      const people = yield* People.KinPeople;
      const sql = yield* SqlClient.SqlClient;
      const project = (yield* records.create(orgId, writerFor(rhea.personId), {
        originKey: "launch",
        title: "Invented: launch",
        list: "projects",
        owner: writerFor(rhea.personId).actor,
      })).row;
      const make = (
        originKey: string,
        owner: KinPersonId,
        fields: Partial<Records.CreateInput> = {},
      ) =>
        records
          .create(orgId, writerFor(rhea.personId), {
            originKey,
            title: `Invented: ${originKey}`,
            owner: { _tag: "person", personId: owner },
            ...fields,
          })
          .pipe(Effect.map(({ row }) => row));
      const hall = yield* make("book the hall", zoya.personId, { projectId: project.recordId });
      const weekly = yield* make("weekly report", zoya.personId, {
        dueAt: Date.parse("2026-12-01T10:00:00.000Z"),
        repeat: { every: "days", days: 7 },
      });
      yield* people.setAccess(rhea.app, { orgId, personId: zoya.personId, access: "co_owner" });
      const key = yield* admitted((yield* TasksKeys.issue(zoya.app, { orgId })).secret);
      // A co-owner sees every project; made a member, the next call names only one she is on.
      assert.strictEqual((yield* getMine(key, hall.key)).project, "Invented: launch");
      yield* people.setAccess(rhea.app, { orgId, personId: zoya.personId, access: "member" });
      assert.isNull((yield* getMine(key, hall.key)).project);
      // A member's list is what her own Work screen gives her, held and open.
      const screen = yield* Work.list([{ _tag: "person", orgId, personId: zoya.personId }], {
        orgId,
        owner: { _tag: "person", personId: zoya.personId },
        open: true,
      });
      assert.deepStrictEqual(
        (yield* listMine(key)).tasks.map((one) => one.key).toSorted(),
        screen.records.map((one) => one.key).toSorted(),
      );
      // Finishing a repeating task makes its next one, as on her screen.
      yield* setStateMine(key, { key: weekly.key, state: "done" });
      assert.lengthOf(
        (yield* listMine(key)).tasks.filter((one) => one.title === "Invented: weekly report"),
        1,
      );
      assert.notInclude(
        (yield* listMine(key)).tasks.map((one) => one.key),
        weekly.key,
      );

      // Every device she was let in on revoked, the key's maker kept: no screen, so no key.
      yield* sql`UPDATE kin_session_bindings SET revoked_at = 1 WHERE person_id = ${zoya.personId}`;
      assert.strictEqual(
        yield* reason(setStateMine(key, { key: hall.key, state: "doing" })),
        "not_allowed",
      );
      assert.strictEqual(yield* reason(getMine(key, hall.key)), "not_allowed");
      assert.strictEqual(yield* reason(listMine(key)), "not_allowed");
      assert.strictEqual(
        yield* reason(commentMine(key, { key: hall.key, text: "Invented: started" })),
        "not_allowed",
      );
      assert.strictEqual((yield* records.get(orgId, hall.key))?.state, "open");

      // Removed, a call admitted before it reaches nothing.
      const arjunKey = yield* admitted((yield* TasksKeys.issue(arjun.app, { orgId })).secret);
      yield* people.removeAccess(rhea.app, { orgId, personId: arjun.personId });
      assert.strictEqual(yield* reason(listMine(arjunKey)), "not_allowed");
    }).pipe(Effect.provide(layer)),
);

it.effect("a key outlives its person's idle devices, and ends only by its own date or an end", () =>
  Effect.gen(function* () {
    const { orgId, rhea, zoya } = yield* team;
    const records = yield* Records.KinRecords;
    const sessions = yield* SessionStore;
    const task = (yield* records.create(orgId, writerFor(rhea.personId), {
      originKey: "glaze order",
      title: "Invented: glaze order",
      owner: { _tag: "person", personId: zoya.personId },
    })).row;
    yield* TestClock.adjust("1 day");
    const key = yield* admitted((yield* TasksKeys.issue(zoya.app, { orgId })).secret);
    yield* TestClock.adjust("29 days");
    yield* TestClock.adjust("12 hours");
    assert.isTrue((yield* Effect.exit(sessions.verify(zoya.token)))._tag === "Failure");
    // On purpose: a key is its own credential, so not opening Kin for a month must not end it.
    assert.deepStrictEqual(
      (yield* listMine(key)).tasks.map((one) => one.key),
      [task.key],
    );
    assert.strictEqual((yield* getMine(key, task.key)).key, task.key);
    yield* setStateMine(key, { key: task.key, state: "doing" });
    assert.strictEqual(
      (yield* commentMine(key, { key: task.key, text: "Invented: on it" })).key,
      task.key,
    );
    assert.strictEqual((yield* records.get(orgId, task.key))?.state, "doing");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "a removal that commits while a key is being made leaves no key, even after rejoining",
  () =>
    Effect.gen(function* () {
      const { orgId, rhea, zoya } = yield* team;
      const identity = yield* KinIdentity;
      const people = yield* People.KinPeople;
      const sql = yield* SqlClient.SqlClient;
      // Rhea removes Zoya just after Zoya's call is resolved to her, before its key is made.
      const removedMidway = {
        ...identity,
        resolve: (session: AuthenticatedSession) =>
          identity
            .resolve(session)
            .pipe(
              Effect.tap(() =>
                people
                  .removeAccess(rhea.app, { orgId, personId: zoya.personId })
                  .pipe(Effect.provideService(KinIdentity, identity), Effect.orDie),
              ),
            ),
      };
      assert.strictEqual(
        yield* reason(
          TasksKeys.issue(zoya.app, { orgId }).pipe(
            Effect.provideService(KinIdentity, removedMidway),
          ),
        ),
        "not_allowed",
      );
      const keyRows = sql`SELECT session_id FROM kin_tasks_keys WHERE person_id = ${zoya.personId}`;
      assert.deepStrictEqual(yield* keyRows, []);
      // Brought back, she holds no key until she makes one.
      const invite = yield* people.createInvite(rhea.app, {
        orgId,
        displayName: "Zoya",
        personId: zoya.personId,
      });
      const back = yield* people.accept({ secret: invite.secret });
      const app = yield* (yield* SessionStore).verify(back.accessToken);
      assert.deepStrictEqual((yield* TasksKeys.list(app, { orgId })).keys, []);
      assert.deepStrictEqual(yield* keyRows, []);
    }).pipe(Effect.provide(layer)),
);

it.effect("a key ends at once when revoked, by its holder or the owner and nobody else", () =>
  Effect.gen(function* () {
    const { orgId, rhea, zoya, arjun } = yield* team;
    const records = yield* Records.KinRecords;
    const sql = yield* SqlClient.SqlClient;
    const { row: hers } = yield* records.create(
      orgId,
      { actor: { _tag: "person", personId: rhea.personId }, via: "owner", askedBy: rhea.personId },
      {
        originKey: "hers",
        title: "Invented: call the caterer",
        owner: { _tag: "person", personId: zoya.personId },
      },
    );
    const zoyas = yield* TasksKeys.issue(zoya.app, { orgId });
    const arjuns = yield* TasksKeys.issue(arjun.app, { orgId });
    const holder = yield* admitted(zoyas.secret);
    const revoke = (by: AuthenticatedSession, sessionId: AuthSessionId) =>
      TasksKeys.revoke(by, { orgId, sessionId });
    assert.strictEqual(yield* reason(revoke(arjun.app, zoyas.key.sessionId)), "not_found");
    assert.deepStrictEqual(yield* revoke(zoya.app, zoyas.key.sessionId), { revoked: true });
    assert.isTrue(Option.isNone(yield* TasksKeys.admit(zoyas.secret)));
    // A call admitted before the revoke writes nothing after it.
    assert.strictEqual(
      yield* reason(commentMine(holder, { key: hers.key, text: "Invented: late" })),
      "not_allowed",
    );
    // An ended key hears the same whether or not the entry exists.
    for (const key of [hers.key, "W-9999"])
      assert.strictEqual(
        yield* reason(commentMine(holder, { key, text: "Invented: late" })),
        "not_allowed",
      );
    assert.strictEqual(
      yield* reason(setStateMine(holder, { key: hers.key, state: "done" })),
      "not_allowed",
    );
    assert.lengthOf(
      yield* sql`SELECT 1 FROM kin_record_comments WHERE record_id = ${hers.recordId}`,
      0,
    );
    assert.strictEqual((yield* records.get(orgId, hers.key))?.state, "open");
    assert.deepStrictEqual((yield* TasksKeys.list(zoya.app, { orgId })).keys, []);
    assert.strictEqual(yield* reason(revoke(zoya.app, zoyas.key.sessionId)), "not_found");
    // The owner ends anyone's.
    assert.deepStrictEqual(yield* revoke(rhea.app, arjuns.key.sessionId), { revoked: true });
    assert.isTrue(Option.isNone(yield* TasksKeys.admit(arjuns.secret)));
    // Its T3 session is gone too, so nothing else could take it.
    const sessions = yield* SessionStore;
    assert.strictEqual(
      (yield* sessions
        .verify(arjuns.secret)
        .pipe(Effect.provideService(TasksKeyAudience, true), Effect.result))._tag,
      "Failure",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "making or removing a key moves people once it commits, and a refusal moves nothing",
  () =>
    Effect.gen(function* () {
      const { orgId, rhea, zoya, arjun } = yield* team;
      const hub = yield* RefreshHub.KinRefreshHub;
      const heard = yield* Stream.toQueue(hub.changes(orgId), { capacity: "unbounded" });
      const start = (yield* Queue.take(heard)).people;
      const moved = Effect.gen(function* () {
        yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
        return (yield* Queue.take(heard)).people;
      });
      const made = yield* TasksKeys.issue(zoya.app, { orgId });
      assert.strictEqual(yield* moved, start + 1);
      yield* TasksKeys.revoke(zoya.app, { orgId, sessionId: made.key.sessionId });
      assert.strictEqual(yield* moved, start + 2);
      // At the limit the issue rolls back after its touch; nobody hears of it.
      for (let n = 0; n < 3; n++) yield* TasksKeys.issue(zoya.app, { orgId });
      assert.strictEqual(yield* moved, start + 5);
      assert.strictEqual(yield* reason(TasksKeys.issue(zoya.app, { orgId })), "limit");
      yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
      assert.strictEqual(yield* Queue.size(heard), 0);
      // A sign-out outside Kin that ends her phone and its keys moves people once it commits.
      const sessions = yield* SessionStore;
      const signOut = sessions.revoke(zoya.app.sessionId);
      const rolledBack = yield* (yield* SqlClient.SqlClient)
        .withTransaction(signOut.pipe(Effect.andThen(Effect.fail("invented rollback"))))
        .pipe(Effect.flip);
      assert.strictEqual(rolledBack, "invented rollback");
      yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
      assert.strictEqual(yield* Queue.size(heard), 0);
      assert.isTrue(yield* signOut);
      assert.strictEqual(yield* moved, start + 6);
      // Sharing & access signs out a key's own session, or every session but the owner's app.
      yield* sessions.revoke(arjun.app.sessionId);
      assert.strictEqual(yield* moved, start + 7);
      const rheas = yield* TasksKeys.issue(rhea.app, { orgId });
      yield* TasksKeys.issue(rhea.app, { orgId });
      assert.strictEqual(yield* moved, start + 9);
      const single = sessions.revoke(rheas.key.sessionId, rhea.app.sessionId);
      yield* (yield* SqlClient.SqlClient)
        .withTransaction(single.pipe(Effect.andThen(Effect.fail("invented rollback"))))
        .pipe(Effect.flip);
      yield* TestClock.adjust(RefreshHub.KIN_REFRESH_SETTLE);
      assert.strictEqual(yield* Queue.size(heard), 0);
      assert.isTrue(yield* single);
      assert.strictEqual(yield* moved, start + 10);
      assert.strictEqual(yield* sessions.revokeAllExcept(rhea.app.sessionId), 1);
      assert.strictEqual(yield* moved, start + 11);
      assert.deepStrictEqual((yield* TasksKeys.list(rhea.app, { orgId })).keys, []);
    }).pipe(Effect.scoped, Effect.provide(RefreshHub.layer.pipe(Layer.provideMerge(layer)))),
);

it.effect("Remove is offered exactly where revoke would take it", () =>
  Effect.gen(function* () {
    const { orgId, rhea, zoya, arjun } = yield* team;
    const people = yield* People.KinPeople;
    const sessions = yield* SessionStore;
    const invite = yield* people.createInvite(rhea.app, { orgId, displayName: "Meera" });
    const joined = yield* people.accept({ secret: invite.secret });
    const meera = {
      personId: joined.person.personId,
      app: yield* sessions.verify(joined.accessToken),
    };
    for (const co of [zoya, meera])
      yield* people.setAccess(rhea.app, { orgId, personId: co.personId, access: "co_owner" });
    const rows = [
      ["her own key", zoya, zoya, true],
      ["the owner, a co-owner's", rhea, zoya, true],
      ["a co-owner, the owner's", zoya, rhea, false],
      ["a co-owner, another co-owner's", zoya, meera, false],
      ["a co-owner, a member's", zoya, arjun, true],
      ["a member, a co-owner's", arjun, zoya, false],
    ] as const;
    for (const [name, viewer, holder, expected] of rows) {
      const { key } = yield* TasksKeys.issue(holder.app, { orgId });
      const listed = yield* Effect.result(
        TasksKeys.list(viewer.app, { orgId, personId: holder.personId }),
      );
      // A member can't read another person's keys at all, so is offered nothing.
      const offered =
        listed._tag === "Success"
          ? listed.success.keys.find((one) => one.sessionId === key.sessionId)?.canRevoke
          : false;
      const revoked = yield* Effect.result(
        TasksKeys.revoke(viewer.app, { orgId, sessionId: key.sessionId }),
      );
      assert.deepStrictEqual(
        [name, offered, revoked._tag === "Success"],
        [name, expected, expected],
      );
    }
  }).pipe(Effect.provide(layer)),
);

it.effect("removing a device ends the keys made on it and down its chain, and nothing else", () =>
  Effect.gen(function* () {
    const { orgId, rhea, zoya } = yield* team;
    const people = yield* People.KinPeople;
    const sessions = yield* SessionStore;
    const sql = yield* SqlClient.SqlClient;
    const linkFrom = Effect.fn("test.linkFrom")(function* (from: AuthenticatedSession) {
      const link = yield* people.linkDevice(from, { orgId });
      const joined = yield* people.accept({ secret: link.secret });
      return yield* sessions.verify(joined.accessToken);
    });
    const keyOn = Effect.fn("test.keyOn")(function* (device: AuthenticatedSession) {
      return (yield* TasksKeys.issue(device, { orgId })).secret;
    });
    const works = (secret: string) => TasksKeys.admit(secret).pipe(Effect.map(Option.isSome));
    const remove = (by: AuthenticatedSession, device: AuthenticatedSession) =>
      people.revokeDevice(by, { orgId, personId: zoya.personId, sessionId: device.sessionId });

    const laptop = yield* linkFrom(zoya.app);
    const onPhone = yield* keyOn(zoya.app);
    const onLaptop = yield* keyOn(laptop);
    // A key made before keys recorded their maker.
    const unrecorded = yield* keyOn(laptop);
    const { sessionId: unrecordedId } = yield* admitted(unrecorded);
    yield* sql`UPDATE kin_tasks_keys SET made_by_session_id = NULL WHERE session_id = ${unrecordedId}`;
    // Remove says which keys go with a device: only the live ones it made.
    const made = Effect.fn("test.made")(function* (by: AuthenticatedSession) {
      const { devices } = yield* people.listDevices(by, { orgId, personId: zoya.personId });
      return new Map(devices.map((one) => [one.sessionId, one.keysMade]));
    });
    assert.deepStrictEqual(
      yield* made(rhea.app),
      new Map([
        [zoya.app.sessionId, 1],
        [laptop.sessionId, 1],
      ]),
    );

    // A key with no recorded maker is no key: no device's removal could end it.
    assert.isFalse(yield* works(unrecorded));
    // The phone removes the laptop: the laptop's key ends, the phone's stays.
    yield* remove(zoya.app, laptop);
    assert.deepStrictEqual(yield* Effect.forEach([onPhone, onLaptop, unrecorded], works), [
      true,
      false,
      false,
    ]);
    assert.lengthOf((yield* TasksKeys.list(zoya.app, { orgId })).keys, 1);

    // A device that merely lapses ends none of its keys.
    const strap = yield* linkFrom(yield* linkFrom(zoya.app));
    const onStrap = yield* keyOn(strap);
    // The test clock starts at the epoch, so only a time before it has passed.
    yield* sql`UPDATE auth_sessions SET expires_at = '1969-12-31T00:00:00.000Z'
      WHERE session_id = ${strap.sessionId}`;
    assert.isTrue(yield* works(onStrap));

    // Nor does one signed out some other way, leaving its key working. (Three keys at most, so
    // the phone's goes first: the laptop already showed a device's own key ending.)
    yield* TasksKeys.revoke(zoya.app, { orgId, sessionId: (yield* admitted(onPhone)).sessionId });
    const watch = yield* linkFrom(zoya.app);
    const onWatch = yield* keyOn(watch);
    yield* sql`UPDATE auth_sessions SET revoked_at = '2026-01-01T00:00:00.000Z'
      WHERE session_id = ${watch.sessionId}`;
    assert.isTrue(yield* works(onWatch));

    // The owner removes her first phone: every key made down its chain ends, two links down,
    // lapsed or already signed out too.
    yield* remove(rhea.app, zoya.app);
    assert.deepStrictEqual(yield* Effect.forEach([onStrap, onWatch, unrecorded], works), [
      false,
      false,
      false,
    ]);
    assert.deepStrictEqual(
      (yield* TasksKeys.list(rhea.app, { orgId, personId: zoya.personId })).keys,
      [],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "blocking a device's proof key ends the keys its earlier sessions made, and only that",
  () =>
    Effect.gen(function* () {
      const { orgId } = yield* team;
      const sessions = yield* SessionStore;
      const sql = yield* SqlClient.SqlClient;
      const works = (secret: string) => TasksKeys.admit(secret).pipe(Effect.map(Option.isSome));
      // Rhea's phone renews into a new session for the same proof key; the one before lapses.
      const renew = Effect.fn("test.renew")(function* () {
        const issued = yield* sessions.issue({
          subject: "browser",
          proofKeyThumbprint: "invented-phone",
        });
        yield* pairSession(issued.sessionId);
        const app = yield* sessions.verify(issued.token);
        return { app, key: (yield* TasksKeys.issue(app, { orgId })).secret };
      });
      // The test clock starts at the epoch: a second on, a session that ran out then has lapsed.
      yield* TestClock.adjust("1 second");
      const lapse = (app: AuthenticatedSession) =>
        sql`UPDATE auth_sessions SET expires_at = '1970-01-01T00:00:00.000Z'
        WHERE session_id = ${app.sessionId}`;
      const first = yield* renew();
      yield* lapse(first.app);
      const second = yield* renew();
      yield* lapse(second.app);
      // Signing out a lapsed session blocks no key, so it reaches no other session's keys.
      yield* sessions.revoke(first.app.sessionId);
      assert.deepStrictEqual(yield* Effect.forEach([first.key, second.key], works), [false, true]);
      // The managed policy or the host CLI signs out the active one, which blocks the phone's key.
      const current = yield* renew();
      yield* sessions.revoke(current.app.sessionId);
      assert.deepStrictEqual(yield* Effect.forEach([second.key, current.key], works), [
        false,
        false,
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect("a host CLI revoke tells open lists once it commits, and a rollback tells nobody", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "kin-tasks-cli-" }));
    const { orgId, zoya } = yield* Effect.gen(function* () {
      const made = yield* team;
      const sessions = yield* SessionStore;
      yield* TasksKeys.issue(made.zoya.app, { orgId: made.orgId });
      // Rhea's phone, holding a proof key, as `auth connect-device revoke` ends one.
      const phone = yield* sessions.issue({ subject: "browser", proofKeyThumbprint: "invented" });
      yield* pairSession(phone.sessionId);
      yield* TasksKeys.issue(yield* sessions.verify(phone.token), { orgId: made.orgId });
      return made;
    }).pipe(Effect.provide(layerAt(dir)));
    const told = <A, E>(revoke: Effect.Effect<A, E, SessionStore | SqlClient.SqlClient>) =>
      Effect.gen(function* () {
        const changes = cliCommits();
        yield* Effect.result(revoke).pipe(
          Effect.provide(
            CliAuth.layerRuntimeWith(changes.layer).pipe(
              Layer.provide(
                Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} })),
              ),
              Layer.provide(ServerConfig.layerTest(process.cwd(), dir)),
              Layer.provide(NodeCrypto.layer),
            ),
          ),
        );
        return changes.all();
      });
    const people = [{ orgId, topics: ["people"], records: false }];
    const signOut = Effect.flatMap(SessionStore, (sessions) => sessions.revoke(zoya.app.sessionId));
    const rolledBack = Effect.flatMap(SqlClient.SqlClient, (sql) =>
      sql.withTransaction(signOut.pipe(Effect.andThen(Effect.fail("invented rollback")))),
    );
    assert.deepStrictEqual(yield* told(rolledBack), []);
    assert.deepStrictEqual(yield* told(signOut), people);
    assert.deepStrictEqual(
      yield* told(
        Effect.flatMap(SessionStore, (sessions) => sessions.revokeByProofKey("invented")),
      ),
      people,
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("names T3 Connect's tunnel as the address, and nothing while none serves this host", () =>
  Effect.gen(function* () {
    const { orgId, zoya } = yield* team;
    const state = {
      linked: true,
      cloudUserId: "invented-user",
      relayUrl: "wss://relay.example.test",
      relayIssuer: null,
      publishAgentActivity: false,
    };
    const cases = [
      [
        { ...state, tunnelHostname: "ambermill.tunnel.example.test" },
        "https://ambermill.tunnel.example.test",
      ],
      // A relay with no tunnel yet, a revoked link, an unlinked host, and a loopback name.
      [state, undefined],
      [{ ...state, linkRevoked: true, tunnelHostname: "ambermill.tunnel.example.test" }, undefined],
      [{ ...state, linked: false, tunnelHostname: "ambermill.tunnel.example.test" }, undefined],
      [{ ...state, tunnelHostname: "localhost" }, undefined],
    ] as const;
    for (const [linkState, origin] of cases) {
      const cloud = Layer.mock(CloudLink)({ linkState: () => Effect.succeed(linkState) });
      const made = yield* TasksKeys.issue(zoya.app, { orgId }).pipe(Effect.provide(cloud));
      assert.strictEqual(made.origin, origin);
      assert.strictEqual(
        (yield* TasksKeys.list(zoya.app, { orgId }).pipe(Effect.provide(cloud))).origin,
        origin,
      );
      yield* TasksKeys.revoke(zoya.app, { orgId, sessionId: made.key.sessionId });
    }
    // A host without T3 Connect at all says nothing either.
    assert.notProperty(yield* TasksKeys.issue(zoya.app, { orgId }), "origin");
  }).pipe(Effect.provide(layer)),
);

class AuthRoutes extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const request = (token: string, path = "/api/auth/session") =>
  HttpServerRequest.fromWeb(
    new Request(`http://127.0.0.1${path}`, { headers: { authorization: `Bearer ${token}` } }),
  );
const refused = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => result._tag),
  );
/** The status T3's own auth routes give a bearer POST, as a client would see it. */
/** A POST to Kin's GitHub webhook with a bearer token and no GitHub signature. */
const postHook = Effect.fn("test.postHook")(function* (token: string) {
  const http = yield* HttpRouter.toHttpEffect(
    KinGitHubHookHttp.layer.pipe(Layer.provide(NodeCrypto.layer)),
  );
  const sent = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
  yield* HttpEffect.toHandled(http, (_request, response) => Deferred.succeed(sent, response)).pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request(`http://127.0.0.1${KIN_GITHUB_HOOK_ROUTE}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "x-github-event": "issues" },
          body: "{}",
        }),
      ),
    ),
    Effect.provideService(KinServer, {
      taskCardUpdater: Layer.empty,
      services: Option.none(),
      subscribeForViewer: Option.none(),
    }),
    Effect.exit,
  );
  return (yield* Deferred.await(sent)).status;
});

const post = Effect.fn("test.post")(function* (path: string, token: string) {
  const routes = HttpApiBuilder.layer(AuthRoutes).pipe(
    Layer.provide(AuthHttp.layer),
    Layer.provide(AuthHttp.layerAuthenticatedAuth),
    Layer.provide(Layer.succeedContext(yield* Effect.context<EnvironmentAuth | SessionStore>())),
    Layer.provide(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const http = yield* HttpRouter.toHttpEffect(routes);
  const sent = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
  yield* HttpEffect.toHandled(http, (_request, response) => Deferred.succeed(sent, response)).pipe(
    Effect.provideService(
      HttpServerRequest.HttpServerRequest,
      HttpServerRequest.fromWeb(
        new Request(`http://127.0.0.1${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: "{}",
        }),
      ),
    ),
    // Bearer requests read no DPoP state: a store that holds nothing.
    Effect.provide(Layer.mergeAll(NodeCrypto.layer, Layer.mock(ServerSecretStore)({}))),
    Effect.exit,
  );
  return (yield* Deferred.await(sent)).status;
});

it.effect("a key is no credential anywhere but its endpoint: every route and credential read", () =>
  Effect.gen(function* () {
    const { orgId, zoya } = yield* team;
    const auth = yield* EnvironmentAuth;
    const sessions = yield* SessionStore;
    const { key, secret } = yield* TasksKeys.issue(zoya.app, { orgId });
    // A script's bearer session passes every read below, so each refusal is the key's.
    const script = (yield* auth.issueSession({ subject: "script" })).token;
    for (const token of [secret, script]) {
      const expected = token === secret ? "Failure" : "Success";
      assert.strictEqual(yield* refused(auth.authenticateHttpRequest(request(token))), expected);
      for (const use of ["rpc", "media"] as const)
        assert.strictEqual(
          yield* refused(auth.authenticateWebSocketUpgrade(request(token, "/ws"), use)),
          expected,
        );
      assert.strictEqual(
        (yield* auth.getSessionState(request(token))).authenticated,
        token === script,
      );
    }
    // T3's own MCP clients, a ticket minted for the key's session, and signed file URLs.
    assert.strictEqual(yield* refused(auth.authenticateMcpClient(request(secret))), "Failure");
    // OAuth's public revoke route ends only an MCP client's own token; a key is none.
    assert.isFalse(yield* auth.revokeMcpClientToken(secret));
    const ticket = yield* sessions.issueWebSocketToken(key.sessionId);
    assert.strictEqual(
      yield* refused(
        auth.authenticateWebSocketUpgrade(
          HttpServerRequest.fromWeb(new Request(`http://127.0.0.1/ws?wsTicket=${ticket.token}`)),
          "rpc",
        ),
      ),
      "Failure",
    );
    assert.isTrue(Option.isNone(yield* sessions.getActive(key.sessionId)));

    // The route table: each route authenticates with the one middleware a key fails (below), or
    // is public. A public route reads a session only through the reads refused above (the
    // session state, OAuth approval) or takes its own credential: a pairing code, an OAuth code,
    // a relay signature, a webhook token. A new public route fails here until someone decides.
    const open: Array<string> = [];
    HttpApi.reflect(EnvironmentHttpApi, {
      onGroup: () => {},
      onEndpoint: ({ group, endpoint, middleware }) => {
        if (![...middleware].some((one) => one.key === EnvironmentAuthenticatedAuth.key))
          open.push(`${group.identifier} ${endpoint.method} ${endpoint.path}`);
      },
    });
    assert.deepStrictEqual(open.toSorted(), [
      "auth GET /api/auth/session",
      "auth POST /api/auth/browser-session",
      "auth POST /oauth/token",
      "connect POST /api/t3-connect/health",
      "connect POST /api/t3-connect/mint-credential",
      "mcpOAuth GET /.well-known/oauth-authorization-server",
      "mcpOAuth GET /.well-known/oauth-protected-resource",
      "mcpOAuth GET /.well-known/oauth-protected-resource/mcp",
      "mcpOAuth GET /oauth/mcp/authorize",
      "mcpOAuth POST /oauth/mcp/approval",
      "mcpOAuth POST /oauth/mcp/decision",
      "mcpOAuth POST /oauth/mcp/register",
      "mcpOAuth POST /oauth/mcp/revoke",
      "mcpOAuth POST /oauth/mcp/token",
      "metadata GET /.well-known/t3/environment",
      // Authenticates only through authenticateMcpClient, which refuses a key (above).
      "peerLink POST /api/peer-link/client-pairing",
      "webhooks GET /api/hooks/:hookId/:token",
      "webhooks PATCH /api/hooks/:hookId/:token",
      "webhooks POST /api/hooks/:hookId/:token",
      "webhooks PUT /api/hooks/:hookId/:token",
    ]);
    for (const path of ["/api/auth/websocket-ticket", "/api/auth/websocket-ticket/media"]) {
      assert.strictEqual(yield* post(path, secret), 401);
      assert.strictEqual(yield* post(path, script), 200);
    }
    // Kin's routes outside this table: the GitHub App's webhook is public because GitHub calls
    // it; its own credential is GitHub's signature over the body, so no key or session opens it.
    for (const token of [secret, script]) assert.strictEqual(yield* postHook(token), 401);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.effect("a key stays no credential when the same database restarts with Kin off", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "kin-tasks-off-" }));
    const { secret } = yield* Effect.gen(function* () {
      const { orgId, zoya } = yield* team;
      return yield* TasksKeys.issue(zoya.app, { orgId });
    }).pipe(Effect.provide(layerAt(dir)));
    yield* Effect.gen(function* () {
      const auth = yield* EnvironmentAuth;
      // A script's bearer session passes each read, so each refusal is the key's.
      const script = (yield* auth.issueSession({ subject: "script" })).token;
      for (const token of [secret, script]) {
        const works = token === script;
        assert.strictEqual((yield* auth.getSessionState(request(token))).authenticated, works);
        assert.strictEqual(yield* post("/api/auth/websocket-ticket", token), works ? 200 : 401);
        assert.strictEqual(
          yield* refused(auth.authenticateWebSocketUpgrade(request(token, "/ws"), "rpc")),
          works ? "Success" : "Failure",
        );
      }
    }).pipe(Effect.provide(layerAuthTest(dir, "off")));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
