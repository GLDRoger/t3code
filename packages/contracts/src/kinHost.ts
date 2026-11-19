import type { ManagedPolicyDocument } from "./managedPolicy.ts";

/**
 * T3's managed policy on a Kin host, installed as /etc/t3code/policy.json from
 * `ops/kin/host/policy.json`. Only fields T3's schema had at the fork's merge base with upstream:
 * T3 refuses to start on a policy it can't decode.
 */
export const KIN_HOST_POLICY = {
  schemaVersion: 1,
  organization: "Kin",
  settings: {
    linkedEnvironmentsEnabled: { value: false, locked: true },
    guestSharingEnabled: { value: false, locked: true },
  },
  limits: {
    telemetry: false,
    browserCookieImport: false,
    updates: { mode: "off" },
  },
} as const satisfies ManagedPolicyDocument;
