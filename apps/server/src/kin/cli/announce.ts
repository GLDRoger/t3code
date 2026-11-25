import { KinRefreshRpcs, type KinOrgId, type KinRefreshTopic } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient } from "effect/http";
import { RpcGroup } from "effect/rpc";

import type { resolveCliAuthConfig } from "../../cli/config.ts";
import * as ServerConfig from "../../config.ts";
import { readPersistedServerRuntimeState } from "../../serverRuntimeState.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuthRuntime.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import { openRemote } from "./openRemote.ts";

class KinAnnounceError extends Schema.TaggedError<KinAnnounceError>()("KinAnnounceError", {
  message: Schema.String,
}) {}
const group = RpcGroup.make(...KinRefreshRpcs);
type CliConfig = Effect.Success<ReturnType<typeof resolveCliAuthConfig>>;

/**
 * What a `kin` CLI write touched, kept in this process: its commits never reach the server's hub,
 * so the running server is told afterwards (`announceToServer`).
 */
export const cliChanges = () => {
  const touched = new Map<KinOrgId, { topics: Set<KinRefreshTopic>; records: boolean }>();
  const entry = (orgId: KinOrgId) => {
    const held = touched.get(orgId) ?? { topics: new Set<KinRefreshTopic>(), records: false };
    touched.set(orgId, held);
    return held;
  };
  return {
    // A rolled-back write is announced too: a needless re-read costs less than a missed one.
    layer: Layer.succeed(KinRefreshObserver, {
      touch: Effect.fn("KinCli.touch")((orgId: KinOrgId, topic: KinRefreshTopic) =>
        Effect.sync(() => {
          entry(orgId).topics.add(topic);
        }),
      ),
    }),
    records: (orgId: KinOrgId) => {
      entry(orgId).records = true;
    },
    all: () =>
      [...touched].map(([orgId, held]) => ({
        orgId,
        topics: [...held.topics],
        records: held.records,
      })),
  };
};

/** Like `cliChanges`, but only what committed: a host auth revoke that rolls back tells nobody. */
export const cliCommits = () => {
  const touched = new Map<KinOrgId, Set<KinRefreshTopic>>();
  return {
    layer: Layer.effect(
      KinRefreshObserver,
      Effect.map(SqlClient.SqlClient, (sql) => ({
        touch: (orgId: KinOrgId, topic: KinRefreshTopic) =>
          sql.afterCommit(
            Effect.sync(() => {
              touched.set(orgId, (touched.get(orgId) ?? new Set()).add(topic));
            }),
          ),
      })),
    ),
    all: () =>
      [...touched].map(([orgId, topics]) => ({ orgId, topics: [...topics], records: false })),
  };
};

/** Tells the running server what this process changed; with none running, no screen is open. */
export const announceToServer = Effect.fn("kin.cli.announce")(function* (
  config: CliConfig,
  changes: ReturnType<ReturnType<typeof cliChanges>["all"]>,
) {
  if (changes.length === 0) return;
  yield* Effect.gen(function* () {
    const state = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(state)) return;
    const client = yield* openRemote(
      state.value.origin,
      group,
      "Kin CLI",
      new KinAnnounceError({ message: "unreachable" }),
    );
    for (const change of changes) yield* client["kin.refreshes.announce"](change);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.merge(
        EnvironmentAuth.layerRuntime.pipe(
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, "Warn")),
        ),
        FetchHttpClient.layer,
      ),
    ),
    Effect.catchCause(() =>
      Console.error(
        "Saved. Kin's running server couldn't be told, so screens already open show it once they are opened again.",
      ),
    ),
  );
});
