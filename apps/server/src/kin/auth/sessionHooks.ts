import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as SessionStore from "../../auth/SessionStore.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import type * as Ref from "effect/Ref";
import type { AuthSessionId } from "@t3tools/contracts";

export class SessionHooks extends Context.Reference<{
  readonly recordRepair: (
    thumbprint: string,
    linkId: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly wrap: (notifications: {
    readonly connectedSessionsRef: Ref.Ref<Map<AuthSessionId, number>>;
    readonly emitRemoved: (sessionId: AuthSessionId) => Effect.Effect<void>;
  }) => (store: SessionStore.SessionStore["Service"]) => SessionStore.SessionStore["Service"];
  readonly checkExchange: (
    thumbprint: string | undefined,
    grant: {
      readonly method: string;
      readonly proofKeyThumbprint?: string;
      readonly pairingLinkId?: string;
    },
  ) => Effect.Effect<boolean, PersistenceSqlError>;
  /** A session a pairing credential was exchanged for; only these can resolve to a Kin person. */
  readonly recordPairedSession: (
    sessionId: AuthSessionId,
    grant: { readonly method: string; readonly pairingLinkId?: string },
  ) => Effect.Effect<void, PersistenceSqlError>;
  /** Whether revoking a keyed client for this caller ends only that session, not the device. */
  readonly revokesSessionOnly: (
    callerSessionId: AuthSessionId | undefined,
  ) => Effect.Effect<boolean, PersistenceSqlError>;
}>("kin/auth/SessionHooks", {
  defaultValue: () => ({
    recordRepair: () =>
      Effect.fail(
        new PersistenceSqlError({
          operation: "ProofKeySessions.recordRepair",
          detail: "Kin is disabled",
        }),
      ),
    wrap: () => (store) => store,
    checkExchange: () => Effect.succeed(true),
    recordPairedSession: () => Effect.void,
    revokesSessionOnly: () => Effect.succeed(false),
  }),
}) {}

/**
 * Kin's session hooks for a host CLI's auth. Here, not in authHooks.ts, because T3's auth module
 * reads it while loading; ProofKeySessions imports T3's auth, so it loads when built.
 */
export const cliAuthHooks = Layer.unwrap(
  Effect.promise(() => import("./ProofKeySessions.ts")).pipe(
    Effect.map(({ layerCli }) => layerCli),
  ),
);
