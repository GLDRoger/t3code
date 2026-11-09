import type { KinGrant, KinPendingAction } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as VcsProcess from "../../vcs/VcsProcess.ts";
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
import type { CredentialHygieneReport } from "./CredentialHygieneReport.ts";
import * as GitHubIdentityProbe from "./GitHubIdentityProbe.ts";
import * as T3GitHubCredential from "./T3GitHubCredential.ts";
import * as GrantPorts from "./GrantPorts.ts";
import * as GrantVerifier from "./GrantVerifier.ts";
import { makeDeleteBranchHandler } from "./handlers/deleteBranch.ts";
import { makeMergePullRequestHandler } from "./handlers/mergePullRequest.ts";
import { makeRegisterApproverKeyHandler } from "./handlers/registerApproverKey.ts";
import { makeSetLevelHandler } from "./handlers/setLevel.ts";
import * as PendingActions from "./PendingActions.ts";

const refused = (error: { readonly message: string }) =>
  new ActionHandlers.KinExecError({ reason: "refused", detail: error.message });

/** APPR-5's and LEAD-12's handlers take the stored grant only and report a bare success. */
const grantOnly = <R>(
  make: Effect.Effect<
    {
      readonly kind: ActionHandlers.KinActionHandler["kind"];
      readonly credentialCheck: boolean;
      readonly precheck: (
        action: KinPendingAction,
      ) => Effect.Effect<void, { readonly message: string }>;
      readonly run: (
        action: KinPendingAction,
        grant: KinGrant,
      ) => Effect.Effect<unknown, { readonly message: string }>;
      readonly reconcile: (
        action: KinPendingAction,
      ) => Effect.Effect<"done" | "not_done" | "unknown", { readonly message: string }>;
    },
    never,
    R
  >,
) =>
  Effect.map(make, (handler): ActionHandlers.KinActionHandler => ({
    kind: handler.kind,
    credentialCheck: handler.credentialCheck,
    precheck: (action) => handler.precheck(action).pipe(Effect.mapError(refused)),
    run: (action, { grant }) =>
      handler.run(action, grant).pipe(Effect.as({}), Effect.mapError(refused)),
    reconcile: (action) =>
      handler.reconcile(action).pipe(Effect.orElseSucceed(() => "unknown" as const)),
  }));
const registerApproverKeyHandler = grantOnly(makeRegisterApproverKeyHandler);
const setLevelHandler = grantOnly(makeSetLevelHandler);

/** The GitHub host the GitHub kinds run against; tests swap in fakes. */
const githubPlatform = Layer.mergeAll(
  KinGitHubApp.KinGitHubAppConfig.layer,
  KinGitHubScope.layer,
  FetchHttpClient.layer,
  // Like the fetch client above: the keychain's Secret Service probe needs a spawner.
  Keychain.layer.pipe(Layer.provide(NodeServices.layer)),
);
type GitHubPlatform = Layer.Success<typeof githubPlatform>;

// Its process runner and filesystem are the server's, by layer memoization.
const liveIdentity = GitHubIdentityProbe.layer.pipe(
  Layer.provide(VcsProcess.layer),
  Layer.provide(NodeServices.layer),
);

// The bot App reads, the owner merge token writes, and the hygiene check gates both.
const github = <E, R, IE, IR>(
  platform: Layer.Layer<GitHubPlatform, E, R>,
  identity: Layer.Layer<CredentialHygiene.T3GitHubIdentity, IE, IR>,
) =>
  Layer.mergeAll(KinBotReads.layer, CredentialHygiene.layer).pipe(
    Layer.provideMerge(OwnerMergeClient.layer),
    Layer.provide(identity),
    Layer.provide(KinGitHubApp.layer),
    Layer.provideMerge(platform),
  );

const handlers = <E, R, IE, IR>(
  platform: Layer.Layer<GitHubPlatform, E, R>,
  identity: Layer.Layer<CredentialHygiene.T3GitHubIdentity, IE, IR>,
) =>
  Layer.effect(
    ActionHandlers.KinActionHandlers,
    Effect.all([
      registerApproverKeyHandler,
      setLevelHandler,
      makeMergePullRequestHandler,
      makeDeleteBranchHandler,
    ]).pipe(Effect.map(ActionHandlers.make)),
  ).pipe(Layer.provideMerge(github(platform, identity)));

// Without the GitHub App and scope configured, the GitHub kinds have no handler but stay held
// until their grants lapse, and the hygiene check can't pass, so only set_level runs.
const UNCONFIGURED = "the GitHub App and scope aren't configured";
const unconfigured = Layer.mergeAll(
  Layer.effect(
    ActionHandlers.KinActionHandlers,
    Effect.map(Effect.all([registerApproverKeyHandler, setLevelHandler]), (local) =>
      ActionHandlers.make(local, ["merge_pull_request", "delete_branch"]),
    ),
  ),
  Layer.succeed(
    CredentialHygiene.CredentialHygiene,
    CredentialHygiene.CredentialHygiene.of({
      check: Effect.fn("CredentialHygiene.unconfigured")(function* () {
        return yield* Effect.succeed<CredentialHygieneReport>({
          passed: false,
          failures: ["identity_unknown", "merge_token_missing"],
          reasons: [UNCONFIGURED],
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
          reasons: [UNCONFIGURED],
        });
      }),
    }),
  ),
);

/**
 * The executor and its worker, with nothing in the output: context lookups go by key string, so
 * anything here would reach every service holding `kin.services`. Built on top of the layer that
 * supplies `KinPendingActions`, so it takes the very approvals that instance publishes.
 */
export const makeExecutorLayer = <E, R, IE, IR>(
  platform: Layer.Layer<GitHubPlatform, E, R>,
  identity: Layer.Layer<CredentialHygiene.T3GitHubIdentity, IE, IR>,
) =>
  Layer.empty.pipe(
    Layer.provide(
      ActionExecutor.layer.pipe(
        Layer.provide(
          Layer.merge(
            handlers(platform, identity).pipe(
              Layer.catchCause((cause) =>
                unconfigured.pipe(
                  Layer.tap(() =>
                    Effect.logWarning(
                      "Kin executor: GitHub isn't configured; privileged actions won't run.",
                      { cause: Cause.pretty(cause).slice(0, 500) },
                    ),
                  ),
                ),
              ),
            ),
            PendingActions.ledgerLayer,
          ),
        ),
        Layer.provide(GrantPorts.orgRolesLayer),
        Layer.provide(Audit.layer),
        Layer.provide(KinPersistence.layer),
      ),
    ),
  );

export const executorLayer = makeExecutorLayer(githubPlatform, liveIdentity);

/** Push routing and Promotion read pending actions, so they stay in the output. */
export const layer = GrantVerifier.layer.pipe(
  Layer.provideMerge(ApproverKeys.layer),
  Layer.provideMerge(PendingActions.layer),
  // In Kin's services too: the server installs T3's credential reader into this one slot.
  Layer.provideMerge(T3GitHubCredential.slotLayer),
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
