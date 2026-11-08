import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
  }),
}) {}
