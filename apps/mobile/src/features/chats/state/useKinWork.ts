import { useAtomValue } from "@effect/atom-react";
import {
  createKinWorkChanges,
  kinWorkChangesStart,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import type { KinWorkAnswers } from "@t3tools/client-runtime/kin/kinWork";
import type { KinScreenTarget as KinWorkTarget } from "@t3tools/client-runtime/kin/kinScreenReads";
import { makeKinWorkHooks } from "@t3tools/client-runtime/kin/react/kinWorkHooks";
import type { KinRecordDetail, KinRecordKey } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { environmentCatalog } from "../../../connection/catalog";
import { appAtomRegistry } from "../../../state/atom-registry";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient, retryKinWorkLive } from "./kinClient";
import { kinHookApp } from "./kinHookApp";
import { kinHostConnected, useKinHostAt } from "./useKinHost";

export type { KinScreenTarget as KinWorkTarget } from "@t3tools/client-runtime/kin/kinScreenReads";
export {
  kinSchedule,
  type KinWorkChoices,
  type KinWorkDirectory,
} from "@t3tools/client-runtime/kin/react/kinWorkHooks";

export const {
  kinWorkLiveAtom,
  useKinWork,
  useKinReinvited,
  useKinWorkDirectory,
  useKinWorkItemWatch,
  useKinWorkPlace,
  useKinPagedList,
  useKinClientsList,
  useKinProjectsList,
  useKinWorkHistory,
  useKinClientPage,
  useKinProjectPage,
  kinWorkChoicesAtom,
  useKinWorkChoices,
  useKinPickerSearch,
  useKinWorkForm,
  useKinWorkZone,
} = makeKinWorkHooks(kinHookApp, {
  useKinHostAt,
  catalogValueAtom: environmentCatalog.catalogValueAtom,
});

/**
 * Reads Work's counts again inside the running stream, keeping what is on screen. A stream that
 * already ended with an error has nothing to retry in, so it starts over.
 */
export const refreshKinWorkLive = (target: KinWorkTarget) => {
  const live = kinWorkLiveAtom(target);
  if (AsyncResult.isFailure(appAtomRegistry.get(live))) appAtomRegistry.refresh(live);
  else retryKinWorkLive(target.environmentId, target.orgId);
};

// The host's answers to the owner's changes, per host and org, read by every screen of a task.
const kinWorkAnswersAtom = Atom.family((_key: string) =>
  Atom.make<Readonly<Record<string, KinRecordDetail>>>({}).pipe(Atom.keepAlive),
);
const answersAtomOf = ({ environmentId, orgId }: KinWorkTarget) =>
  kinWorkAnswersAtom(JSON.stringify([environmentId, orgId]));

export function kinWorkAnswersOf(target: KinWorkTarget): KinWorkAnswers {
  const atom = answersAtomOf(target);
  return {
    get: (key) => appAtomRegistry.get(atom)[key],
    put: (item) => {
      const held = appAtomRegistry.get(atom);
      if ((held[item.key]?.rev ?? -1) >= item.rev) return;
      appAtomRegistry.set(atom, { ...held, [item.key]: item });
    },
  };
}

/** The host's latest answer to a change to this task from any screen; null with none. */
export function useKinWorkAnswer(target: KinWorkTarget, key: KinRecordKey) {
  return useAtomValue(answersAtomOf(target))[key] ?? null;
}

/** The owner's changes to tasks on one host, for a list or a task on screen. */
export function useKinWorkChanges(
  { environmentId, orgId }: KinWorkTarget,
  /** A form that opens already typing over this task. */
  editing?: KinRecordDetail,
) {
  const update = useAtomCommand(kinClient.workUpdate, { reportFailure: false });
  const assign = useAtomCommand(kinClient.workAssign, { reportFailure: false });
  const confirm = useAtomCommand(kinClient.workConfirm, { reportFailure: false });
  const decline = useAtomCommand(kinClient.workDecline, { reportFailure: false });
  const [state, setState] = useState(() => kinWorkChangesStart(editing));
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
      answers: kinWorkAnswersOf({ environmentId, orgId }),
      ...(editing === undefined ? {} : { editing }),
      onChange: setState,
    }),
  );
  return { state, changes };
}
