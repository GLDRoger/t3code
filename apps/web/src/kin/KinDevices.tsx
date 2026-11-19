import { useAtomValue } from "@effect/atom-react";
import {
  KIN_DEVICES_COPY,
  kinActiveDevices,
  kinDeviceJustLinked,
  kinDeviceLabel,
  kinDeviceLine,
  kinDeviceLinkLeft,
  kinDeviceLinkProblem,
  kinDeviceRemovable,
  kinRemoveDeviceCopy,
  kinRemoveDeviceProblem,
} from "@t3tools/client-runtime/kin/kinDevices";
import {
  KIN_INVITE_LOCAL_ONLY_NOTE,
  kinInviteLink,
  kinInviteLinkLocalOnly,
} from "@t3tools/client-runtime/kin/kinTeam";
import { executeAtomQuery, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinOrgId,
  KinPeopleLinkDeviceResult,
  KinPersonDevice,
  KinPersonId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { QRCodeSvg } from "../components/ui/qr-code";
import { namedClipboardTarget, useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { usePreparedConnection } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";

interface KinDevicesTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
}

const devicesAtom = ({ environmentId, orgId, personId }: KinDevicesTarget) =>
  kinClient.devices({ environmentId, input: { orgId, personId } });

const refreshDevices = (target: KinDevicesTarget) =>
  executeAtomQuery(appAtomRegistry, devicesAtom(target), {
    refresh: true,
    reportFailure: false,
  });

/** The person's devices signed in now, or null while the first read is out. */
function useActiveDevices(target: KinDevicesTarget) {
  const result = useAtomValue(devicesAtom(target));
  const nowMs = useNowMinuteMs();
  const held = Option.getOrNull(AsyncResult.value(result));
  return {
    devices: held === null ? null : kinActiveDevices(held.devices, nowMs),
    all: held?.devices ?? [],
    nowMs,
    failed: held === null && AsyncResult.isFailure(result),
    now: new Date(nowMs),
  };
}

/** The signed-in person's own devices and the way to link one more. Not for the owner. */
export function KinMyDevices(props: KinDevicesTarget) {
  const { devices } = useActiveDevices(props);
  const link = useAtomCommand(kinClient.deviceLink, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The link on screen; dropped when the dialog closes.
  const [made, setMade] = useState<KinPeopleLinkDeviceResult | null>(null);
  // A device that joined with it: its join refreshes "people", which reads this list again.
  const joined =
    made === null || devices === null ? null : kinDeviceJustLinked(devices, made.linkId);
  const makeLink = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const result = await link({
      environmentId: props.environmentId,
      input: { orgId: props.orgId },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) setMade(result.value);
    else setProblem(kinDeviceLinkProblem(squashAtomCommandFailure(result)));
  };
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{KIN_DEVICES_COPY.title}</h3>
      <KinDeviceList {...props} mine />
      <Button
        size="sm"
        variant="outline"
        className="self-start"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void makeLink()}
      >
        {KIN_DEVICES_COPY.link}
      </Button>
      {problem === null || made !== null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
      {made === null ? null : (
        <KinLinkDeviceDialog
          made={made}
          joined={joined === null ? null : kinDeviceLabel(joined)}
          environmentId={props.environmentId}
          busy={busy}
          problem={problem}
          onRenew={() => void makeLink()}
          onClose={() => {
            setMade(null);
            void refreshDevices(props);
          }}
        />
      )}
    </section>
  );
}

/** A teammate's devices on the owner's sheet, each with Remove. */
export function KinTeammateDevices(props: KinDevicesTarget) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">Devices</h3>
      <KinDeviceList {...props} mine={false} />
    </section>
  );
}

function KinDeviceList(props: KinDevicesTarget & { readonly mine: boolean }) {
  const { environmentId, orgId, personId } = props;
  const { devices, all, nowMs, failed, now } = useActiveDevices(props);
  const remove = useAtomCommand(kinClient.deviceRemove, { reportFailure: false });
  const [asked, setAsked] = useState<KinPersonDevice | null>(null);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const copy = asked === null ? null : kinRemoveDeviceCopy(asked, props.mine, all, nowMs);

  const removeDevice = async (device: KinPersonDevice) => {
    setProblem(null);
    setRemoving((held) => new Set(held).add(device.sessionId));
    const result = await remove({
      environmentId,
      input: { orgId, personId, sessionId: device.sessionId },
    });
    // This browser's own session just ended: a full load shows the signed-out screen.
    if (AsyncResult.isSuccess(result) && device.current === true) {
      window.location.reload();
      return;
    }
    if (!AsyncResult.isSuccess(result))
      setProblem(kinRemoveDeviceProblem(squashAtomCommandFailure(result)));
    await refreshDevices(props);
    setRemoving((held) => {
      const next = new Set(held);
      next.delete(device.sessionId);
      return next;
    });
  };

  if (devices === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {failed ? "Couldn't load devices." : "Loading…"}
      </p>
    );
  }
  const shown = devices.filter((device) => !removing.has(device.sessionId));
  return (
    <>
      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {props.mine ? "No devices linked yet." : "Not signed in anywhere."}
        </p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((device) => (
            <li
              key={device.sessionId}
              className="flex items-center gap-3 border-b border-border/60 py-2 last:border-b-0"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm text-foreground">{kinDeviceLabel(device)}</span>
                  {device.current === true ? <Badge variant="secondary">This device</Badge> : null}
                </span>
                <span className="text-xs text-muted-foreground">{kinDeviceLine(device, now)}</span>
              </span>
              {kinDeviceRemovable(device) ? (
                <Button
                  size="sm"
                  variant="ghost-destructive"
                  aria-label={`Remove ${kinDeviceLabel(device)}`}
                  onClick={() => setAsked(device)}
                >
                  {KIN_DEVICES_COPY.remove}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
      <AlertDialog open={asked !== null} onOpenChange={(open) => !open && setAsked(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{copy?.title}</AlertDialogTitle>
            <AlertDialogDescription>{copy?.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const device = asked;
                setAsked(null);
                if (device !== null) void removeDevice(device);
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function CopyButton(props: {
  readonly text: string;
  readonly label: string;
  readonly what: string;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget(props.what),
  });
  return (
    <Button size="sm" variant="outline" onClick={() => copyToClipboard(props.text)}>
      {isCopied ? <CheckIcon /> : <CopyIcon />}
      {isCopied ? "Copied" : props.label}
    </Button>
  );
}

/** The link the host just made, shown once; dropped when the dialog closes. */
function KinLinkDeviceDialog(props: {
  readonly made: KinPeopleLinkDeviceResult;
  /** The label of a device that joined with it, once one has. */
  readonly joined: string | null;
  readonly environmentId: EnvironmentId;
  readonly busy: boolean;
  /** Why the last "Make a new link" failed. */
  readonly problem: string | null;
  readonly onRenew: () => void;
  readonly onClose: () => void;
}) {
  const { made } = props;
  const connection = Option.getOrNull(usePreparedConnection(props.environmentId));
  const left = kinDeviceLinkLeft(made.expiresAt, useNowMinuteMs());
  const link = connection === null ? null : kinInviteLink(connection.httpBaseUrl, made.secret);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{KIN_DEVICES_COPY.link}</DialogTitle>
          <DialogDescription>
            The device signs in as you. Anyone with this link can do the same until it's used, so
            only open it on your own device.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {props.joined !== null ? (
            <Alert variant="success">
              <AlertDescription>{props.joined} is linked and signed in as you.</AlertDescription>
            </Alert>
          ) : left.expired ? (
            <div className="flex flex-col gap-3">
              <Alert variant="warning">
                <AlertDescription>{KIN_DEVICES_COPY.expiredDetail}</AlertDescription>
              </Alert>
              {props.problem === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{props.problem}</AlertDescription>
                </Alert>
              )}
            </div>
          ) : link === null ? (
            <Alert variant="error">
              <AlertDescription>{KIN_DEVICES_COPY.dropped}</AlertDescription>
            </Alert>
          ) : (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-4">
                <div className="shrink-0 rounded-lg bg-white p-1.5">
                  <QRCodeSvg
                    value={link}
                    size={128}
                    level="M"
                    marginSize={2}
                    title="Link for your new device"
                  />
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <p className="text-sm text-foreground">{KIN_DEVICES_COPY.scan}</p>
                  <p className="text-xs text-muted-foreground">
                    {left.text} {KIN_DEVICES_COPY.replaces}
                  </p>
                  <div>
                    <CopyButton text={link} label="Copy link" what="device link" />
                  </div>
                </div>
              </div>
              {kinInviteLinkLocalOnly(link) ? (
                <Alert variant="warning">
                  <AlertDescription>{KIN_INVITE_LOCAL_ONLY_NOTE}</AlertDescription>
                </Alert>
              ) : null}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {left.expired && props.joined === null ? (
            <Button
              variant="outline"
              disabled={props.busy}
              aria-busy={props.busy}
              onClick={props.onRenew}
            >
              {KIN_DEVICES_COPY.renew}
            </Button>
          ) : null}
          <Button onClick={props.onClose}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
