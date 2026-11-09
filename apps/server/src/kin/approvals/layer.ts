import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as Keychain from "../github/Keychain.ts";
import * as KinBotReads from "../github/KinBotReads.ts";
import * as KinGitHubApp from "../github/KinGitHubApp.ts";
import { KinGitHubScope } from "../github/KinGitHubScope.ts";
import * as OwnerMergeClient from "../github/OwnerMergeClient.ts";
import * as KinPersistence from "../persistence/KinPersistence.ts";
import * as ActionExecutor from "./ActionExecutor.ts";
import * as ActionHandlers from "./ActionHandlers.ts";
import * as ApproverKeys from "./ApproverKeys.ts";
import * as Audit from "./Audit.ts";
import * as AttestationTrust from "./attestation/AttestationTrust.ts";
import * as CredentialHygiene from "./CredentialHygiene.ts";
import * as GrantPorts from "./GrantPorts.ts";
import * as GrantVerifier from "./GrantVerifier.ts";
import { makeDeleteBranchHandler } from "./handlers/deleteBranch.ts";
import { makeMergePullRequestHandler } from "./handlers/mergePullRequest.ts";
import { makeRegisterApproverKeyHandler } from "./handlers/registerApproverKey.ts";
import * as PendingActions from "./PendingActions.ts";

const refused = (error: { readonly message: string }) =>
  new ActionHandlers.KinExecError({ reason: "refused", detail: error.message });

/** APPR-5's handler takes the stored grant only and reports a bare success. */
const registerApproverKeyHandler = Effect.map(
  makeRegisterApproverKeyHandler,
  (handler): ActionHandlers.KinActionHandler => ({
    kind: handler.kind,
    precheck: (action) => handler.precheck(action).pipe(Effect.mapError(refused)),
    run: (action, { grant }) =>
      handler.run(action, grant).pipe(Effect.as({}), Effect.mapError(refused)),
    reconcile: (action) =>
      handler.reconcile(action).pipe(Effect.orElseSucceed(() => "unknown" as const)),
  }),
);

// The bot App reads, the owner merge token writes, and the hygiene check gates both.
const github = Layer.mergeAll(KinBotReads.layer, CredentialHygiene.layer).pipe(
  Layer.provideMerge(OwnerMergeClient.layer),
  Layer.provide(CredentialHygiene.identityUnavailableLayer),
  Layer.provide(KinGitHubApp.layer),
  Layer.provideMerge(
    Layer.mergeAll(
      KinGitHubApp.KinGitHubAppConfig.layer,
      KinGitHubScope.layer,
      FetchHttpClient.layer,
      // Like the fetch client above: the keychain's Secret Service probe needs a spawner.
      Keychain.layer.pipe(Layer.provide(NodeServices.layer)),
    ),
  ),
);

const handlers = Layer.effect(
  ActionHandlers.KinActionHandlers,
  Effect.all([
    registerApproverKeyHandler,
    makeMergePullRequestHandler,
    makeDeleteBranchHandler,
  ]).pipe(Effect.map(ActionHandlers.make)),
).pipe(Layer.provideMerge(github));

// Without the GitHub App and scope configured, the GitHub kinds have no handler but stay held
// until their grants lapse, and the hygiene check can't pass, so nothing else runs either.
const unconfigured = Layer.mergeAll(
  Layer.effect(
    ActionHandlers.KinActionHandlers,
    Effect.map(registerApproverKeyHandler, (handler) =>
      ActionHandlers.make([handler], ["merge_pull_request", "delete_branch"]),
    ),
  ),
  Layer.succeed(
    CredentialHygiene.CredentialHygiene,
    CredentialHygiene.CredentialHygiene.of({
      check: Effect.fn("CredentialHygiene.unconfigured")(function* () {
        return yield* Effect.succeed<CredentialHygiene.CredentialHygieneReport>({
          passed: false,
          failures: ["identity_unknown", "merge_token_missing"],
          warnings: [],
          envTokenNames: [],
          t3Login: null,
          identities: [],
          checkedAt: 0,
        });
      }),
      requirePassing: Effect.fn("CredentialHygiene.unconfiguredRequirePassing")(function* () {
        return yield* new CredentialHygiene.CredentialHygieneFailedError({
          failures: ["identity_unknown", "merge_token_missing"],
        });
      }),
    }),
  ),
);

const executorDeps = handlers.pipe(
  Layer.catchCause((cause) =>
    unconfigured.pipe(
      Layer.tap(() =>
        Effect.logWarning("Kin executor: GitHub isn't configured; privileged actions won't run.", {
          cause: Cause.pretty(cause).slice(0, 500),
        }),
      ),
    ),
  ),
);

/**
 * Push routing reads pending actions, so they stay in the layer's output. The executor needs a
 * `KinExecutionNotices` from outside, since the chat it posts to can't be imported here.
 */
export const layer = Layer.mergeAll(
  GrantVerifier.layer,
  // The ledger (claim and finish) goes to the executor alone, never into the layer's output.
  ActionExecutor.layer.pipe(Layer.provide(Layer.merge(executorDeps, PendingActions.ledgerLayer))),
).pipe(
  Layer.provideMerge(ApproverKeys.layer),
  Layer.provideMerge(PendingActions.layer),
  Layer.provide(
    Layer.mergeAll(
      AttestationTrust.layer.pipe(Layer.provide(FetchHttpClient.layer)),
      GrantPorts.orgRolesLayer,
      GrantPorts.liveTargetsUnconfiguredLayer,
      GrantPorts.auditLayer,
    ),
  ),
  Layer.provide(Audit.layer),
  Layer.provide(KinPersistence.layer),
);
