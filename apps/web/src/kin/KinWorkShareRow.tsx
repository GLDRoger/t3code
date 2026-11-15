import { useAtomValue } from "@effect/atom-react";
import { KIN_WORK_SHARE } from "@t3tools/client-runtime/kin/kinWork";
import type { KinRecordKey } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import type { KinWorkTarget } from "./useKinWork";

/** The owner's switch for whether teammates see a task or doc; a teammate never gets it. */
export function KinWorkShareRow(
  props: KinWorkTarget & {
    readonly itemKey: KinRecordKey;
    readonly shared: boolean;
    readonly disabled: boolean;
    readonly copy?: typeof KIN_WORK_SHARE;
    /** Reads the record again once the host answers; a task's sheet by default. */
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
  const shareId = useId();
  const copy = props.copy ?? KIN_WORK_SHARE;
  if (!canShare) return null;
  const shared = asked !== null && asked.from === props.shared ? asked.to : props.shared;
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={shareId}>{copy.label}</Label>
        <p className="text-xs text-muted-foreground">
          {failed ? copy.failed : shared ? copy.on : copy.off}
        </p>
      </div>
      <Switch
        id={shareId}
        size="sm"
        checked={shared}
        disabled={props.disabled || pending}
        onCheckedChange={(checked) => {
          setAsked({ to: checked, from: props.shared });
          setPending(true);
          setFailed(false);
          void share({
            environmentId,
            input: { orgId, keys: [itemKey], shared: checked },
          }).then((outcome) => {
            const refused = AsyncResult.isFailure(outcome);
            setFailed(refused);
            setPending(false);
            if (refused) setAsked(null);
            if (props.onSettled !== undefined) props.onSettled();
            else
              appAtomRegistry.refresh(
                kinClient.workItem({ environmentId, input: { orgId, key: itemKey } }),
              );
          });
        }}
      />
    </div>
  );
}
