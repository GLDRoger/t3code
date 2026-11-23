import { useAtomValue } from "@effect/atom-react";
import {
  KIN_APPROVALS_SETTINGS as COPY,
  KIN_APPROVER_PHONES_TITLE,
} from "@t3tools/client-runtime/kin/kinApprovalPresentation";
import { KIN_SETTINGS_COPY } from "@t3tools/client-runtime/kin/kinSettingsSpread";
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
import { PLATFORM, approvalsProblem } from "./ApprovalsSettings.logic";
import { useSearchableSetting } from "./settingsSearch";

const when = (at: DateTime.Utc, now: number) => {
  const ms = DateTime.toEpochMillis(at);
  return now - ms < 12 * 60 * 60 * 1000
    ? `at ${formatKinWhen(ms, "time")}`
    : `on ${formatKinWhen(ms, "dateTime")}`;
};

type Target = { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId };

/** The phones that can approve for Kin, each with Remove. */
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
  const [asking, setAsking] = useState<KinApproverKey | null>(null);
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
              // A phone has nothing to open, so Remove is its one quiet control, and asks first.
              control={
                canRemove ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={removal.busy !== null}
                    aria-busy={removal.busy === phone.thumbprint}
                    aria-label={COPY.removeTitle(phone.deviceLabel)}
                    onClick={() => setAsking(phone)}
                  >
                    {removal.busy === phone.thumbprint ? COPY.removing : KIN_SETTINGS_COPY.remove}
                  </Button>
                ) : null
              }
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
      <KinConfirm
        ask={
          asking === null
            ? null
            : {
                title: COPY.removeTitle(asking.deviceLabel),
                detail: phones.length === 1 ? COPY.removeLast : COPY.removeOther,
                action: KIN_SETTINGS_COPY.remove,
                destructive: true,
              }
        }
        onConfirm={() => {
          if (asking !== null) void removal.remove(asking.thumbprint);
        }}
        onClose={() => setAsking(null)}
      />
    </>
  );
}

const phoneLine = (phone: KinApproverKey, now: number) =>
  [
    PLATFORM[phone.platform],
    COPY.added(when(phone.confirmedAt ?? phone.createdAt, now)),
    phone.lastUsedAt === undefined ? COPY.notUsed : COPY.lastUsed(when(phone.lastUsedAt, now)),
  ].join(" · ");

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
