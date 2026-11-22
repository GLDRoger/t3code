import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";

/** The Kin a Settings page belongs to. */
export interface KinSettingsTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}
