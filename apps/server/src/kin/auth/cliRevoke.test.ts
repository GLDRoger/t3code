// @effect-diagnostics nodeBuiltinImport:off - the CLI round trip needs a real home directory.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { AuthSessionId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import { cli } from "../../binCli.ts";
import { persistServerRuntimeState } from "../../serverRuntimeState.ts";
import { revokedBySession } from "./ProofKeySessions.ts";
import { layerAuthTest } from "./ProofKeySessions.testkit.ts";

const kinOn = Layer.succeed(
  ConfigProvider.ConfigProvider,
  ConfigProvider.fromEnv({ env: { KIN_ENABLED: "true" } }),
);

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer))(
  "Kin host CLI session revoke",
  (it) => {
    it.effect.each(["through the running server", "offline"] as const)(
      "keeps the session-level rule %s",
      (route) =>
        Effect.gen(function* () {
          const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kin-cli-revoke-"));
          const server = yield* Layer.build(layerAuthTest(baseDir));
          const run = <A, E>(
            effect: Effect.Effect<
              A,
              E,
              EnvironmentAuth.EnvironmentAuth | SessionStore.SessionStore | SqlClient.SqlClient
            >,
          ) => Effect.provide(effect, server);
          const pair = (thumbprint: string) =>
            run(
              Effect.gen(function* () {
                const auth = yield* EnvironmentAuth.EnvironmentAuth;
                const link = yield* auth.createPairingLink({ subject: "one-time-token" });
                const exchanged = yield* auth.exchangeBootstrapCredentialForAccessToken(
                  link.credential,
                  undefined,
                  { deviceType: "mobile" },
                  { proofKeyThumbprint: thumbprint },
                );
                return yield* (yield* SessionStore.SessionStore).verify(exchanged.access_token);
              }),
            );
          const pairs = (thumbprint: string) =>
            pair(thumbprint).pipe(
              Effect.exit,
              Effect.map((exit) => Exit.isSuccess(exit)),
            );
          // The predicate approver keys and grant checks read: does this revoke reach the key?
          const reachesApproverKey = (sessionId: AuthSessionId, proofKey: string) =>
            run(
              Effect.gen(function* () {
                const sql = yield* SqlClient.SqlClient;
                const [row] = yield* sql<{
                  reached: number;
                }>`SELECT ${revokedBySession(sql, { sessionId, proofKey })} AS reached`;
                return row?.reached === 1;
              }),
            );

          // The running server's revokeClient route: the CLI's bearer session, then the service.
          const requests: Array<string> = [];
          if (route === "through the running server") {
            const port = yield* (yield* NetService.NetService).reserveLoopbackPort("127.0.0.1");
            yield* persistServerRuntimeState({
              path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
              state: {
                version: 1,
                pid: process.pid,
                ownerId: "test-owner",
                port,
                origin: `http://127.0.0.1:${port}`,
                startedAt: "2026-11-20T00:00:00.000Z",
              },
            });
          }
          const serve = yield* FiberSet.makeRuntimePromise<
            EnvironmentAuth.EnvironmentAuth | SessionStore.SessionStore,
            Response
          >().pipe(Effect.provide(server));
          const serverFetch: typeof globalThis.fetch = (input, init) => {
            requests.push(new URL(String(input)).pathname);
            const token = new Headers(init?.headers).get("authorization")?.slice("Bearer ".length);
            const { sessionId } = JSON.parse(String(init?.body)) as { sessionId: AuthSessionId };
            return serve(
              Effect.gen(function* () {
                const caller = yield* (yield* SessionStore.SessionStore).verify(token ?? "");
                expect(caller.scopes).toContain("access:write");
                const revoked = yield* (yield* EnvironmentAuth.EnvironmentAuth).revokeClientSession(
                  caller.sessionId,
                  sessionId,
                );
                return Response.json({ revoked });
              }),
            );
          };
          const cliRevoke = (sessionId: AuthSessionId) =>
            Command.runWith(cli, { version: "0.0.0" })([
              "auth",
              "session",
              "revoke",
              "--base-dir",
              baseDir,
              sessionId,
            ]).pipe(
              Effect.provide(Layer.mergeAll(TestConsole.layer, kinOn)),
              Effect.provideService(FetchHttpClient.Fetch, serverFetch),
            );

          const lapsed = yield* pair("lapsed-phone");
          yield* pair("removed-phone");
          const listed = yield* pair("listed-phone");
          yield* TestClock.adjust(Duration.sum(Duration.days(30), Duration.minutes(1)));
          const active = yield* pair("active-phone");
          const socket = yield* run(
            Effect.gen(function* () {
              return yield* (yield* SessionStore.SessionStore).awaitInvalidation(active.sessionId);
            }),
          ).pipe(Effect.forkChild);

          // A lapsed session alone: marked, but the device pairs again and keeps its approver key.
          yield* cliRevoke(lapsed.sessionId);
          expect(yield* reachesApproverKey(lapsed.sessionId, "lapsed-phone")).toBe(false);
          expect(yield* pairs("lapsed-phone")).toBe(true);

          // An active session: it and its socket end, and its device is blocked.
          yield* cliRevoke(active.sessionId);
          if (route === "through the running server") yield* Fiber.join(socket);
          else yield* Fiber.interrupt(socket);
          expect(yield* reachesApproverKey(active.sessionId, "active-phone")).toBe(true);
          expect(yield* pairs("active-phone")).toBe(false);

          expect(requests).toEqual(
            route === "through the running server"
              ? ["/api/auth/clients/revoke", "/api/auth/clients/revoke"]
              : [],
          );

          // Removing a whole device, or revoking it from another client, still blocks its key.
          yield* run(
            Effect.gen(function* () {
              const auth = yield* EnvironmentAuth.EnvironmentAuth;
              yield* auth.revokeConnectDevice("removed-phone");
              const owner = yield* auth.issueSession({ label: "Owner" });
              yield* auth.revokeClientSession(owner.sessionId, listed.sessionId);
            }),
          );
          expect(yield* pairs("removed-phone")).toBe(false);
          expect(yield* pairs("listed-phone")).toBe(false);
        }).pipe(Effect.scoped),
    );
  },
);
