import * as Option from "effect/Option";
import { Flag } from "effect/cli";

export const flags = {
  repairProofKey: Flag.String("repair-proof-key").pipe(
    Flag.withDescription(
      "Explicitly re-pair this revoked DPoP thumbprint using a key-bound token.",
    ),
    Flag.optional,
  ),
};

export const grant = (input: { readonly repairProofKey: Option.Option<string> }) =>
  Option.isSome(input.repairProofKey)
    ? { subject: "kin-owner-repair", proofKeyThumbprint: input.repairProofKey.value }
    : {};
