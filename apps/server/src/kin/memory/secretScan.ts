import type { KinOrgId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export class KinSecretScanError extends Schema.TaggedError<KinSecretScanError>()(
  "KinSecretScanError",
  {
    reason: Schema.String,
  },
) {}
export interface SecretFinding {
  readonly path: string;
  readonly ruleId: string;
  readonly line: number;
}
export class KinSecretScan extends Context.Service<
  KinSecretScan,
  {
    readonly scan: (input: {
      orgId: KinOrgId;
      files: ReadonlyArray<{ path: string; content: Uint8Array }>;
    }) => Effect.Effect<ReadonlyArray<SecretFinding>, KinSecretScanError>;
  }
>()("t3/kin/memory/secretScan/KinSecretScan") {}

export const stubLayer = Layer.succeed(KinSecretScan, {
  scan: Effect.fn("KinSecretScan.stub")(() => Effect.succeed([])),
});
export const testLayer = (findings: ReadonlyArray<SecretFinding>) =>
  Layer.succeed(KinSecretScan, {
    scan: Effect.fn("KinSecretScan.fixture")(() => Effect.succeed(findings)),
  });
