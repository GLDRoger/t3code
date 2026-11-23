import * as KinShell from "../shell/KinShell.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import { ServerEnvironment } from "../../environment/ServerEnvironment.ts";
import { McpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
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
      const routes = KinTasksKeyMcp.layer.pipe(
        Layer.provide(
          Layer.succeed(KinServer, {
            taskCardUpdater: Layer.empty,
            services: Option.some(services),
            subscribeForViewer: Option.none(),
          }),
        ),
        Layer.provide(Layer.succeed(SessionStore, counted)),
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
      // A person's own terminal client asks before a call by these; a flip shows here. Only a
      // task's comment and state are written; every other tool only reads.
      const read = { readOnly: true, destructive: false, idempotent: true, openWorld: false };
      const write = { readOnly: false, destructive: false, idempotent: true, openWorld: false };
      const reads = { find: read, open_project: read, open_client: read, read_doc: read };
      // Zoya has no Money and no Memory page, so her key lists neither.
      assert.deepStrictEqual(yield* toolsOf(issued.secret), {
        list_my_tasks: read,
        get_task: read,
        comment_on_task: write,
        set_task_state: write,
        ...reads,
      });
      const owners = yield* TasksKeys.issue(rhea.app, { orgId });
      assert.deepStrictEqual(yield* toolsOf(owners.secret), {
        list_my_tasks: read,
        get_task: read,
        comment_on_task: write,
        set_task_state: write,
        ...reads,
        money_summary: read,
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
      assert.property(ownerTools, "find");
      const calls = [
        ["money_summary", {}, "Money"],
        ["open_client", { key: "C-3" }, "Clients"],
        ["open_project", { key: "P-3" }, "Clients"],
      ] as const;
      for (const [name, args, label] of calls) {
        const started = yield* call({
          token: owners.secret,
          method: "initialize",
          params: initialize,
        });
        const session = started.headers["mcp-session-id"];
        const body = yield* text(
          yield* call({
            token: owners.secret,
            method: "tools/call",
            params: { name, arguments: args },
            ...(session === undefined ? {} : { session }),
          }),
        );
        assert.include(body, `${label} is turned off for this company.`);
      }
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
      for (const name of ["money_summary", "search_memory"]) {
        const refused = yield* text(
          yield* call({
            token: issued.secret,
            method: "tools/call",
            params: { name, arguments: name === "money_summary" ? {} : { text: "kiln" } },
            ...(session === undefined ? {} : { session }),
          }),
        );
        assert.include(refused, `"error"`);
        assert.notInclude(refused, "owed");
      }
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
