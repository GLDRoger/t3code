import { useAtomValue } from "@effect/atom-react";
import { kinOpenCountsFollower } from "@t3tools/client-runtime/kin/kinTeam";
import { kinWorkListsMoved } from "@t3tools/client-runtime/kin/kinWorkStream";
import type { EnvironmentId, KinOrgId, KinPersonProfile } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../../../state/atom-registry";

import { kinClient } from "./kinClient";
import { useKinHost } from "./useKinHost";
import { useKinWork, type KinWorkTarget } from "./useKinWork";

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

const followOpenCounts = kinOpenCountsFollower();

/** On a screen showing open-task counts: they follow Work's task changes while it is open. */
export function useKinOpenCounts({ environmentId, orgId }: KinWorkTarget) {
  const work = useKinWork({ environmentId, orgId });
  const seq = work._tag === "ready" && !work.stale ? kinWorkListsMoved(work.live, ["work"]) : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the profiles again when the host's Work stream says a task moved
  useEffect(() => {
    if (followOpenCounts(`${environmentId}:${orgId}`, seq))
      appAtomRegistry.refresh(kinClient.profiles({ environmentId, input: { orgId } }));
  }, [seq, environmentId, orgId]);
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
