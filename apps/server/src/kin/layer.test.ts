import { dormantLeadDependencies } from "./lead/layer.testkit.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as KinTriggerSink from "./triggers/KinTriggerSink.ts";
import { expectTypeOf } from "vite-plus/test";
import { layerWsRpc } from "../ws.ts";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
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
            Layer.provide(dormantLeadDependencies),
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
      if (mode === "identity")
        assert.include(JSON.stringify(logs), "restore the reserved identity");
      if (mode === "defect") assert.include(JSON.stringify(logs), "private SQL defect");
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
        reason: "disabled",
        message: "Kin is not running on this host.",
      });
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it("retains concrete WS handler layer requirements with Kin RPCs", () => {
  expectTypeOf<
    0 extends 1 & Layer.Services<ReturnType<typeof layerWsRpc>> ? true : false
  >().toEqualTypeOf<false>();
  expectTypeOf<
    Extract<Layer.Services<ReturnType<typeof layerWsRpc>>, Kin.KinServer>
  >().toEqualTypeOf<never>();
});

it.effect.each(["disabled", "invalid", "failed"] as const)(
  "keeps the runtime contained when Kin is %s",
  (mode) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const input: ThreadLaunch.ThreadLaunchInput = {
        commandId: CommandId.make("scheduled-task:task:webhook:delivery"),
        projectId: ProjectId.make("project"),
        title: "Scheduled",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          scheduledTaskId: ScheduledTaskId.make("task"),
          text: "Run",
          attachments: [],
        },
        createdBy: "system",
        creationSource: "server",
      };
      const rejected = new ThreadLaunch.ThreadLaunchError({
        operation: "dispatch-message",
        commandId: input.commandId,
        projectId: input.projectId,
        cause: new Error("inner launcher"),
      });
      const seen: ThreadLaunch.ThreadLaunchInput[] = [];
      const launch = (request: ThreadLaunch.ThreadLaunchInput) => {
        seen.push(request);
        return Effect.fail(rejected);
      };
      const sendToThread = () => Effect.die("management should not be called");
      const logs: Array<unknown> = [];
      const broken = new Proxy(sql, {
        apply() {
          throw new Error("Kin migration defect");
        },
      });
      const runtime = Layer.mergeAll(
        Kin.layer.pipe(Layer.provide(dormantLeadDependencies)),
        KinTriggerSink.wrapTaskDispatch(
          Layer.mock(ThreadLaunch.ThreadLaunchService)({ launch }),
          Layer.mock(ThreadManagement.ThreadManagementService)({ sendToThread }),
        ),
      ).pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown(
              mode === "failed"
                ? { KIN_ENABLED: true }
                : mode === "invalid"
                  ? { KIN_ENABLED: "maybe" }
                  : {},
            ),
          ),
        ),
        Layer.provide(Layer.succeed(SqlClient.SqlClient, mode === "failed" ? broken : sql)),
        Layer.provide(
          Logger.layer([
            Logger.make((entry) => {
              logs.push(entry.message);
            }),
          ]),
        ),
      );
      yield* Effect.gen(function* () {
        assert.deepStrictEqual(
          yield* sql`SELECT name FROM sqlite_master WHERE name GLOB 'kin_*' ORDER BY name`,
          [],
        );
        assert.isTrue(Option.isNone((yield* Kin.KinServer).services));
        const launcher = yield* ThreadLaunch.ThreadLaunchService;
        const management = yield* ThreadManagement.ThreadManagementService;
        if (mode !== "failed") {
          assert.strictEqual(launcher.launch, launch);
          assert.strictEqual(management.sendToThread, sendToThread);
          assert.strictEqual(yield* launcher.launch(input).pipe(Effect.flip), rejected);
        } else {
          const failure = yield* launcher.launch(input).pipe(Effect.flip);
          assert.notStrictEqual(failure, rejected);
          assert.include(String(failure.cause), "webhook dispatch refused");
          const ordinary = {
            ...input,
            commandId: CommandId.make("ordinary-scheduled"),
            initialMessage: { ...input.initialMessage, text: "Run", attachments: [] },
          };
          assert.strictEqual(yield* launcher.launch(ordinary).pipe(Effect.flip), rejected);
          assert.strictEqual(seen[0], ordinary);
          const lookalike = {
            ...ordinary,
            commandId: CommandId.make("scheduled-task:other:webhook:x"),
          };
          assert.strictEqual(yield* launcher.launch(lookalike).pipe(Effect.flip), rejected);
        }
      }).pipe(Effect.provide(runtime));
      assert.strictEqual(seen.length, mode === "failed" ? 2 : 1);
      if (mode !== "failed") assert.strictEqual(seen[0], input);
      assert.strictEqual(logs.length, mode === "disabled" ? 0 : 1);
      if (mode === "invalid") assert.include(JSON.stringify(logs), "invalid KIN_ENABLED");
      if (mode === "failed") assert.include(JSON.stringify(logs), "Kin migration defect");
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name GLOB 'kin_*' ORDER BY name`,
        [],
      );
    }).pipe(Effect.provide(Sqlite.layerMemory)),
);
