import { KIN_HOST_POLICY, type ManagedPolicySummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { ManagedPolicy } from "../policy/ManagedPolicy.ts";

// Every field `expected` holds, `actual` holds with the same value; extra fields are fine.
const covers = (expected: unknown, actual: unknown): boolean =>
  typeof expected !== "object" || expected === null
    ? expected === actual
    : typeof actual === "object" &&
      actual !== null &&
      Object.entries(expected).every(([key, value]) =>
        covers(value, new Map(Object.entries(actual)).get(key)),
      );

/** Each lock or limit of `KIN_HOST_POLICY` that T3's summary of the running policy lacks. */
const notInForce = (summary: ManagedPolicySummary | undefined) => [
  ...Object.keys(KIN_HOST_POLICY.settings)
    .filter((path) => !summary?.lockedSettings.includes(path))
    .map((path) => `settings.${path}`),
  ...Object.entries(KIN_HOST_POLICY.limits)
    .filter(
      ([key, value]) => !covers(value, new Map(Object.entries(summary?.limits ?? {})).get(key)),
    )
    .map(([key]) => `limits.${key}`),
];

/** Warns once at Kin's startup when the host runs without Kin's policy; never stops it. */
export const check = Effect.fn("KinHostPolicy.check")(function* () {
  const missing = notInForce((yield* ManagedPolicy).summary);
  if (missing.length === 0) return;
  yield* Effect.logWarning(
    `Kin's host policy is not in force: ${missing.join(", ")}. ops/kin/host/setup.sh installs it as /etc/t3code/policy.json.`,
  );
});
