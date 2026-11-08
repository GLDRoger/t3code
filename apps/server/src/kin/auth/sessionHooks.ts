import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as SessionStore from "../../auth/SessionStore.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import type * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";

export class SessionHooks extends Context.Reference<{
  readonly recordRepair: (
    thumbprint: string,
    linkId: string,
  ) => Effect.Effect<void, PersistenceSqlError>;
  readonly wrap: (
    store: SessionStore.SessionStore["Service"],
  ) => SessionStore.SessionStore["Service"];
  readonly checkExchange: (
    thumbprint: string | undefined,
    grant: {
      readonly method: string;
      readonly proofKeyThumbprint?: string;
      readonly pairingLinkId?: string;
    },
  ) => Effect.Effect<
    void,
    | EnvironmentAuth.ServerAuthInvalidCredentialError
    | EnvironmentAuth.ServerAuthAuthenticatedAccessTokenIssueError
  >;
}>("kin/auth/SessionHooks", {
  defaultValue: () => ({
    recordRepair: () =>
      Effect.fail(
        new PersistenceSqlError({
          operation: "ProofKeySessions.recordRepair",
          detail: "Kin is disabled",
        }),
      ),
    wrap: (store) => store,
    checkExchange: () => Effect.void,
  }),
}) {}
