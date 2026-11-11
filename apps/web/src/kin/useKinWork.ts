import { useAtomValue } from "@effect/atom-react";
import {
  kinWorkNames,
  kinWorkScreenState,
  type KinWorkScreenState,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  KIN_WORK_NO_CHANGES,
  createKinWorkChanges,
  createKinWorkItemWatch,
  type KinWorkChangesState,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type {
  EnvironmentId,
  KinOrgId,
  KinOwnerTimeZone,
  KinPeopleListResult,
  KinRecordKey,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { kinHostConnected, useKinHostAt } from "./useKinHost";

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

/** The owner's changes to tasks on one host, shared by the list and the task beside it. */
export function useKinWorkChanges({ environmentId, orgId }: KinWorkTarget) {
  const update = useAtomCommand(kinClient.workUpdate, { reportFailure: false });
  const assign = useAtomCommand(kinClient.workAssign, { reportFailure: false });
  const confirm = useAtomCommand(kinClient.workConfirm, { reportFailure: false });
  const decline = useAtomCommand(kinClient.workDecline, { reportFailure: false });
  const [state, setState] = useState<KinWorkChangesState>(KIN_WORK_NO_CHANGES);
  const [changes] = useState(() =>
    createKinWorkChanges({
      orgId,
      update: (input) => update({ environmentId, input }),
      assign: (input) => assign({ environmentId, input }),
      confirm: (input) => confirm({ environmentId, input }),
      decline: (input) => decline({ environmentId, input }),
      reread: (key) =>
        appAtomRegistry.refresh(kinClient.workItem({ environmentId, input: { orgId, key } })),
      online: () => kinHostConnected(environmentId),
      onChange: setState,
    }),
  );
  return { state, changes };
}

export type KinWorkChangesHandle = ReturnType<typeof useKinWorkChanges>;

/** Reads the open task again when Work says it changed, and not for anyone else's change. */
export function useKinWorkItemWatch(
  { environmentId, orgId }: KinWorkTarget,
  key: KinRecordKey,
  heldSeq: number | undefined | null,
) {
  const live = Option.getOrNull(
    AsyncResult.value(useAtomValue(kinWorkLiveAtom({ environmentId, orgId }))),
  );
  const [watch] = useState(() =>
    createKinWorkItemWatch({
      key,
      reread: () =>
        appAtomRegistry.refresh(kinClient.workItem({ environmentId, input: { orgId, key } })),
    }),
  );
  const named = live?.changed[key] ?? 0;
  const unnamed = live?.unnamed ?? 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the open task from the host again when the host announces a change to it
  useEffect(() => {
    watch.changed(
      { changed: { [key]: named }, unnamed },
      heldSeq === null ? null : heldSeq === undefined ? {} : { seq: heldSeq },
    );
  }, [watch, key, named, unnamed, heldSeq]);
}

/** Which environments this browser can open a thread in, as a task card decides it. */
export function useKinWorkPlace(environmentId: EnvironmentId) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  return {
    environmentId,
    isKnownEnvironment: (id: EnvironmentId) => !catalog.isReady || catalog.entries.has(id),
  };
}
