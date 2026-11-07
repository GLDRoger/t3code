import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthStandardClientScopes,
  KinChatRpcs,
  RpcScopeAuthorization,
  WsRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import * as SqlClient from "effect/sql/SqlClient";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Kin from "./layer.ts";
import { runKinMigrations } from "./persistence/KinMigrations.ts";
import * as Logger from "effect/Logger";
import { makeKinChatHandlers } from "./chat/rpcHandlers.ts";

const session = {
  sessionId: AuthSessionId.make("owner"),
  subject: "browser",
  method: "browser-session-cookie" as const,
  scopes: AuthStandardClientScopes,
};
const probe = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (
      tag,
    ): tag is Exclude<RpcGroup.Rpcs<typeof WsRpcGroup>["_tag"], typeof WS_METHODS.serverProbe> =>
      tag !== WS_METHODS.serverProbe,
  ),
);
const group = RpcGroup.make(...KinChatRpcs, ...probe.requests.values()).middleware(
  RpcScopeAuthorization,
);

it.effect.each(["identity", "defect", "unconfigured"] as const)(
  "contains %s startup and leaves non-Kin RPCs working",
  (mode) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      if (mode === "identity") {
        yield* runKinMigrations();
        yield* sql`INSERT INTO kin_orgs VALUES ('unrecoverable', 'Other', '1970-01-01T00:00:00.000Z')`;
      }
      const broken = new Proxy(sql, {
        apply() {
          throw new Error("private SQL defect");
        },
      });
      const logs: Array<unknown> = [];
      const kin = yield* Kin.KinServer.pipe(
        Effect.provide(
          Kin.layer.pipe(
            Layer.provide(
              ConfigProvider.layer(
                ConfigProvider.fromUnknown({ KIN_ENABLED: mode !== "unconfigured" }),
              ),
            ),
            Layer.provide(Layer.succeed(SqlClient.SqlClient, mode === "identity" ? sql : broken)),
            Layer.provide(
              Logger.layer([
                Logger.make((entry) => {
                  logs.push(entry.message);
                }),
              ]),
            ),
          ),
        ),
      );
      assert.strictEqual(logs.length, mode === "unconfigured" ? 0 : 1);
      assert.isTrue(Option.isNone(kin.services));
      const handlers = yield* makeKinChatHandlers(session).pipe(
        Effect.provideService(Kin.KinServer, kin),
      );
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.merge(
            group.toLayer({ ...handlers, "server.probe": () => Effect.succeed({}) }),
            RpcAuthorization.layer(AuthStandardClientScopes),
          ),
        ),
      );
      assert.deepStrictEqual(yield* client["server.probe"]({}), {});
      assert.include(yield* client["kin.orgs.list"]({}).pipe(Effect.flip), {
        reason: "not_allowed",
        message: "Kin is unavailable.",
      });
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);
