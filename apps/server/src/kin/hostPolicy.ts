import * as Effect from "effect/Effect";

import { ManagedPolicy } from "../policy/ManagedPolicy.ts";

export const check = Effect.fn("KinHostPolicy.check")(function* () {
  const policy = yield* ManagedPolicy;
  if (policy.hasInstalledPolicy) return;
  yield* Effect.logWarning(
    `Kin is using its built-in host policy because ${policy.path} is missing. ops/kin/host/setup.sh installs the host policy at /etc/t3code/policy.json.`,
  );
});
