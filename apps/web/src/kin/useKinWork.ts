import {
  createKinWorkChanges,
  kinWorkChangesStart,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import type { KinScreenTarget as KinWorkTarget } from "@t3tools/client-runtime/kin/kinScreenReads";
import { makeKinWorkHooks } from "@t3tools/client-runtime/kin/react/kinWorkHooks";
import { useState } from "react";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
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
} = makeKinWorkHooks(kinHookApp, {
  useKinHostAt,
  catalogValueAtom: environmentCatalog.catalogValueAtom,
});

/** The owner's changes to tasks on one host, shared by the list and the task beside it. */
export function useKinWorkChanges({ environmentId, orgId }: KinWorkTarget) {
  const update = useAtomCommand(kinClient.workUpdate, { reportFailure: false });
  const assign = useAtomCommand(kinClient.workAssign, { reportFailure: false });
  const confirm = useAtomCommand(kinClient.workConfirm, { reportFailure: false });
  const decline = useAtomCommand(kinClient.workDecline, { reportFailure: false });
  const [state, setState] = useState(() => kinWorkChangesStart());
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
