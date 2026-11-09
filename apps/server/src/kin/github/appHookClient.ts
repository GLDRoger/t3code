import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { GithubAppHookClient, GithubAppHookRefused } from "../triggers/githubWebhooks.ts";
import * as Keychain from "./Keychain.ts";
import * as KinGitHubApp from "./KinGitHubApp.ts";
import { KinGitHubScope } from "./KinGitHubScope.ts";

/**
 * The real client behind the triggers spec's `github.app_hook.configure`. Using it still needs
 * `AppHookConfigureGate` open; this only supplies the signed `PATCH /app/hook/config`.
 */
export const layer = Layer.effect(
  GithubAppHookClient,
  Effect.gen(function* () {
    const app = yield* KinGitHubApp.KinGitHubApp;
    return GithubAppHookClient.of({
      patchHookConfig: Effect.fn("KinAppHookClient.patchHookConfig")(function* (body) {
        yield* app.patchHookConfig(body).pipe(
          Effect.mapError(
            (error) =>
              new GithubAppHookRefused({
                reason:
                  error._tag === "KinGitHubAppNotConfiguredError" ||
                  error._tag === "KinKeychainError" ||
                  (error._tag === "KinGitHubRequestError" && error.stage === "transport")
                    ? "unavailable"
                    : "failed",
              }),
          ),
        );
      }),
    });
  }),
);

/** @public `layer` with the App's own stack: `KIN_GITHUB_APP_ID`, the keychain and fetch. */
export const liveLayer = layer.pipe(
  Layer.provide(KinGitHubApp.layer),
  Layer.provide(
    Layer.mergeAll(
      KinGitHubApp.KinGitHubAppConfig.layer,
      KinGitHubScope.layer,
      FetchHttpClient.layer,
      // The keychain's Secret Service probe needs a spawner, as in `approvals/layer.ts`.
      Keychain.layer.pipe(Layer.provide(NodeServices.layer)),
    ),
  ),
);
