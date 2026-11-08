import * as Effect from "effect/Effect";
import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { SessionHooks } from "./sessionHooks.ts";

export const authHooks = Effect.gen(function* () {
  const hooks = yield* SessionHooks;
  return {
    checkExchange: Effect.fn("KinAuth.checkExchange")(function* (
      ...args: Parameters<typeof hooks.checkExchange>
    ) {
      const allowed = yield* hooks
        .checkExchange(...args)
        .pipe(
          Effect.mapError(
            (cause) => new EnvironmentAuth.ServerAuthAuthenticatedAccessTokenIssueError({ cause }),
          ),
        );
      if (!allowed) return yield* new EnvironmentAuth.ServerAuthInvalidCredentialError({});
    }),
  };
});
