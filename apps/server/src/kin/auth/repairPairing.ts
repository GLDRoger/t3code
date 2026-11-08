import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Flag } from "effect/cli";
import type * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import { SessionHooks } from "./sessionHooks.ts";

export const flags = {
  repairProofKey: Flag.String("repair-proof-key").pipe(
    Flag.withSchema(
      Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/))),
    ),
    Flag.withDescription(
      "Explicitly re-pair this revoked DPoP SHA-256 thumbprint using a key-bound token.",
    ),
    Flag.optional,
  ),
};

export const grant = (input: { readonly repairProofKey: Option.Option<string> }) =>
  Option.isSome(input.repairProofKey) ? { proofKeyThumbprint: input.repairProofKey.value } : {};

export const record = Effect.fn("RepairPairing.record")(function* (
  input: { readonly repairProofKey: Option.Option<string> },
  link: EnvironmentAuth.IssuedPairingLink,
) {
  if (Option.isSome(input.repairProofKey)) {
    const hooks = yield* SessionHooks;
    yield* hooks.recordRepair(input.repairProofKey.value, link.id);
  }
});
