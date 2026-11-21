import { useAtomValue } from "@effect/atom-react";
import {
  KIN_APPROVALS_SETTINGS as COPY,
  KIN_APPROVER_PHONES_TITLE,
} from "@t3tools/client-runtime/kin/kinApprovalPresentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  formatKinWhen,
  type EnvironmentId,
  type KinApproverKey,
  type KinKeyThumbprint,
  type KinOrgId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { KinConfirm } from "../../kin/KinConfirm";
import { kinClient } from "../../kin/kinClient";
import {
  KinSettingsEmpty,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsPage,
  KinSettingsRow,
  KinSettingsSection,
} from "../../kin/settings/KinSettingsLayout";
import { useNowMinuteMs } from "../../kin/useKinClock";
import { useKinHost } from "../../kin/useKinHost";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "../../state/query";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { PLATFORM, approvalsProblem } from "./ApprovalsSettings.logic";
import { useSearchableSetting } from "./settingsSearch";

const when = (at: DateTime.Utc, now: number) => {
  const ms = DateTime.toEpochMillis(at);
  return now - ms < 12 * 60 * 60 * 1000
    ? `at ${formatKinWhen(ms, "time")}`
    : `on ${formatKinWhen(ms, "dateTime")}`;
};

type Target = { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId };

/** The phones that can approve for Kin; each opens to its Remove. */
export function ApprovalsSettings() {
  const host = useKinHost();
  const environmentId = host._tag === "host" ? host.environmentId : null;
  const orgs = useEnvironmentQuery(
    environmentId === null ? null : kinClient.orgs({ environmentId, input: {} }),
  );
  const orgId = orgs.data?.me[0]?.orgId ?? null;
  const searchableSetting = useSearchableSetting();
  const waiting =
    host._tag === "searching" || (environmentId !== null && orgs.isPending && !orgs.data);
  return (
    <KinSettingsPage purpose={COPY.purpose}>
      {waiting || environmentId === null || orgId === null ? (
        <KinSettingsSection
          title={KIN_APPROVER_PHONES_TITLE}
          searchId={searchableSetting("approval-phones").id}
        >
          {waiting ? (
            <KinSettingsLoading rows={1} />
          ) : (
            <KinSettingsEmpty>
              {environmentId === null ? COPY.noHost : (orgs.error ?? COPY.notPerson)}
            </KinSettingsEmpty>
          )}
        </KinSettingsSection>
      ) : (
        <Phones target={{ environmentId, orgId }} />
      )}
    </KinSettingsPage>
  );
}

function Phones(props: { readonly target: Target }) {
  const { environmentId, orgId } = props.target;
  const keys = useEnvironmentQuery(kinClient.approverKeys({ environmentId, input: { orgId } }));
  const now = useNowMinuteMs();
  const canRemove = useAtomValue(kinClient.approverKeyRevoke.permissionAtom(environmentId));
  const removal = useRemove(props.target, keys.refresh);
  const searchableSetting = useSearchableSetting();
  const [open, setOpen] = useState<KinApproverKey | null>(null);
  const phones = keys.data?.keys ?? [];
  const activity = keys.data?.activity ?? [];
  const failure = keys.data === null && keys.error !== null ? approvalsProblem(keys.failure) : null;

  return (
    <>
      <KinSettingsSection
        title={KIN_APPROVER_PHONES_TITLE}
        description={canRemove ? COPY.phonesDetail : COPY.cantRemove}
        searchId={searchableSetting("approval-phones").id}
        problem={removal.problem}
      >
        {failure !== null ? (
          failure.retry ? (
            <KinSettingsLoadFailed onRetry={keys.refresh}>{failure.text}</KinSettingsLoadFailed>
          ) : (
            <KinSettingsEmpty>{failure.text}</KinSettingsEmpty>
          )
        ) : keys.data === null ? (
          <KinSettingsLoading rows={1} />
        ) : phones.length === 0 ? (
          <KinSettingsEmpty>{COPY.empty}</KinSettingsEmpty>
        ) : (
          phones.map((phone) => (
            <KinSettingsRow
              key={phone.thumbprint}
              title={phone.deviceLabel}
              detail={phoneLine(phone, now)}
              {...(canRemove
                ? { openLabel: COPY.open(phone.deviceLabel), onOpen: () => setOpen(phone) }
                : {})}
            />
          ))
        )}
      </KinSettingsSection>
      {activity.length === 0 ? null : (
        <KinSettingsSection title={COPY.recent}>
          {activity.map((entry) => (
            <KinSettingsRow
              key={`${entry.change}:${DateTime.toEpochMillis(entry.at)}:${entry.deviceLabel}`}
              title={entry.deviceLabel}
              detail={`${PLATFORM[entry.platform]} · ${
                entry.change === "added"
                  ? COPY.setUp(when(entry.at, now))
                  : COPY.removed(when(entry.at, now))
              }`}
            />
          ))}
        </KinSettingsSection>
      )}
      {open === null ? null : (
        <PhoneDialog
          phone={open}
          now={now}
          last={phones.length === 1}
          busy={removal.busy !== null}
          // A refusal is said under the list, so the dialog closes either way.
          onRemove={async () => {
            await removal.remove(open.thumbprint);
            setOpen(null);
          }}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}

const phoneLine = (phone: KinApproverKey, now: number) =>
  [
    PLATFORM[phone.platform],
    COPY.added(when(phone.confirmedAt ?? phone.createdAt, now)),
    phone.lastUsedAt === undefined ? COPY.notUsed : COPY.lastUsed(when(phone.lastUsedAt, now)),
  ].join(" · ");

/** A phone's own dialog: what it is, and Remove, which asks first. */
function PhoneDialog(props: {
  readonly phone: KinApproverKey;
  readonly now: number;
  readonly last: boolean;
  readonly busy: boolean;
  readonly onRemove: () => Promise<void>;
  readonly onClose: () => void;
}) {
  const { phone } = props;
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <Dialog
        open
        onOpenChange={(next) => {
          if (!next && !props.busy) props.onClose();
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>{phone.deviceLabel}</DialogTitle>
            <DialogDescription>{phoneLine(phone, props.now)}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <div className="sm:me-auto">
              <Button
                variant="ghost-destructive"
                disabled={props.busy}
                aria-busy={props.busy}
                onClick={() => setConfirming(true)}
              >
                {props.busy ? COPY.removing : COPY.remove}
              </Button>
            </div>
            <Button variant="outline" disabled={props.busy} onClick={props.onClose}>
              {COPY.close}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <KinConfirm
        ask={
          confirming
            ? {
                title: COPY.removeTitle(phone.deviceLabel),
                detail: props.last ? COPY.removeLast : COPY.removeOther,
                action: COPY.remove,
                destructive: true,
              }
            : null
        }
        onConfirm={() => void props.onRemove()}
        onClose={() => setConfirming(false)}
      />
    </>
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
      setProblem(approvalsProblem(squashAtomCommandFailure(result)).text);
  };
  return { busy, problem, remove };
}
