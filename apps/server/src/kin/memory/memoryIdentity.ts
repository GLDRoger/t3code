import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { KinGitHubApp } from "../github/KinGitHubApp.ts";
import type { MemoryConfig } from "./MemoryConfig.ts";

/**
 * Who Kin's memory commits are by: the configured name, else Kin's GitHub App's bot in GitHub's
 * own form while the App works (so blame links to it, as agents' commits do), else a local name.
 */
export const memoryIdentity = Effect.fn("Memory.identity")(function* (
  config: Pick<MemoryConfig["Service"], "botName" | "botEmail">,
  app: Option.Option<KinGitHubApp["Service"]>,
) {
  const state = Option.isSome(app) ? yield* app.value.state() : undefined;
  const bot = state?._tag === "ok" ? state.app : undefined;
  const name = config.botName ?? bot?.botLogin ?? "Kin Memory Bot";
  const email = config.botEmail ?? bot?.botEmail ?? "kin-memory@localhost";
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
});
