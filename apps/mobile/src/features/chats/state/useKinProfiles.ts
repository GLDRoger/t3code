import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, KinOrgId, KinPersonProfile } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { kinClient } from "./kinClient";
import { useKinHost } from "./useKinHost";

const noProfilesAtom = Atom.make(null);

/** The org's profiles as last read, or null before the first answer. */
export function useKinProfiles(environmentId: EnvironmentId | null, orgId: KinOrgId | null) {
  const result = useAtomValue(
    environmentId === null || orgId === null
      ? noProfilesAtom
      : kinClient.profiles({ environmentId, input: { orgId } }),
  );
  return {
    held: result === null ? null : Option.getOrNull(AsyncResult.value(result)),
    failed: result !== null && AsyncResult.isFailure(result),
  };
}

/** The Kin host's org and its profiles: where every avatar finds a picture. */
export function useKinHostProfiles(): {
  readonly environmentId: EnvironmentId | null;
  readonly orgId: KinOrgId | null;
  readonly profiles: ReadonlyArray<KinPersonProfile>;
} {
  const host = useKinHost();
  const ready = host._tag === "host" && host.probe._tag === "ready" ? host : null;
  const environmentId = ready?.environmentId ?? null;
  const orgId =
    ready !== null && ready.probe._tag === "ready" ? (ready.probe.orgs.me[0]?.orgId ?? null) : null;
  const { held } = useKinProfiles(environmentId, orgId);
  return { environmentId, orgId, profiles: held?.profiles ?? [] };
}
