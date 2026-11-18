import { assert, it } from "@effect/vitest";
import {
  AuthKinTasksScope,
  type AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentHttpApi,
  type KinPersonId,
  type KinTasksKeysIssueInput,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import { HttpEffect, HttpRouter, HttpServerRequest, type HttpServerResponse } from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import { type AuthenticatedSession, EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import * as AuthHttp from "../../auth/http.ts";
import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { SessionStore } from "../../auth/SessionStore.ts";
import * as Records from "../work/KinRecords.ts";
import { TasksKeyAudience } from "./audience.ts";
import { commentMine, getMine, listMine, setStateMine } from "./tasks.ts";
import { admitted, layer, team } from "./tasksKey.testkit.ts";
import * as TasksKeys from "./TasksKeys.ts";

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

    yield* TasksKeys.issue(zoya.app, { orgId });
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
    // A use is shown in the list.
    yield* admitted(first.secret);
    const used = (yield* TasksKeys.list(zoya.app, { orgId })).keys.find(
      (one) => one.sessionId === first.key.sessionId,
    );
    assert.isNotNull(used?.lastUsedAt);
  }).pipe(Effect.provide(layer)),
);

it.effect("a key reaches only tasks its person holds, narrowly and as them, even the owner's", () =>
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
      project: "Invented: launch",
    };
    assert.deepStrictEqual(yield* listMine(zoyaKey), { tasks: [task], more: false });
    // No money, no client, nobody else's: the narrow view and nothing more.
    assert.deepStrictEqual(yield* getMine(zoyaKey, hers.key), {
      ...task,
      brief: "Invented brief: two rooms",
      comments: [],
    });
    for (const other of [shared, given, owners])
      assert.strictEqual(yield* reason(getMine(zoyaKey, other.key)), "not_found");
    // The owner's key is as narrow: only what Rhea holds.
    assert.deepStrictEqual(
      (yield* listMine(rheaKey)).tasks.map((one) => one.key),
      [owners.key],
    );
    assert.strictEqual(yield* reason(getMine(rheaKey, hers.key)), "not_found");
    assert.strictEqual(
      yield* reason(setStateMine(rheaKey, { key: hers.key, state: "done" })),
      "not_found",
    );
    // Zoya gave it, so her app may change it; her key may not, and neither may the writer.
    assert.strictEqual(
      yield* reason(setStateMine(zoyaKey, { key: given.key, state: "done" })),
      "not_found",
    );
    assert.strictEqual(
      yield* reason(
        records.update(
          orgId,
          { ...writer(zoya.personId), codingAgentKey: zoyaKey.sessionId },
          given.key,
          { state: "done" },
        ),
      ),
      "not_found",
    );
    assert.strictEqual(
      yield* reason(commentMine(zoyaKey, { key: given.key, text: "Invented" })),
      "not_found",
    );
    assert.strictEqual((yield* records.get(orgId, given.key))?.state, "open");

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
      { by: "you", at: started.comments[0]!.at, text: "Invented: the hall is booked" },
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
    // Done, then back to open: both hers to set.
    assert.strictEqual(
      (yield* setStateMine(zoyaKey, { key: hers.key, state: "done" })).state,
      "done",
    );
    assert.strictEqual(
      (yield* setStateMine(zoyaKey, { key: hers.key, state: "open" })).state,
      "open",
    );
    // Once it is Arjun's, her key no longer reaches it.
    yield* records.update(orgId, writer(rhea.personId), hers.key, {
      owner: { _tag: "person", personId: arjun.personId },
    });
    assert.strictEqual(yield* reason(getMine(zoyaKey, hers.key)), "not_found");
    assert.strictEqual(
      yield* reason(setStateMine(zoyaKey, { key: hers.key, state: "done" })),
      "not_found",
    );
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

class AuthRoutes extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

it.effect("a key is no credential anywhere but its endpoint: every route and credential read", () =>
  Effect.gen(function* () {
    const { orgId, zoya } = yield* team;
    const auth = yield* EnvironmentAuth;
    const sessions = yield* SessionStore;
    const { key, secret } = yield* TasksKeys.issue(zoya.app, { orgId });
    // A script's bearer session passes every read below, so each refusal is the key's.
    const script = (yield* auth.issueSession({ subject: "script" })).token;
    const request = (token: string, path = "/api/auth/session") =>
      HttpServerRequest.fromWeb(
        new Request(`http://127.0.0.1${path}`, { headers: { authorization: `Bearer ${token}` } }),
      );
    const refused = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.result,
        Effect.map((result) => result._tag),
      );
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
      "mcpOAuth POST /oauth/mcp/token",
      "metadata GET /.well-known/t3/environment",
      "webhooks GET /api/hooks/:hookId/:token",
      "webhooks PATCH /api/hooks/:hookId/:token",
      "webhooks POST /api/hooks/:hookId/:token",
      "webhooks PUT /api/hooks/:hookId/:token",
    ]);
    const routes = HttpApiBuilder.layer(AuthRoutes).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
      Layer.provide(Layer.succeedContext(yield* Effect.context<EnvironmentAuth | SessionStore>())),
      Layer.provide(HttpPlatform.layer.pipe(Layer.provideMerge(Etag.layerWeak))),
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    );
    const http = yield* HttpRouter.toHttpEffect(routes);
    const post = Effect.fn("test.post")(function* (path: string, token: string) {
      const sent = yield* Deferred.make<HttpServerResponse.HttpServerResponse>();
      yield* HttpEffect.toHandled(http, (_request, response) =>
        Deferred.succeed(sent, response),
      ).pipe(
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
    for (const path of ["/api/auth/websocket-ticket", "/api/auth/websocket-ticket/media"]) {
      assert.strictEqual(yield* post(path, secret), 401);
      assert.strictEqual(yield* post(path, script), 200);
    }
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
