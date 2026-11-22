import {
  AuthKinChatScope,
  type AuthEnvironmentScope,
  AuthStandardClientScopes,
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  WsRpcGroup,
  type ServerConfig,
} from "@t3tools/contracts";
import { chatOnlyServerConfig, isChatOnly } from "./chatOnlyConfig.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import { RPC_REQUIRED_SCOPES } from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

it("a chat-only grant reaches Kin's methods and nothing else", () => {
  // Kin's gate (`KIN_RPC_ACCESS`, rpcAccess.test.ts) decides per person which of these they reach.
  const methods = Object.keys(RPC_REQUIRED_SCOPES);
  expect(
    methods.filter(
      (method) => RPC_REQUIRED_SCOPES[method as keyof typeof RPC_REQUIRED_SCOPES] === "kin:chat",
    ),
  ).toEqual(
    // Only the host CLI's write notice needs the owner's own session.
    methods.filter((method) => method.startsWith("kin.") && method !== "kin.refreshes.announce"),
  );
  // Kin schedules live in T3's scheduled tasks: a teammate's session reaches none of them.
  const scheduledTasks = Object.entries(RPC_REQUIRED_SCOPES).filter(([method]) =>
    method.startsWith("scheduledTasks."),
  );
  expect(scheduledTasks.length).toBeGreaterThanOrEqual(5);
  for (const [, permission] of scheduledTasks) expect(permission).not.toBe("kin:chat");
});
it.effect.each(["chat-only", "legacy-owner"] as const)(
  "%s authorizes Kin chat without widening access",
  (kind) =>
    Effect.gen(function* () {
      const tested = [
        "kin.orgs.list",
        "orchestration.subscribeShell",
        "terminal.open",
        "projects.readFile",
      ] as const;
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
            !(tested as ReadonlyArray<string>).includes(tag),
        ),
      );
      const handlers = group.toLayer({
        "kin.orgs.list": () => Effect.succeed({ orgs: [], me: [] }),
        "orchestration.subscribeShell": () => Stream.empty,
        "terminal.open": () => Effect.never,
        "projects.readFile": () => Effect.never,
      });
      const scopes = kind === "legacy-owner" ? AuthStandardClientScopes : [AuthKinChatScope];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(Layer.merge(handlers, RpcAuthorization.layer(scopes))),
      );
      expect(yield* client["kin.orgs.list"]({})).toEqual({ orgs: [], me: [] });
      if (kind === "chat-only") {
        expect(
          yield* client["terminal.open"]({
            threadId: ThreadId.make("private"),
            terminalId: "private",
            cwd: "/tmp",
          }).pipe(Effect.flip),
        ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
        expect(
          yield* client["projects.readFile"]({ cwd: "/tmp", relativePath: "secret" }).pipe(
            Effect.flip,
          ),
        ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
        expect(
          yield* client["orchestration.subscribeShell"]({}).pipe(Stream.runDrain, Effect.flip),
        ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
      }
    }).pipe(Effect.scoped),
);

const CHAT_ATTACHMENT_METHODS = ["attachments.createUploadUrl", "attachments.delete"];

it.effect("a chat-only session connects with a config that carries nothing of the host", () =>
  Effect.gen(function* () {
    yield* RpcAuthorization.authorizeRpc([AuthKinChatScope], "subscribeServerConfig", {});
    yield* RpcAuthorization.authorizeRpc([AuthKinChatScope], "server.probe", {});
    yield* RpcAuthorization.authorizeRpc([AuthKinChatScope], "server.reportClientActivity", {});
    expect(
      yield* RpcAuthorization.authorizeRpc([AuthKinChatScope], "subscribeServerLifecycle", {}).pipe(
        Effect.flip,
      ),
    ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
    expect(isChatOnly([AuthKinChatScope])).toBe(true);
    expect(isChatOnly([])).toBe(false);
    expect(isChatOnly([AuthKinChatScope, "orchestration:read"])).toBe(false);
    const environment = { environmentId: "environment-one" } as ServerConfig["environment"];
    const auth = { policy: "loopback-browser" } as ServerConfig["auth"];
    expect(chatOnlyServerConfig(environment, auth)).toEqual({
      environment,
      auth,
      cwd: "/",
      keybindingsConfigPath: "/",
      keybindings: [],
      issues: [],
      providers: [],
      availableEditors: [],
      observability: {
        logsDirectoryPath: "/",
        localTracingEnabled: false,
        otlpTracesEnabled: false,
        otlpMetricsEnabled: false,
        otlpLogsEnabled: false,
      },
      settings: DEFAULT_SERVER_SETTINGS,
    });
  }),
);

it.effect("a chat-only session may upload, and ask only for stored attachments", () =>
  Effect.gen(function* () {
    const allowed = (
      scopes: ReadonlyArray<AuthEnvironmentScope>,
      method: string,
      payload: unknown,
    ) =>
      RpcAuthorization.authorizeRpc(scopes, method, payload).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    const asset = (resource: unknown) => ({ resource });
    const stored = asset({ _tag: "attachment", attachmentId: "kin-chat-1" });
    for (const method of CHAT_ATTACHMENT_METHODS) {
      expect(yield* allowed([AuthKinChatScope], method, undefined)).toBe(true);
      // No scope at all is not chat access.
      expect(yield* allowed([], method, undefined)).toBe(false);
    }
    expect(yield* allowed([AuthKinChatScope], "assets.createUrl", stored)).toBe(true);
    expect(yield* allowed([], "assets.createUrl", stored)).toBe(false);
    for (const resource of [
      { _tag: "workspace-file", threadId: "thread", path: "secret.txt" },
      { _tag: "media-file", threadId: "thread", path: "/tmp/secret.png" },
      { _tag: "draft-workspace-file", cwd: "/tmp", path: "secret.txt" },
      { _tag: "tool-output-image", threadId: "thread", itemId: "item", index: 0 },
      { _tag: "project-favicon", cwd: "/tmp" },
    ])
      expect(yield* allowed([AuthKinChatScope], "assets.createUrl", asset(resource))).toBe(false);
    expect(yield* allowed([AuthKinChatScope], "assets.persistChatAttachments", undefined)).toBe(
      false,
    );
  }),
);

it.effect.each(
  Object.keys(RPC_REQUIRED_SCOPES).filter(
    (method) =>
      !method.startsWith("kin.") &&
      !CHAT_ATTACHMENT_METHODS.includes(method) &&
      method !== "subscribeServerConfig" &&
      method !== "server.probe" &&
      method !== "server.reportClientActivity",
  ),
)("chat-only sessions are refused before dispatch or stream subscription: %s", (method) =>
  Effect.gen(function* () {
    expect(
      yield* RpcAuthorization.authorizeRpc([AuthKinChatScope], method, undefined).pipe(Effect.flip),
    ).toMatchObject({ _tag: "EnvironmentAuthorizationError" });
  }),
);
