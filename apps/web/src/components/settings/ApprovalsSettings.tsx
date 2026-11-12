import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinKeyThumbprint, KinOrgId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { kinClient } from "../../kin/kinClient";
import { useNowMinuteMs } from "../../kin/useKinClock";
import { useKinHost } from "../../kin/useKinHost";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import {
  approvalPhones,
  approvalsProblem,
  spacedMatchCode,
  type AllowedPhone,
  type ApprovalPhone,
  type WaitingPhone,
} from "./ApprovalsSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const when = (ms: number, now: number) =>
  now - ms < 12 * 60 * 60 * 1000 ? `at ${timeFormat.format(ms)}` : `on ${dayFormat.format(ms)}`;

type Target = { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId };

/** The phones that may approve for Kin: the owner allows, declines and removes them here. */
export function ApprovalsSettings() {
  const host = useKinHost();
  const environmentId = host._tag === "host" ? host.environmentId : null;
  const orgs = useEnvironmentQuery(
    environmentId === null ? null : kinClient.orgs({ environmentId, input: {} }),
  );
  const orgId = orgs.data?.me[0]?.orgId ?? null;
  return (
    <SettingsPageContainer>
      <p className="px-3 text-sm text-muted-foreground sm:px-4">
        Kin asks a phone you allow here before it merges a pull request or changes what an agent may
        do, and the phone approves with Face ID. Only you can allow a phone, and only from Kin on
        the web or desktop.
      </p>
      {host._tag === "searching" || (environmentId !== null && orgs.isPending && !orgs.data) ? (
        <Loading />
      ) : environmentId === null ? (
        <Notice text="No Kin host is connected. Connect to the computer that runs Kin to manage the phones that approve." />
      ) : orgId === null ? (
        <Notice text={orgs.error ?? "This sign-in isn't a person in Kin."} />
      ) : (
        <Phones target={{ environmentId, orgId }} />
      )}
    </SettingsPageContainer>
  );
}

function Loading() {
  return (
    <div className="flex items-center gap-2 px-3 py-6 text-sm text-muted-foreground sm:px-4">
      <Spinner className="size-4" />
      Loading phones…
    </div>
  );
}

function Notice(props: { readonly text: string; readonly action?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-3 px-3 text-sm text-muted-foreground sm:px-4">
      <p role="status">{props.text}</p>
      {props.action}
    </div>
  );
}

function Phones(props: { readonly target: Target }) {
  const { environmentId, orgId } = props.target;
  const keys = useEnvironmentQuery(kinClient.approverKeys({ environmentId, input: { orgId } }));
  const now = useNowMinuteMs();
  const canAllow = useAtomValue(kinClient.approverKeyAllow.permissionAtom(environmentId));
  const canRevoke = useAtomValue(kinClient.approverKeyRevoke.permissionAtom(environmentId));
  const actions = usePhoneActions(props.target, keys.refresh);

  if (keys.data === null)
    return keys.error === null ? (
      <Loading />
    ) : (
      <Notice
        text={approvalsProblem(keys.failure)}
        action={
          <Button size="sm" variant="outline" onClick={keys.refresh}>
            Try again
          </Button>
        }
      />
    );

  const { waiting, allowed, expired } = approvalPhones(keys.data, now);
  const checkAgain = (
    <Button
      size="xs"
      variant="ghost"
      disabled={keys.isPending}
      aria-busy={keys.isPending}
      onClick={keys.refresh}
    >
      Check again
    </Button>
  );
  const permissionNote =
    canAllow && canRevoke ? null : (
      <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
        This sign-in can't change who approves. Use Kin on your own computer, signed in as you.
      </p>
    );

  return (
    <>
      {actions.problem === null ? null : (
        <p role="alert" className="px-3 text-sm text-destructive-foreground sm:px-4">
          {actions.problem}
        </p>
      )}
      <SettingsSection title="Waiting to be allowed" headerAction={checkAgain}>
        {waiting.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
            No phone is waiting. On your phone, open Kin, then Approvals, and tap Set up approvals.
            It shows up here within a few seconds; tap Check again.
          </p>
        ) : (
          waiting.map((phone) => (
            <WaitingRow
              key={phone.thumbprint}
              phone={phone}
              now={now}
              busy={actions.busy === phone.thumbprint}
              disabled={!canAllow || !canRevoke || actions.busy !== null}
              onAllow={() => actions.allow(phone)}
              onDecline={() => actions.revoke(phone)}
            />
          ))
        )}
        {permissionNote}
      </SettingsSection>
      <SettingsSection title="Phones that approve">
        {allowed.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
            No phone can approve yet. Kin waits for you before anything that needs approval.
          </p>
        ) : (
          allowed.map((phone) => (
            <AllowedRow
              key={phone.thumbprint}
              phone={phone}
              now={now}
              busy={actions.busy === phone.thumbprint}
              disabled={!canRevoke || actions.busy !== null}
              onRemove={() => actions.revoke(phone)}
            />
          ))
        )}
      </SettingsSection>
      {expired.length === 0 ? null : (
        <SettingsSection title="Requests that ran out">
          {expired.map((phone) => (
            <SettingsRow
              key={phone.thumbprint}
              title={phone.name}
              description={`${phone.kind}, asked ${when(phone.askedAt, now)}. Nobody allowed it within 10 minutes; to try again, make a new key on the phone.`}
              control={
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canRevoke || actions.busy !== null}
                  aria-busy={actions.busy === phone.thumbprint}
                  onClick={() => actions.revoke(phone)}
                >
                  Clear
                </Button>
              }
            />
          ))}
        </SettingsSection>
      )}
    </>
  );
}

function WaitingRow(props: {
  readonly phone: WaitingPhone;
  readonly now: number;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onAllow: () => void;
  readonly onDecline: () => void;
}) {
  const { phone, now } = props;
  const minutes = Math.max(1, Math.ceil((phone.expiresAt - now) / 60_000));
  return (
    <SettingsRow
      title={phone.name}
      description={`${phone.kind}, asked ${when(phone.askedAt, now)}. Allow it only if your phone shows this number. The request ends in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`}
      control={
        <div className="flex items-center gap-3">
          <span
            className="font-mono text-lg tabular-nums tracking-wider text-foreground"
            aria-label={`Number ${phone.matchCode.split("").join(" ")}`}
          >
            {spacedMatchCode(phone.matchCode)}
          </span>
          <Button size="sm" variant="ghost" disabled={props.disabled} onClick={props.onDecline}>
            Decline
          </Button>
          <Button
            size="sm"
            disabled={props.disabled}
            aria-busy={props.busy}
            onClick={props.onAllow}
          >
            {props.busy ? "Allowing…" : "Allow"}
          </Button>
        </div>
      }
    />
  );
}

function AllowedRow(props: {
  readonly phone: AllowedPhone;
  readonly now: number;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onRemove: () => void;
}) {
  const { phone, now } = props;
  const [confirming, setConfirming] = useState(false);
  return (
    <SettingsRow
      title={phone.name}
      description={
        phone.allowedAt === null
          ? `${phone.kind}. It approves with Face ID.`
          : `${phone.kind}, allowed ${when(phone.allowedAt, now)}. It approves with Face ID.`
      }
      control={
        <>
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={props.disabled}
            aria-busy={props.busy}
            onClick={() => setConfirming(true)}
          >
            {props.busy ? "Removing…" : "Remove"}
          </Button>
          <AlertDialog open={confirming} onOpenChange={setConfirming}>
            <AlertDialogPopup>
              <AlertDialogHeader>
                <AlertDialogTitle>Remove {phone.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  It stops approving for Kin, and anything it approved that hasn't run yet is
                  cancelled. To use it again, set up approvals on it and allow it here.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
                <Button
                  variant="destructive"
                  onClick={() => {
                    setConfirming(false);
                    props.onRemove();
                  }}
                >
                  Remove phone
                </Button>
              </AlertDialogFooter>
            </AlertDialogPopup>
          </AlertDialog>
        </>
      }
    />
  );
}

/** One change at a time; a refusal says why, and the list is read again either way. */
function usePhoneActions(target: Target, refresh: () => void) {
  const allowKey = useAtomCommand(kinClient.approverKeyAllow, { reportFailure: false });
  const revokeKey = useAtomCommand(kinClient.approverKeyRevoke, { reportFailure: false });
  const [busy, setBusy] = useState<KinKeyThumbprint | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async (phone: ApprovalPhone, command: typeof allowKey) => {
    if (busy !== null) return;
    setBusy(phone.thumbprint);
    setProblem(null);
    const result = await command({
      environmentId: target.environmentId,
      input: { orgId: target.orgId, thumbprint: phone.thumbprint },
    });
    setBusy(null);
    refresh();
    if (AsyncResult.isFailure(result))
      setProblem(approvalsProblem(squashAtomCommandFailure(result)));
  };
  return {
    busy,
    problem,
    allow: (phone: ApprovalPhone) => void run(phone, allowKey),
    revoke: (phone: ApprovalPhone) => void run(phone, revokeKey),
  };
}
