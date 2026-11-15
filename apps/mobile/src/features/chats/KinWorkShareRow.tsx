import { useAtomValue } from "@effect/atom-react";
import { KIN_WORK_SHARE } from "@t3tools/client-runtime/kin/kinWork";
import type { KinRecordKey } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinClient } from "./state/kinClient";
import type { KinWorkTarget } from "./state/useKinWork";

/** The owner's switch for whether teammates see a task or doc; a teammate never gets it. */
export function KinWorkShareRow(
  props: KinWorkTarget & {
    readonly itemKey: KinRecordKey;
    readonly shared: boolean;
    readonly disabled: boolean;
    readonly copy?: typeof KIN_WORK_SHARE;
    /** Reads the record again once the host answers; the task by default. */
    readonly onSettled?: () => void;
  },
) {
  const { environmentId, orgId, itemKey } = props;
  const canShare = useAtomValue(kinClient.workShare.permissionAtom(environmentId));
  const share = useAtomCommand(kinClient.workShare, { reportFailure: false });
  // What was asked, held only until the host's read moves off the value it was asked from.
  const [asked, setAsked] = useState<{ readonly to: boolean; readonly from: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = props.copy ?? KIN_WORK_SHARE;
  if (!canShare) return null;
  const shared = asked !== null && asked.from === props.shared ? asked.to : props.shared;
  return (
    <ListToggleRow
      icon="person.2"
      label={copy.label}
      description={failed ? copy.failed : shared ? copy.on : copy.off}
      value={shared}
      disabled={props.disabled || pending}
      onValueChange={(on) => {
        setAsked({ to: on, from: props.shared });
        setPending(true);
        setFailed(false);
        void share({ environmentId, input: { orgId, keys: [itemKey], shared: on } }).then(
          (outcome) => {
            const refused = AsyncResult.isFailure(outcome);
            setFailed(refused);
            setPending(false);
            if (refused) setAsked(null);
            if (props.onSettled !== undefined) props.onSettled();
            else
              appAtomRegistry.refresh(
                kinClient.workItem({ environmentId, input: { orgId, key: itemKey } }),
              );
          },
        );
      }}
    />
  );
}
