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
import { KinRecords } from "../work/KinRecords.ts";
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
  "the endpoint serves four tools to a live key and drops it mid-session once revoked",
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
      // What the tools read through: Kin's services, as the running server holds them.
      const services = (yield* Effect.context<
        SqlClient.SqlClient | KinIdentity | KinRecords
      >()) as Context.Context<
        SqlClient.SqlClient | KinIdentity | KinRecords
      > as unknown as Context.Context<Services>;
      const routes = KinTasksKeyMcp.layer.pipe(
        Layer.provide(
          Layer.succeed(KinServer, {
            taskCardUpdater: Layer.empty,
            services: Option.some(services),
            subscribeForViewer: Option.none(),
          }),
        ),
        Layer.provide(Layer.succeedContext(yield* Effect.context<SessionStore>())),
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
      const listed = yield* call({
        token: issued.secret,
        method: "tools/list",
        params: {},
        ...(session === undefined ? {} : { session }),
      });
      // A person's own terminal client asks before a call by these; a flip shows here.
      const read = { readOnly: true, destructive: false, idempotent: true, openWorld: false };
      const write = { readOnly: false, destructive: false, idempotent: true, openWorld: false };
      assert.deepStrictEqual(
        Object.fromEntries(
          decodeTools(yield* text(listed)).result.tools.map(({ name, annotations }) => [
            name,
            {
              readOnly: annotations.readOnlyHint,
              destructive: annotations.destructiveHint,
              idempotent: annotations.idempotentHint,
              openWorld: annotations.openWorldHint,
            },
          ]),
        ),
        {
          list_my_tasks: read,
          get_task: read,
          comment_on_task: write,
          set_task_state: write,
        },
      );
      const mine = yield* call({
        token: issued.secret,
        method: "tools/call",
        params: { name: "list_my_tasks", arguments: {} },
        ...(session === undefined ? {} : { session }),
      });
      assert.strictEqual(mine.status, 200);
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
