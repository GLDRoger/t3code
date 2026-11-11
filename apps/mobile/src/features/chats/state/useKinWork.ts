import { useAtomValue } from "@effect/atom-react";
import {
  kinWorkNames,
  kinWorkScreenState,
  type KinWorkScreenState,
} from "@t3tools/client-runtime/kin/kinWork";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type {
  EnvironmentId,
  KinOrgId,
  KinOwnerTimeZone,
  KinPeopleListResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { kinClient } from "./kinClient";
import { useKinHostAt } from "./useKinHost";

export interface KinWorkTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

// Read only by a session that may read Work; others ask the host nothing.
const noLiveAtom: Atom.Atom<AsyncResult.AsyncResult<KinWorkLive, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noPeopleAtom: Atom.Atom<AsyncResult.AsyncResult<KinPeopleListResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noZoneAtom: Atom.Atom<AsyncResult.AsyncResult<KinOwnerTimeZone, unknown>> = Atom.make(
  AsyncResult.initial(),
);

export const kinWorkLiveAtom = ({ environmentId, orgId }: KinWorkTarget) =>
  kinClient.workLive({ environmentId, input: { orgId } });

/** Work's counts and change number as one screen state, kept current by the host. */
export function useKinWork(target: KinWorkTarget): KinWorkScreenState {
  const allowed = useAtomValue(kinClient.workRead.permissionAtom(target.environmentId));
  const live = useAtomValue(allowed ? kinWorkLiveAtom(target) : noLiveAtom);
  const host = useKinHostAt(target.environmentId);
  return kinWorkScreenState({
    allowed,
    connected: host._tag === "host" && host.connected,
    live,
  });
}

/** Who Work can name and be given to. `enabled` is off for a viewer the host would refuse. */
export function useKinWorkDirectory({ environmentId, orgId }: KinWorkTarget, enabled: boolean) {
  const host = useKinHostAt(environmentId);
  const orgs = host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null;
  const result = useAtomValue(
    enabled ? kinClient.people({ environmentId, input: { orgId } }) : noPeopleAtom,
  );
  const people = Option.getOrNull(AsyncResult.value(result))?.people ?? null;
  const zone =
    Option.getOrNull(
      AsyncResult.value(
        useAtomValue(
          enabled ? kinClient.workZone({ environmentId, input: { orgId } }) : noZoneAtom,
        ),
      ),
    )?.timeZone ?? null;
  return { orgs, people, names: kinWorkNames({ orgs, orgId, people, zone }) };
}

export type KinWorkDirectory = ReturnType<typeof useKinWorkDirectory>;
