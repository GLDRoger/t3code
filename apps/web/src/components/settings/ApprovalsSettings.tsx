import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinApproverKey,
  KinApproverKeyActivity,
  KinKeyThumbprint,
  KinOrgId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
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
import { PLATFORM, approvalsProblem } from "./ApprovalsSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dayFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const when = (at: DateTime.Utc, now: number) => {
  const ms = DateTime.toEpochMillis(at);
  return now - ms < 12 * 60 * 60 * 1000
    ? `at ${timeFormat.format(ms)}`
    : `on ${dayFormat.format(ms)}`;
};

type Target = { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId };

/** The phones that can approve for Kin, and Remove for one that shouldn't. */
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
        Kin asks one of these phones before it merges a pull request or changes what an agent may
        do, and the phone approves with Face ID. You'll get a message in your chat whenever a phone
        is added or removed.
      </p>
      {host._tag === "searching" || (environmentId !== null && orgs.isPending && !orgs.data) ? (
        <Loading />
      ) : environmentId === null ? (
        <Notice text="No Kin host is connected. Connect to the computer that runs Kin to see the phones that approve." />
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
  const canRemove = useAtomValue(kinClient.approverKeyRevoke.permissionAtom(environmentId));
  const removal = useRemove(props.target, keys.refresh);

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

  const { keys: phones, activity } = keys.data;
  const refresh = (
    <Button
      size="xs"
      variant="ghost"
      disabled={keys.isPending}
      aria-busy={keys.isPending}
      onClick={keys.refresh}
    >
      Refresh
    </Button>
  );
  return (
    <>
      {removal.problem === null ? null : (
        <p role="alert" className="px-3 text-sm text-destructive-foreground sm:px-4">
          {removal.problem}
        </p>
      )}
      <SettingsSection title="Phones that can approve" headerAction={refresh}>
        {phones.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
            No phone can approve, so nothing that needs approval can happen yet. To set one up, open
            Approvals in the Kin app on your phone.
          </p>
        ) : (
          phones.map((phone) => (
            <PhoneRow
              key={phone.thumbprint}
              phone={phone}
              now={now}
              last={phones.length === 1}
              busy={removal.busy === phone.thumbprint}
              disabled={!canRemove || removal.busy !== null}
              onRemove={() => removal.remove(phone.thumbprint)}
            />
          ))
        )}
        {canRemove ? null : (
          <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
            This sign-in can't remove phones. Use Kin signed in as you.
          </p>
        )}
      </SettingsSection>
      {activity.length === 0 ? null : (
        <SettingsSection title="Recent changes">
          {activity.map((entry) => (
            <ActivityRow
              key={`${entry.change}:${DateTime.toEpochMillis(entry.at)}:${entry.deviceLabel}`}
              entry={entry}
              now={now}
            />
          ))}
        </SettingsSection>
      )}
    </>
  );
}

function ActivityRow(props: { readonly entry: KinApproverKeyActivity; readonly now: number }) {
  const { entry, now } = props;
  return (
    <p className="min-w-0 break-words px-3 py-2.5 text-sm text-muted-foreground sm:px-4">
      <span className="text-foreground">{entry.deviceLabel}</span>
      {` (${PLATFORM[entry.platform]}) ${entry.change === "added" ? "was set up" : "was removed"} ${when(entry.at, now)}.`}
    </p>
  );
}

function PhoneRow(props: {
  readonly phone: KinApproverKey;
  readonly now: number;
  readonly last: boolean;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onRemove: () => void;
}) {
  const { phone, now } = props;
  const [confirming, setConfirming] = useState(false);
  const added = phone.confirmedAt ?? phone.createdAt;
  const used =
    phone.lastUsedAt === undefined
      ? "Not used to approve yet."
      : `Last approved ${when(phone.lastUsedAt, now)}.`;
  return (
    <SettingsRow
      title={phone.deviceLabel}
      description={`${PLATFORM[phone.platform]}, added ${when(added, now)}. ${used}`}
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
                <AlertDialogTitle>Remove {phone.deviceLabel}?</AlertDialogTitle>
                <AlertDialogDescription>
                  {props.last
                    ? "It's the only phone that can approve. Once it's removed, nothing that needs approval can happen until you set up a phone again. Anything it approved that hasn't run yet is cancelled."
                    : "It stops approving for Kin, and anything it approved that hasn't run yet is cancelled. To use it again, set up approvals on it."}
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

/** One removal at a time; a refusal says why, and the list is read again either way. */
function useRemove(target: Target, refresh: () => void) {
  const revokeKey = useAtomCommand(kinClient.approverKeyRevoke, { reportFailure: false });
  const [busy, setBusy] = useState<KinKeyThumbprint | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const remove = async (thumbprint: KinKeyThumbprint) => {
    if (busy !== null) return;
    setBusy(thumbprint);
    setProblem(null);
    const result = await revokeKey({
      environmentId: target.environmentId,
      input: { orgId: target.orgId, thumbprint },
    });
    setBusy(null);
    refresh();
    if (AsyncResult.isFailure(result))
      setProblem(approvalsProblem(squashAtomCommandFailure(result)));
  };
  return { busy, problem, remove: (thumbprint: KinKeyThumbprint) => void remove(thumbprint) };
}
