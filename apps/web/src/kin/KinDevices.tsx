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
import { kinShareLink } from "@t3tools/client-runtime/kin/kinTeam";
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
import { CheckIcon, CopyIcon, PlusIcon } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
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
import { useKinPublicUrl } from "./useKinOwnerLevel";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";
import { kinClient } from "./kinClient";
import {
  KinSettingsEmpty,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsRow,
  KinSettingsSection,
} from "./settings/KinSettingsLayout";
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
  const removal = useDeviceRemoval(props, true);
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
    <KinSettingsSection
      title={KIN_DEVICES_COPY.title}
      action={
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          aria-busy={busy}
          onClick={() => void makeLink()}
        >
          <PlusIcon />
          {KIN_DEVICES_COPY.link}
        </Button>
      }
      problem={(made === null ? problem : null) ?? removal.problem}
    >
      {removal.shown === null ? (
        removal.failed ? (
          <KinSettingsLoadFailed onRetry={() => void refreshDevices(props)}>
            {KIN_DEVICES_COPY.loadFailed}
          </KinSettingsLoadFailed>
        ) : (
          <KinSettingsLoading rows={2} />
        )
      ) : removal.shown.length === 0 ? (
        <KinSettingsEmpty>{KIN_DEVICES_COPY.empty}</KinSettingsEmpty>
      ) : (
        removal.shown.map((device) => (
          <KinSettingsRow
            key={device.sessionId}
            title={kinDeviceLabel(device)}
            detail={
              device.current === true
                ? `${KIN_DEVICES_COPY.thisDevice} · ${kinDeviceLine(device, removal.now)}`
                : kinDeviceLine(device, removal.now)
            }
            control={
              kinDeviceRemovable(device) ? (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`Remove ${kinDeviceLabel(device)}`}
                  onClick={() => removal.ask(device)}
                >
                  {KIN_DEVICES_COPY.remove}
                </Button>
              ) : null
            }
          />
        ))
      )}
      {removal.confirm}
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
    </KinSettingsSection>
  );
}

/** A teammate's devices on the owner's sheet, each with Remove. */
export function KinTeammateDevices(props: KinDevicesTarget) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">Devices</h3>
      <KinDeviceList {...props} />
    </section>
  );
}

/** Removing one of `mine`'s or a teammate's devices: asks first, then signs it out. */
function useDeviceRemoval(target: KinDevicesTarget, mine: boolean) {
  const { environmentId, orgId, personId } = target;
  const { devices, all, nowMs, failed, now } = useActiveDevices(target);
  const remove = useAtomCommand(kinClient.deviceRemove, { reportFailure: false });
  const [asked, setAsked] = useState<KinPersonDevice | null>(null);
  const [removing, setRemoving] = useState<ReadonlySet<string>>(new Set());
  const [problem, setProblem] = useState<string | null>(null);
  const copy = asked === null ? null : kinRemoveDeviceCopy(asked, mine, all, nowMs);

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
    await refreshDevices(target);
    setRemoving((held) => {
      const next = new Set(held);
      next.delete(device.sessionId);
      return next;
    });
  };

  return {
    shown: devices?.filter((device) => !removing.has(device.sessionId)) ?? null,
    failed,
    now,
    problem,
    ask: setAsked,
    confirm: (
      <KinConfirm
        ask={
          copy === null
            ? null
            : { title: copy.title, detail: copy.detail, action: "Remove", destructive: true }
        }
        onConfirm={() => {
          if (asked !== null) void removeDevice(asked);
        }}
        onClose={() => setAsked(null)}
      />
    ),
  };
}

function KinDeviceList(props: KinDevicesTarget) {
  const removal = useDeviceRemoval(props, false);
  if (removal.shown === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {removal.failed ? KIN_DEVICES_COPY.loadFailed : "Loading…"}
      </p>
    );
  }
  return (
    <>
      {removal.shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">Not signed in anywhere.</p>
      ) : (
        <ul className="flex flex-col">
          {removal.shown.map((device) => (
            <li
              key={device.sessionId}
              className="flex items-center gap-3 border-b border-border/60 py-2 last:border-b-0"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-sm text-foreground">{kinDeviceLabel(device)}</span>
                  {device.current === true ? <Badge variant="secondary">This device</Badge> : null}
                </span>
                <span className="text-xs text-muted-foreground">
                  {kinDeviceLine(device, removal.now)}
                </span>
              </span>
              {kinDeviceRemovable(device) ? (
                <Button
                  size="sm"
                  variant="ghost-destructive"
                  aria-label={`Remove ${kinDeviceLabel(device)}`}
                  onClick={() => removal.ask(device)}
                >
                  {KIN_DEVICES_COPY.remove}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {removal.problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {removal.problem}
        </p>
      )}
      {removal.confirm}
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
  const publicUrl = useKinPublicUrl(props.environmentId);
  const left = kinDeviceLinkLeft(made.expiresAt, useNowMinuteMs());
  const shared =
    connection === null
      ? null
      : kinShareLink({ publicUrl, httpBaseUrl: connection.httpBaseUrl }, made.secret);
  const link = shared?.link ?? null;
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
              {shared === null || shared.note === null ? null : (
                <Alert variant="warning">
                  <AlertDescription>{shared.note}</AlertDescription>
                </Alert>
              )}
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
