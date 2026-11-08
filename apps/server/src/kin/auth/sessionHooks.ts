import type { AuthSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SessionStore from "../../auth/SessionStore.ts";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { ProofKeySessions } from "./ProofKeySessions.ts";

export const sessionHooks = Effect.gen(function* () {
  const hooks = yield* ProofKeySessions;
  return {
    onIssue: Effect.fn("KinAuth.onProofKeySession")(function* (
      sessionId: AuthSessionId,
      thumbprint: string,
    ) {
      yield* hooks
        .onIssue(sessionId, thumbprint)
        .pipe(
          Effect.mapError(
            (cause) => new SessionStore.SessionCredentialIssueError({ sessionId, cause }),
          ),
        );
    }),
    checkExchange: Effect.fn("KinAuth.checkProofKeyExchange")(function* (
      thumbprint: string | undefined,
      grant: Parameters<typeof hooks.allowExchange>[1],
    ) {
      const allowed = yield* hooks
        .allowExchange(thumbprint, grant)
        .pipe(
          Effect.mapError(
            (cause) => new EnvironmentAuth.ServerAuthAuthenticatedAccessTokenIssueError({ cause }),
          ),
        );
      if (!allowed) return yield* new EnvironmentAuth.ServerAuthInvalidCredentialError({});
    }),
  };
});
