import * as KinShell from "../shell/KinShell.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { assert, it } from "@effect/vitest";
import { Tool } from "effect/ai";
import {
  EnvironmentId,
  KIN_MEMORY_CHANGES_CARD,
  KinAgentId,
  KinChatId,
  KinMemoryChangeCard,
  KinMessageId,
  KinRecordKey,
  KinWidgetId,
  MemoryItemHead,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { McpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Repository from "../chat/KinChatRepository.ts";
import * as MemoryChanges from "../memory/MemoryChanges.ts";
import { authorise, fingerprint } from "../memory/sensitivity.ts";
import * as People from "../people/KinPeople.ts";
import * as Watches from "../watches/KinWatches.ts";
import { watchReader } from "../watches/readRpcs.ts";
import { setBudget } from "../work/budgets.ts";
import * as Docs from "../work/docs.ts";
import * as Goals from "../work/goals.ts";
import * as OwnerDocs from "../work/ownerDocs.ts";
import * as MoneyAnswers from "../work/ownerMoneyAnswers.ts";
import * as Work from "../work/ownerWork.ts";
import { presetList } from "../work/registers.ts";
import { projectNote } from "../work/workComments.ts";
import { KinIdentity } from "../chat/KinIdentity.ts";
import { KinServer, type Services } from "../KinServer.ts";
import { type CreateInput, KinRecords } from "../work/KinRecords.ts";
import * as KinTasksKeyMcp from "./mcp.ts";
import { layer, team } from "./tasksKey.testkit.ts";
import * as TasksKeys from "./TasksKeys.ts";

const decodeTools = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        tools: Schema.Array(
          Schema.Struct({
            name: Schema.String,
            annotations: Schema.Struct({
              readOnlyHint: Schema.Boolean,
              destructiveHint: Schema.Boolean,
              idempotentHint: Schema.Boolean,
              openWorldHint: Schema.Boolean,
            }),
          }),
        ),
      }),
    }),
  ),
);
const initialize = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "invented-agent", version: "1" },
};

const endpoint = Effect.fn("test.keyEndpoint")(function* (
  services: Context.Context<Services>,
  store: SessionStore["Service"],
) {
  const routes = KinTasksKeyMcp.layer.pipe(
    Layer.provide(
      Layer.succeed(KinServer, {
        taskCardUpdater: Layer.empty,
        services: Option.some(services),
        subscribeForViewer: Option.none(),
      }),
    ),
    Layer.provide(Layer.succeed(SessionStore, store)),
    Layer.provide(
      Layer.mock(ServerEnvironment)({
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
      }),
    ),
    Layer.provide(Layer.mock(McpSessionRegistry)({})),
    Layer.provide(ServerSettings.layerTest()),
  );
  const http = yield* HttpRouter.toHttpEffect(routes);
  const call = Effect.fn("test.call")(function* (input: {
    readonly token?: string;
    readonly method: string;
    readonly params: unknown;
    readonly session?: string;
    readonly origin?: string;
  }) {
    const sent = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
    yield* HttpEffect.toHandled(http, (_request, response) =>
      Deferred.succeed(sent, response),
    ).pipe(
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(
          new Request("http://localhost/kin/you/mcp", {
            method: "POST",
            headers: {
              ...(input.token === undefined ? {} : { authorization: `Bearer ${input.token}` }),
              "content-type": "application/json",
              accept: "application/json, text/event-stream",
              ...(input.session === undefined ? {} : { "mcp-session-id": input.session }),
              ...(input.origin === undefined ? {} : { origin: input.origin }),
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: input.method,
              params: input.params,
            }),
          }),
        ),
      ),
      Effect.exit,
    );
    return yield* Deferred.await(sent);
  });
  const text = (response: HttpServerResponse.HttpServerResponse) =>
    Effect.promise(() => HttpServerResponse.toWeb(response).text());
  return { call, text };
});

it.effect(
  "the endpoint serves its tools to a live key, money and memory only to whom they open, and drops it mid-session once revoked",
  () =>
    Effect.gen(function* () {
      const { orgId, zoya, rhea } = yield* team;
      const records = yield* KinRecords;
      yield* records.create(
        orgId,
        {
          actor: { _tag: "person", personId: rhea.personId },
          via: "owner",
          askedBy: rhea.personId,
        },
        {
          originKey: "hall",
          title: "Invented: book the hall",
          owner: { _tag: "person", personId: zoya.personId },
        },
      );
      // Each key check verifies the session once: a count of them is a count of checks.
      const store = yield* SessionStore;
      let verified = 0;
      const counted = SessionStore.of({
        ...store,
        verify: (token) => Effect.sync(() => verified++).pipe(Effect.andThen(store.verify(token))),
      });
      // What the tools read through: Kin's services, as the running server holds them.
      const services = Context.add(
        yield* Effect.context<SqlClient.SqlClient | KinIdentity | KinRecords>(),
        SessionStore,
        counted,
      ) as Context.Context<
        SqlClient.SqlClient | KinIdentity | KinRecords | SessionStore
      > as unknown as Context.Context<Services>;
      const { call, text } = yield* endpoint(services, counted);

      // Nothing but a live key gets in: no token, the owner's full session, a teammate's app.
      const full = (yield* (yield* EnvironmentAuth).issueSession({})).token;
      for (const token of [undefined, full, zoya.token, "not-a-key"])
        assert.strictEqual(
          (yield* call({
            ...(token === undefined ? {} : { token }),
            method: "initialize",
            params: initialize,
          })).status,
          401,
        );
      const issued = yield* TasksKeys.issue(zoya.app, { orgId });
      // A browser page can't use it either.
      assert.strictEqual(
        (yield* call({
          token: issued.secret,
          method: "initialize",
          params: initialize,
          origin: "https://elsewhere.invalid",
        })).status,
        403,
      );
      const opened = yield* call({
        token: issued.secret,
        method: "initialize",
        params: initialize,
      });
      assert.strictEqual(opened.status, 200);
      const session = opened.headers["mcp-session-id"];
      const toolsOf = Effect.fn("test.toolsOf")(function* (token: string) {
        const started = yield* call({ token, method: "initialize", params: initialize });
        const id = started.headers["mcp-session-id"];
        const listed = yield* call({
          token,
          method: "tools/list",
          params: {},
          ...(id === undefined ? {} : { session: id }),
        });
        return Object.fromEntries(
          decodeTools(yield* text(listed)).result.tools.map(({ name, annotations }) => [
            name,
            {
              readOnly: annotations.readOnlyHint,
              destructive: annotations.destructiveHint,
              idempotent: annotations.idempotentHint,
              openWorld: annotations.openWorldHint,
            },
          ]),
        );
      });
      // A person's own terminal client asks before a call by these; a flip shows here. Nothing
      // here deletes, and every write is safe to repeat.
      const read = { readOnly: true, destructive: false, idempotent: true, openWorld: false };
      const write = { readOnly: false, destructive: false, idempotent: true, openWorld: false };
      const everyone = {
        list_people: read,
        list_tasks: read,
        create_task: write,
        update_task: write,
        list_my_tasks: read,
        get_task: read,
        comment_on_task: write,
        set_task_state: write,
        tick_task_step: write,
        hand_task_back: write,
        nudge_task: write,
        hand_over_tasks: write,
        add_link: write,
        restart_watch: write,
        find: read,
        open_project: read,
        open_client: read,
        read_doc: read,
        list_lists: read,
        list_entries: read,
        add_entry: write,
        update_entry: write,
        read_numbers: read,
        record_number: write,
        list_waiting: read,
        ask_agent: write,
      };
      // A new teammate has Clients and Docs, so Zoya's key lists their tools; she has no Money or
      // Memory and makes no projects, so it lists none of theirs.
      const places = {
        create_client: write,
        update_client: write,
        log_contact: write,
        list_deals: read,
        create_deal: write,
        update_deal: write,
        add_promise: write,
        close_promise: write,
        write_doc: write,
      };
      assert.deepStrictEqual(yield* toolsOf(issued.secret), { ...everyone, ...places });
      const owners = yield* TasksKeys.issue(rhea.app, { orgId });
      assert.deepStrictEqual(yield* toolsOf(owners.secret), {
        ...everyone,
        ...places,
        set_project_note: write,
        restore_doc_version: write,
        save_goal: write,
        create_project: write,
        update_project: write,
        list_invoices: read,
        open_invoice: read,
        draft_invoice: write,
        money_summary: read,
        budgets: read,
        undo_memory_change: write,
        search_memory: read,
      });
      assert.deepStrictEqual(
        Object.keys(yield* toolsOf(owners.secret)).toSorted(),
        KinTasksKeyMcp.TASKS_KEY_TOOLS.toSorted(),
      );
      const sql = yield* SqlClient.SqlClient;
      const setShell = (rev: number, on: boolean) =>
        KinShell.KinShell.use((shell) =>
          shell.set(
            orgId,
            rhea.personId,
            rev,
            ["clients", "invoices", "money"].map((id) => ({ id, on })),
          ),
        ).pipe(
          Effect.provide(KinShell.layer),
          Effect.provideService(KinRefreshObserver, { touch: () => Effect.void }),
        );
      yield* setShell(0, false);
      const ownerTools = yield* toolsOf(owners.secret);
      assert.notProperty(ownerTools, "money_summary");
      assert.notProperty(ownerTools, "open_project");
      assert.notProperty(ownerTools, "open_client");
      for (const name of ["create_project", "create_client", "list_invoices"])
        assert.notProperty(ownerTools, name);
      assert.property(ownerTools, "find");
      // Called anyway, a tool of a section that is off answers as one that isn't there.
      const calls = [
        ["money_summary", {}],
        ["open_client", { key: "C-3" }],
        ["open_project", { key: "P-3" }],
        ["create_project", { title: "Invented" }],
        ["create_client", { name: "Invented" }],
        ["list_invoices", {}],
      ] as const;
      const ownerCall = Effect.fn("test.ownerCall")(function* (name: string, args: object) {
        const started = yield* call({
          token: owners.secret,
          method: "initialize",
          params: initialize,
        });
        const session = started.headers["mcp-session-id"];
        return yield* text(
          yield* call({
            token: owners.secret,
            method: "tools/call",
            params: { name, arguments: args },
            ...(session === undefined ? {} : { session }),
          }),
        );
      });
      const notThere = yield* ownerCall("no_such_tool", {});
      for (const [name, args] of calls)
        assert.strictEqual(
          (yield* ownerCall(name, args)).replaceAll(name, "no_such_tool"),
          notThere,
        );
      const started = yield* call({
        token: owners.secret,
        method: "initialize",
        params: initialize,
      });
      for (const kind of ["clients", "projects"]) {
        const session = started.headers["mcp-session-id"];
        const body = yield* text(
          yield* call({
            token: owners.secret,
            method: "tools/call",
            params: { name: "find", arguments: { kind, text: "Invented" } },
            ...(session === undefined ? {} : { session }),
          }),
        );
        assert.include(body, `"${kind}":[]`);
      }
      yield* setShell(1, true);
      // And called anyway, they answer as tools that aren't there.
      const unknown = yield* text(
        yield* call({
          token: issued.secret,
          method: "tools/call",
          params: { name: "no_such_tool", arguments: {} },
          ...(session === undefined ? {} : { session }),
        }),
      );
      for (const [name, args] of [
        ["money_summary", {}],
        ["search_memory", { text: "kiln" }],
        ["create_project", { title: "Invented: kiln" }],
        ["list_invoices", {}],
      ] as const) {
        const refused = yield* text(
          yield* call({
            token: issued.secret,
            method: "tools/call",
            params: { name, arguments: args },
            ...(session === undefined ? {} : { session }),
          }),
        );
        assert.include(refused, `"error"`);
        assert.notInclude(refused, "owed");
        assert.strictEqual(refused.replaceAll(name, "no_such_tool"), unknown);
      }
      const made = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_records
        WHERE title = 'Invented: kiln'`;
      assert.strictEqual(made[0]?.n, 0);
      // Rhea's key over the endpoint: a wrong kind, another company's entry and one never there
      // all answer the same; text a reader can't see is gone; and no read writes business data.
      const writer = {
        actor: { _tag: "person" as const, personId: rhea.personId },
        via: "owner" as const,
        askedBy: rhea.personId,
      };
      const make = (originKey: string, fields: Partial<CreateInput>) =>
        records
          .create(orgId, writer, {
            originKey,
            title: `Invented ${originKey}`,
            owner: { _tag: "person", personId: rhea.personId },
            ...fields,
          })
          .pipe(Effect.map(({ row }) => row));
      const client = yield* make("Lan\u200Bterns", { list: "clients" });
      const project = yield* make("launch", { list: "projects", partyId: client.recordId });
      yield* sql`INSERT INTO kin_orgs (org_id, name, created_at)
        VALUES ('other-company', 'Invented other', '1970-01-01')`;
      yield* sql`CREATE TEMP TABLE elsewhere AS SELECT * FROM kin_records
        WHERE record_id = ${client.recordId}`;
      yield* sql`UPDATE elsewhere SET org_id = 'other-company', record_id = 'elsewhere-1',
        key = 'C-77', origin_key = 'elsewhere'`;
      // Another company's row only, without the rest of that company around it.
      yield* sql`PRAGMA foreign_keys = OFF`;
      yield* sql`INSERT INTO kin_records SELECT * FROM elsewhere`;
      yield* sql`PRAGMA foreign_keys = ON`;
      yield* sql`DROP TABLE elsewhere`;
      const ownersOpened = yield* call({
        token: owners.secret,
        method: "initialize",
        params: initialize,
      });
      const ownersSession = ownersOpened.headers["mcp-session-id"];
      const tool = Effect.fn("test.tool")(function* (name: string, args: object) {
        return yield* text(
          yield* call({
            token: owners.secret,
            method: "tools/call",
            params: { name, arguments: args },
            ...(ownersSession === undefined ? {} : { session: ownersSession }),
          }),
        );
      });
      const writes = sql<{ n: number }>`SELECT total_changes() AS n`.pipe(
        Effect.map(([row]) => row?.n ?? 0),
      );
      // Admission's own bookkeeping, `last_used_at` at most once a minute, is the one write.
      const [used] = yield* sql<{ at: number | null }>`SELECT last_used_at AS at
        FROM kin_tasks_keys WHERE session_id = ${owners.key.sessionId}`;
      assert.isNotNull(used?.at ?? null);
      for (const [name, wrong, never] of [
        ["open_project", client.key, "P-999"],
        ["open_client", project.key, "C-999"],
        ["open_client", "C-77", "C-999"],
        ["read_doc", client.key, "D-999"],
        ["read_doc", "C-77", "D-999"],
      ] as const) {
        const before = yield* writes;
        const answered = yield* tool(name, { key: wrong });
        assert.include(answered, "Not found.");
        assert.strictEqual(answered, yield* tool(name, { key: never }));
        assert.strictEqual(yield* writes, before);
      }
      for (const [name, args] of [
        ["open_client", { key: client.key }],
        ["open_project", { key: project.key }],
        ["find", { kind: "clients" }],
        ["find", { kind: "projects" }],
        ["find", { kind: "docs" }],
        ["money_summary", {}],
        ["search_memory", { text: "kiln" }],
        ["list_my_tasks", {}],
      ] as const) {
        const before = yield* writes;
        const answered = yield* tool(name, args);
        assert.notInclude(answered, "\u200B");
        assert.notInclude(answered, "\\u200b");
        assert.strictEqual(yield* writes, before);
        if (name === "open_client") assert.include(answered, "Invented Lanterns");
      }

      const checked = verified;
      const mine = yield* call({
        token: issued.secret,
        method: "tools/call",
        params: { name: "list_my_tasks", arguments: {} },
        ...(session === undefined ? {} : { session }),
      });
      assert.strictEqual(mine.status, 200);
      assert.strictEqual(verified - checked, 1);
      assert.include(yield* text(mine), "Invented: book the hall");

      yield* TasksKeys.revoke(zoya.app, { orgId, sessionId: issued.key.sessionId });
      const after = yield* call({
        token: issued.secret,
        method: "tools/call",
        params: { name: "list_my_tasks", arguments: {} },
        ...(session === undefined ? {} : { session }),
      });
      assert.strictEqual(after.status, 401);
    }).pipe(Effect.scoped, Effect.provide(layer)),
);

it("the connecting agent is told what stays a tap in Kin, and no tool offers to mark a deal lost", () => {
  // The six groups are tried through a key in reach.test.ts; this is the one line that says so.
  for (const place of [
    "a card",
    "money or mail out",
    "Settings → Team",
    "deleting or archiving",
    "ask_agent",
  ])
    assert.include(KinTasksKeyMcp.TASKS_KEY_INSTRUCTIONS, place);
  const updateDeal = KinTasksKeyMcp.TasksKeyToolkit.tools.update_deal;
  assert.notInclude(JSON.stringify(Tool.getJsonSchema(updateDeal)), '"lost"');
  assert.include(Tool.getDescription(updateDeal) ?? "", "Marking a deal lost is done in Kin.");
});

const decodeSavedGoal = Schema.decodeUnknownSync(Schema.Struct({ key: KinRecordKey }));
const decodeMemoryHead = Schema.decodeUnknownSync(MemoryItemHead);
const encodeMemoryCard = Schema.encodeSync(KinMemoryChangeCard);
const wireResult = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      result: Schema.Struct({
        isError: Schema.optional(Schema.Boolean),
        structuredContent: Schema.optional(Schema.Unknown),
        content: Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
      }),
    }),
  ),
);

const roundTwo = Effect.gen(function* () {
  const { orgId, rhea, zoya, arjun } = yield* team;
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* SessionStore;
  const identity = yield* KinIdentity;
  const people = yield* People.KinPeople;
  const records = yield* KinRecords;
  const repo = yield* Repository.KinChatRepository;
  const memory = yield* MemoryChanges.KinMemoryChanges;
  const join = Effect.fn("test.joinRoundTwo")(function* (displayName: string) {
    const invite = yield* people.createInvite(rhea.app, { orgId, displayName });
    const joined = yield* people.accept({ secret: invite.secret });
    return { personId: joined.person.personId, app: yield* sessions.verify(joined.accessToken) };
  });
  const meera = yield* join("Meera");
  const dev = yield* join("Dev Malhotra");
  yield* sql`UPDATE kin_people SET access = 'co_owner' WHERE person_id = ${meera.personId}`;
  yield* sql`UPDATE kin_people SET display_name = 'Zoya Sheikh', sees_money = 1, sees_clients = 1
    WHERE person_id = ${zoya.personId}`;
  const services = (yield* Effect.context<
    SqlClient.SqlClient | KinIdentity | KinRecords | SessionStore | MemoryChanges.KinMemoryChanges
  >()) as unknown as Context.Context<Services>;
  const { call, text } = yield* endpoint(services, sessions);
  const connect = Effect.fn("test.keyConnect")(function* (one: typeof rhea) {
    const issued = yield* TasksKeys.issue(one.app, { orgId, label: "Invented terminal" });
    const token = issued.secret;
    const start = yield* call({ token, method: "initialize", params: initialize });
    const session = start.headers["mcp-session-id"];
    assert.strictEqual(start.status, 200);
    const use = Effect.fn("test.keyTool")(function* (name: string, args: object = {}) {
      const { result } = wireResult(
        yield* text(
          yield* call({
            token,
            method: "tools/call",
            params: { name, arguments: args },
            ...(session === undefined ? {} : { session }),
          }),
        ),
      );
      const plain = result.content[0]?.text;
      const structuredContent =
        result.structuredContent ?? (plain === undefined ? undefined : JSON.parse(plain));
      return { ...result, structuredContent };
    });
    return { use, sessionId: issued.key.sessionId, app: yield* identity.resolve(one.app) };
  });
  const writer = Work.ownerWriter(identity.owner);
  const person = (personId: KinPersonId) => ({ _tag: "person", personId }) as const;
  const make = (title: string, fields: Partial<CreateInput> = {}) =>
    records
      .create(orgId, writer, {
        originKey: title,
        title,
        owner: writer.actor,
        ...fields,
      })
      .pipe(Effect.map(({ row }) => ({ ...row, key: KinRecordKey.make(row.key) })));
  const authored = Effect.fn("test.codingAgentChange")(function* (
    row: { readonly recordId: string },
    sessionId: string,
    kind = "updated",
  ) {
    const entries = yield* sql<{ id: string }>`SELECT coding_agent_key AS id
      FROM kin_record_changes WHERE org_id = ${orgId} AND record_id = ${row.recordId}
        AND kind = ${kind} AND coding_agent_key IS NOT NULL ORDER BY seq`;
    assert.deepStrictEqual(entries, [{ id: sessionId }]);
  });
  return {
    orgId,
    sql,
    records,
    repo,
    memory,
    writer,
    person,
    make,
    authored,
    rhea: yield* connect(rhea),
    meera: yield* connect(meera),
    dev: yield* connect(dev),
    zoya: yield* connect(zoya),
    arjun: yield* connect(arjun),
  };
});

const roundTwoLayer = MemoryChanges.layer.pipe(Layer.provideMerge(layer));
const hasResult = (result: ReturnType<typeof wireResult>["result"], value: object) => {
  assert.isNotTrue(result.isError);
  assert.deepInclude(result.structuredContent, value);
};
const refusedLike = (result: ReturnType<typeof wireResult>["result"], message: string) => {
  assert.isTrue(result.isError);
  assert.deepInclude(result.structuredContent, { message });
};

it.effect(
  "Dev ticks a project task, Zoya hands one back, and Rhea nudges and hands over through Work",
  () =>
    Effect.gen(function* () {
      const { orgId, sql, records, person, make, authored, rhea, meera, dev, zoya, arjun } =
        yield* roundTwo;
      const project = yield* make("Invented fair", {
        list: "projects",
        owner: person(dev.app[0]!.personId),
        fields: { members: [`person:${zoya.app[0]!.personId}`] },
      });
      const task = (title: string, fields: Partial<CreateInput> = {}) =>
        make(title, {
          projectId: project.recordId,
          owner: person(zoya.app[0]!.personId),
          team: true,
          steps: [{ title: "Book the room", done: false }],
          ...fields,
        });
      const held = yield* task("Invented hallway");
      const appHeld = yield* task("Invented app hallway");
      const privateTask = yield* task("Invented private job", { sensitive: true });
      const tick = { key: held.key, index: 0, title: "Book the room", done: true };
      const denied = yield* Work.tickStep(arjun.app, { orgId, ...tick }).pipe(Effect.flip);
      refusedLike(yield* arjun.use("tick_task_step", tick), denied.message);
      const appTicked = yield* Work.tickStep(dev.app, { orgId, ...tick, key: appHeld.key });
      hasResult(yield* dev.use("tick_task_step", tick), { checklist: appTicked.checklist });
      hasResult(yield* dev.use("tick_task_step", tick), { checklist: appTicked.checklist });
      yield* authored(held, dev.sessionId);

      const returning = yield* task("Invented samples");
      const appReturning = yield* task("Invented app samples");
      const back = { key: returning.key, note: "I need the samples first." };
      const returnDenied = yield* Work.handBack(rhea.app, { orgId, ...back }).pipe(Effect.flip);
      refusedLike(yield* rhea.use("hand_task_back", back), returnDenied.message);
      const appReturn = yield* Work.handBack(zoya.app, { orgId, ...back, key: appReturning.key });
      hasResult(yield* zoya.use("hand_task_back", back), { to: appReturn.to });
      yield* zoya.use("hand_task_back", back);
      yield* authored(returning, zoya.sessionId);

      for (const [name, args] of [
        ["tick_task_step", tick],
        ["hand_task_back", back],
        ["nudge_task", { key: held.key }],
      ] as const) {
        for (const wrong of [project.key, privateTask.key]) {
          const response = yield* rhea.use(name, { ...args, key: wrong });
          assert.isTrue(response.isError);
          assert.deepInclude(response.structuredContent, { reason: "not_found" });
        }
      }
      const nudgeDenied = yield* Work.nudge(zoya.app, { orgId, key: held.key }).pipe(Effect.flip);
      refusedLike(yield* zoya.use("nudge_task", { key: held.key }), nudgeDenied.message);
      const appNudged = yield* Work.nudge(rhea.app, { orgId, key: appHeld.key });
      hasResult(yield* rhea.use("nudge_task", { key: held.key }), { already: appNudged.already });
      hasResult(yield* rhea.use("nudge_task", { key: held.key }), { already: true });
      const news = yield* sql<{ name: string; coded: number | null }>`SELECT
      json_extract(body, '$.name') AS name, json_extract(body, '$.codingAgent') AS coded
      FROM kin_held_posts WHERE org_id = ${orgId} AND json_extract(body, '$.key') = ${held.key}
        AND json_extract(body, '$.kind') = 'nudged'`;
      assert.deepStrictEqual(news, [{ name: "Rhea", coded: 1 }]);

      const from = person(zoya.app[0]!.personId);
      const to = person(arjun.app[0]!.personId);
      const move = { from: "Zoya Sheikh", to: "Arjun" };
      const deniedMove = yield* Work.handOver(arjun.app, { orgId, from, to }).pipe(Effect.flip);
      refusedLike(yield* arjun.use("hand_over_tasks", move), deniedMove.message);
      const byHand = yield* Work.handOver(meera.app, { orgId, from, to, dryRun: true });
      const moved = byHand.keys.filter((key) => key !== privateTask.key);
      hasResult(yield* meera.use("hand_over_tasks", move), { keys: moved, kept: 0 });
      hasResult(yield* meera.use("hand_over_tasks", move), { keys: [], kept: 0 });
      assert.strictEqual((yield* records.get(orgId, held.key))?.ownerId, to.personId);
      assert.strictEqual((yield* records.get(orgId, privateTask.key))?.ownerId, from.personId);
      yield* authored(appHeld, meera.sessionId);
    }).pipe(Effect.scoped, Effect.provide(roundTwoLayer)),
);

it.effect(
  "Rhea and Meera add links, pin notes, restore docs, and save goals through their app services",
  () =>
    Effect.gen(function* () {
      const { orgId, sql, records, writer, make, authored, rhea, meera, arjun } = yield* roundTwo;
      const task = yield* make("Invented phone stand", { team: true });
      const privateTask = yield* make("Invented quiet task", { sensitive: true });
      const url = "https://example.test/stand";
      const link = { key: task.key, url };
      const linkDenied = yield* Work.addLink(arjun.app, { orgId, ...link }).pipe(Effect.flip);
      refusedLike(yield* arjun.use("add_link", link), linkDenied.message);
      const invalid = { ...link, url: "file:///invented" };
      const badLink = yield* Work.addLink(rhea.app, { orgId, ...invalid }).pipe(Effect.flip);
      refusedLike(yield* rhea.use("add_link", invalid), badLink.message);
      const twin = yield* make("Invented app phone stand");
      yield* Work.addLink(rhea.app, { orgId, key: twin.key, url });
      hasResult(yield* rhea.use("add_link", link), { key: task.key });
      hasResult(yield* rhea.use("add_link", link), { key: task.key });
      const links = (recordId: string) => sql<{
        target: string;
      }>`SELECT target FROM kin_record_links
      WHERE org_id = ${orgId} AND record_id = ${recordId}`;
      assert.deepStrictEqual(yield* links(task.recordId), yield* links(twin.recordId));
      yield* authored(task, rhea.sessionId, "linked");
      assert.deepInclude(
        (yield* rhea.use("add_link", { ...link, key: privateTask.key })).structuredContent,
        {
          reason: "not_found",
        },
      );

      yield* presetList(orgId, "invoices", 0);
      const invoice = yield* make("Invented invoice draft", { list: "invoices" });
      yield* Work.addLink(rhea.app, { orgId, key: invoice.key, url });
      const moneyLink = { key: invoice.key, url: "https://example.test/draft" };
      refusedLike(
        yield* rhea.use("add_link", moneyLink),
        "A coding agent's key never deletes or archives anything, nor records or changes money: the person does that in Kin.",
      );
      assert.deepStrictEqual(yield* links(invoice.recordId), [{ target: url }]);

      const project = yield* make("Invented shared project", { list: "projects" });
      const hidden = yield* make("Invented private project", { list: "projects", sensitive: true });
      const note = { key: project.key, body: "Check the glazing first." };
      const noteRequest = { orgId, ...note, clientRequestId: "app-note" };
      const noNote = yield* projectNote(arjun.app, noteRequest).pipe(Effect.flip);
      refusedLike(yield* arjun.use("set_project_note", note), noNote.message);
      const appNote = yield* projectNote(meera.app, noteRequest);
      for (let i = 0; i < 2; i++)
        hasResult(yield* meera.use("set_project_note", note), { note: appNote.note?.body });
      const notes = yield* sql<{
        id: string;
      }>`SELECT coding_agent_key AS id FROM kin_record_comments
      WHERE org_id = ${orgId} AND record_id = ${project.recordId} AND coding_agent_key IS NOT NULL`;
      assert.deepStrictEqual(notes, [{ id: meera.sessionId }]);
      assert.deepInclude(
        (yield* rhea.use("set_project_note", { ...note, key: hidden.key })).structuredContent,
        {
          reason: "not_found",
        },
      );

      const document = Effect.fn("test.roundTwoDocument")(function* (
        title: string,
        projectId?: string,
      ) {
        const { row } = yield* Docs.create(
          orgId,
          writer,
          {},
          {
            title,
            body: "Version one.\n",
            owner: writer.actor,
            summary: "Made",
            originKey: title,
            ...(projectId === undefined ? {} : { projectId }),
          },
        );
        const key = KinRecordKey.make(row.key);
        yield* Docs.rewrite(
          orgId,
          writer,
          {},
          { key },
          {
            body: "Version two.\n",
            baseVersion: 1,
            summary: "Edited",
            originKey: `${title}-2`,
          },
        );
        return { ...row, key };
      });
      const doc = yield* document("Invented draft");
      const appDoc = yield* document("Invented app draft");
      const privateDoc = yield* document("Invented hidden draft", hidden.recordId);
      const restore = { key: doc.key, version: 1, latest: 2 };
      const noRestore = yield* OwnerDocs.restore(arjun.app, { orgId, ...restore }).pipe(
        Effect.flip,
      );
      refusedLike(yield* arjun.use("restore_doc_version", restore), noRestore.message);
      const restored = yield* OwnerDocs.restore(meera.app, { orgId, ...restore, key: appDoc.key });
      for (let i = 0; i < 2; i++)
        hasResult(yield* meera.use("restore_doc_version", restore), {
          version: restored.version.version,
        });
      assert.strictEqual(
        (yield* OwnerDocs.get(meera.app, { orgId, key: doc.key })).body,
        restored.body,
      );
      yield* authored(doc, meera.sessionId);
      assert.deepInclude(
        (yield* rhea.use("restore_doc_version", { ...restore, key: privateDoc.key }))
          .structuredContent,
        {
          reason: "not_found",
        },
      );

      const goal = {
        title: "Ship prototypes",
        measure: "manual" as const,
        target: "10",
        current: 2,
        startsOn: "2026-11-01",
        dueOn: "2026-12-01",
      };
      const appGoal = { orgId, ...goal, title: "App prototypes", clientRequestId: "app-goal" };
      const goalDenied = yield* Goals.save(arjun.app, appGoal).pipe(Effect.flip);
      refusedLike(yield* arjun.use("save_goal", goal), goalDenied.message);
      const byHand = yield* Goals.save(meera.app, appGoal);
      const saved = yield* meera.use("save_goal", goal);
      assert.isNotTrue(saved.isError, JSON.stringify(saved.structuredContent));
      assert.deepStrictEqual(yield* meera.use("save_goal", goal), saved);
      const decoded = decodeSavedGoal(saved.structuredContent);
      const made = (yield* records.get(orgId, decoded.key))!;
      const other = (yield* records.get(orgId, byHand.key))!;
      assert.strictEqual(made.fieldsJson, other.fieldsJson);
      assert.strictEqual(made.dueAt, other.dueAt);
      yield* authored(made, meera.sessionId, "created");
      const privateGoal = yield* make("Invented private goal", { list: "goals", sensitive: true });
      assert.deepInclude(
        (yield* rhea.use("save_goal", { ...goal, key: privateGoal.key })).structuredContent,
        {
          reason: "not_found",
        },
      );
    }).pipe(Effect.scoped, Effect.provide(roundTwoLayer)),
);

it.effect(
  "Rhea restarts a reachable watch while Arjun is refused and the retry leaves its next look alone",
  () =>
    Effect.gen(function* () {
      const { orgId, sql, make, rhea, arjun } = yield* roundTwo;
      const task = yield* make("Invented kiln check");
      const hidden = yield* make("Invented private kiln check", { sensitive: true });
      const seedWatch = (id: string, recordId: string) =>
        sql`INSERT INTO kin_watches (org_id, watch_id, kind, source, source_key, record_id, about,
        closes_when, audience, why, set_by_kind, next_look_at, interval_ms, state, created_at, updated_at)
        VALUES (${orgId}, ${id}, 'task_out', 'task', ${id}, ${recordId}, 'Invented watch',
          'Task done', 'owner', 'Invented reason', 'code', 100, 100, 'stopped', 0, 0)`;
      yield* seedWatch("app-watch", task.recordId);
      yield* seedWatch("key-watch", task.recordId);
      yield* seedWatch("quiet-watch", hidden.recordId);
      const reader = yield* watchReader(rhea.app, orgId);
      const member = yield* watchReader(arjun.app, orgId);
      const denied = yield* Watches.again(orgId, member, "key-watch").pipe(Effect.flip);
      refusedLike(yield* arjun.use("restart_watch", { watchId: "key-watch" }), denied.message);
      refusedLike(yield* rhea.use("restart_watch", { watchId: "quiet-watch" }), denied.message);
      yield* TestClock.setTime(1_000);
      const byHand = yield* Watches.again(orgId, reader, "app-watch");
      const input = { watchId: "key-watch" };
      hasResult(yield* rhea.use("restart_watch", input), { state: byHand.watch.state });
      yield* TestClock.setTime(2_000);
      hasResult(yield* rhea.use("restart_watch", input), { state: byHand.watch.state });
      const rows = yield* sql`SELECT state, asked_look_at, next_look_at, interval_ms, updated_at
      FROM kin_watches WHERE org_id = ${orgId} AND watch_id IN ('app-watch', 'key-watch')
      ORDER BY watch_id`;
      assert.deepStrictEqual(rows, [rows[0], rows[0]]);
      assert.deepInclude(rows[1], { updated_at: 1_000 });
      const history = yield* sql`SELECT json_extract(entry_json, '$.result') AS result
      FROM kin_audit WHERE org_id = ${orgId} AND event = 'watch_restarted'`;
      assert.deepStrictEqual(history, [{ result: "Rhea (coding agent) restarted key-watch." }]);
    }).pipe(Effect.scoped, Effect.provide(roundTwoLayer)),
);

it.effect(
  "Meera reads budgets with every private expense and private project left out, and Zoya cannot read the owner budget",
  () =>
    Effect.gen(function* () {
      const now = Date.parse("2026-11-15T12:00:00Z");
      yield* TestClock.setTime(now);
      const { orgId, sql, writer, make, records, meera, zoya } = yield* roundTwo;
      const visible = yield* make("Invented public project", { list: "projects" });
      const hidden = yield* make("Invented quiet project", { list: "projects", sensitive: true });
      const artist = { kind: "person" as const, id: meera.app[0]!.personId };
      yield* presetList(orgId, "expenses", now);
      for (const projectId of [null, visible.recordId, hidden.recordId]) {
        yield* setBudget(
          orgId,
          {
            category: projectId === null ? "office" : null,
            projectId,
            currency: "INR",
            limitMinor: 9_000,
            sourceEventId: `app-budget:${projectId}`,
          },
          artist,
          now,
        );
      }
      yield* make("Invented tiles paid", {
        list: "expenses",
        state: "done",
        dateAt: now,
        category: "office",
        projectId: visible.recordId,
        amount: { minor: 2_000, currency: "INR" },
      });
      const before = yield* MoneyAnswers.budgets(meera.app, { orgId });
      const expected = {
        ...before,
        budgets: before.budgets.filter((one) => one.project?.key !== hidden.key),
        privateLeftOut: true,
      };
      const privateSpend = yield* make("Invented confidential supplies", {
        list: "expenses",
        state: "done",
        dateAt: now,
        category: "office",
        projectId: visible.recordId,
        amount: { minor: 9_123_456, currency: "INR" },
      });
      yield* records.update(orgId, writer, privateSpend.key, { sensitive: true });
      yield* make("Invented supplies on a quiet project", {
        list: "expenses",
        state: "done",
        dateAt: now,
        category: "office",
        projectId: hidden.recordId,
        amount: { minor: 7_123_456, currency: "USD" },
      });
      // Both kinds of private source change the app figures.
      const screen = yield* MoneyAnswers.budgets(meera.app, { orgId });
      assert.notDeepEqual(screen.budgets, before.budgets);
      assert.include(JSON.stringify(screen), "9125456");
      const denied = yield* MoneyAnswers.budgets(zoya.app, { orgId }).pipe(Effect.flip);
      refusedLike(yield* zoya.use("budgets"), denied.message);
      const beforeRead = yield* sql`SELECT total_changes() AS changes`;
      for (let read = 0; read < 2; read++) {
        const result = yield* meera.use("budgets");
        assert.isNotTrue(result.isError);
        assert.deepStrictEqual(result.structuredContent, expected);
      }
      assert.deepStrictEqual(yield* sql`SELECT total_changes() AS changes`, beforeRead);
    }).pipe(Effect.scoped, Effect.provide(roundTwoLayer)),
);

it.effect(
  "Rhea undoes one team memory change through the same card service without exposing other lines to her key",
  () =>
    Effect.gen(function* () {
      const { orgId, sql, repo, memory, rhea, meera, arjun } = yield* roundTwo;
      const actor = rhea.app[0]!;
      const agentId = KinAgentId.make("invented-lead");
      const chatId = KinChatId.make("invented-direct");
      yield* repo.insertAgent({
        orgId,
        agentId,
        displayName: "Invented Lead",
        role: "lead",
        ownerPersonId: actor.personId,
        createdAt: "1970-01-01T00:00:00.000Z",
      });
      yield* sql`INSERT INTO kin_chats (org_id, chat_id, kind, direct_key, last_seq, created_at)
      VALUES (${orgId}, ${chatId}, 'direct', 'invented-direct', 1, '1970-01-01')`;
      yield* sql`INSERT INTO kin_leads (agent_id, org_id, name, level, level_since, models_json,
      worker_projects_json, owner_chat_id)
      VALUES (${agentId}, ${orgId}, 'Invented Lead', 'L0', 0, '{}', '[]', ${chatId})`;
      const item = (id: string, sensitive: boolean) => ({
        head: decodeMemoryHead({
          id,
          orgId,
          path: `claims/${id}.md`,
          kind: "claim",
          title: `Invented ${id}`,
          status: "open",
          due: null,
          recorded_at: "1970-01-01T00:00:00.000Z",
          valid_from: "1970-01-01T00:00:00.000Z",
          invalid_at: null,
          superseded_by: null,
          review_by: null,
          source: "fixture",
          said_by: "fixture",
          trust: "owner",
          links: [],
          sensitive,
        }),
        body: "Invented kiln capacity.\n",
      });
      const teamItem = item("shared-kiln", false);
      const appItem = item("app-kiln", false);
      const privateItem = item("private-terms", true);
      const items = [teamItem, appItem, privateItem];
      for (const one of [teamItem, appItem])
        yield* authorise(orgId, one.head.id, fingerprint(one), "owner_setting");
      const writerCalls: Array<{ itemId: string; codingFor: string | null }> = [];
      yield* memory.attachWriter({
        undo: Effect.fn("test.memoryUndo")(function* (_org, input) {
          const current = items.find(({ head }) => head.id === input.itemId)!;
          if (input.codingAgent !== undefined) yield* input.codingAgent.admit(current);
          writerCalls.push({
            itemId: input.itemId,
            codingFor: input.codingAgent?.personId ?? null,
          });
          return { _tag: "undone" as const, commit: "c".repeat(40) };
        }),
        relabel: () => Effect.die("Unused"),
        retire: () => Effect.die("Unused"),
        restore: () => Effect.die("Unused"),
        recordDecision: () => Effect.die("Unused"),
        items: () => Effect.succeed(items),
        snapshot: () => Effect.succeed(items),
      });
      const widgetId = KinWidgetId.make("memory-changes:invented-lead:wake");
      const messageId = KinMessageId.make("invented-memory-card");
      yield* sql`INSERT INTO kin_messages (org_id, message_id, chat_id, seq, kind, author_kind,
        author_role, body, mentions_json, status, created_at)
      VALUES (${orgId}, ${messageId}, ${chatId}, 1, 'system', 'system', 'owner',
        'Invented card', '[]', 'posted', '1970-01-01')`;
      yield* repo.insertWidget({
        audience: "chat",
        orgId,
        chatId,
        widgetId,
        messageId,
        widgetClass: "native",
        type: KIN_MEMORY_CHANGES_CARD,
        state: encodeMemoryCard({
          agentId,
          wakeupId: "invented-wake",
          branch: "main",
          base: "a".repeat(40),
          commit: "b".repeat(40),
          more: 0,
          items: items.map(({ head }) => ({
            itemId: head.id,
            path: head.path,
            title: head.title,
            change: "updated",
            undo: null,
          })),
        }),
        source: null,
        feed: null,
        awaiting: [],
        pinnedAt: null,
        closedAt: null,
        updatedAt: "1970-01-01T00:00:00.000Z",
      });
      const input = { widgetId, itemId: teamItem.head.id };
      for (const caller of [arjun, meera]) {
        const no = yield* memory.undo(caller.app, { orgId, ...input }).pipe(Effect.flip);
        refusedLike(yield* caller.use("undo_memory_change", input), no.message);
      }
      const hidden = yield* rhea.use("undo_memory_change", {
        ...input,
        itemId: privateItem.head.id,
      });
      refusedLike(hidden, "Kin record not found.");
      const found = yield* rhea.use("search_memory", { text: "kiln" });
      assert.include(JSON.stringify(found.structuredContent), teamItem.head.id);
      assert.notInclude(JSON.stringify(found.structuredContent), privateItem.head.id);
      for (let retry = 0; retry < 2; retry++) {
        const result = yield* rhea.use("undo_memory_change", input);
        assert.deepStrictEqual(result.structuredContent, { itemId: teamItem.head.id });
      }
      const { card } = yield* memory.undo(rhea.app, { orgId, ...input, itemId: appItem.head.id });
      assert.deepStrictEqual(
        card.items.map((one) => one.undo),
        ["undone", "undone", null],
      );
      assert.deepStrictEqual(writerCalls, [
        { itemId: teamItem.head.id, codingFor: actor.personId },
        { itemId: appItem.head.id, codingFor: null },
      ]);
    }).pipe(Effect.scoped, Effect.provide(roundTwoLayer)),
);
