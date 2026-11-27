import { useAtomValue } from "@effect/atom-react";
import { KIN_OFFLINE_PAGE, kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_BANK_SENDERS,
  KIN_BANK_SENDER_EMPTY_DRAFT,
  kinBankSenderAddInput,
  kinBankSenderAddNotice,
  kinBankSenderKnownBanks,
  kinBankSenderPermissions,
  kinBankSenderRows,
  type KinBankSenderDraft,
  type KinBankSenderFieldId,
  type KinBankSenderRowView,
} from "@t3tools/client-runtime/kin/kinBankSenders";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import { kinNow } from "@t3tools/client-runtime/kin/kinNow";
import { kinFormTyped } from "@t3tools/client-runtime/kin/kinWorkForms";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useEffectEvent, useState } from "react";

import { useSearchableSetting } from "../../components/settings/settingsSearch";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinConfirm } from "../KinConfirm";
import { kinClient } from "../kinClient";
import { useKinProfiles } from "../kinPictures";
import { KinGateFailed } from "../KinWorkParts";
import { kinHostConnected, useKinGate } from "../useKinHost";
import { useKinBankSenders, useKinCompanyProfile } from "../useKinMoney";
import type { KinWorkTarget } from "../useKinWork";
import { KinSettingsField, KinSettingsFormDialog } from "./KinSettingsControls";
import {
  KinSettingsEmpty,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsRow,
  KinSettingsSection,
} from "./KinSettingsLayout";

/** Settings → Company details → Bank alert addresses, for owner and co-owners only. */
export function KinBankSendersSection(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const searchableSetting = useSearchableSetting();
  const searchId = searchableSetting("kin-bank-senders").id;

  const listPermission = useAtomValue(kinClient.bankSendersList.permissionStateAtom(environmentId));
  const canAddGrant = useAtomValue(kinClient.bankSendersAdd.permissionAtom(environmentId));
  const canRemoveGrant = useAtomValue(kinClient.bankSendersRemove.permissionAtom(environmentId));
  const permissions = kinBankSenderPermissions({
    list: listPermission,
    canAdd: canAddGrant,
    canRemove: canRemoveGrant,
  });
  const gate = useKinGate(
    kinClient.bankSendersList.permissionStateAtom(environmentId),
    environmentId,
  );

  const { state, refresh } = useKinBankSenders(props, gate === null);
  useRefreshWhenShown(refresh, gate === null, state._tag === "ready");
  const companyProfile = useKinCompanyProfile(props, gate === null);
  const profilesResult = useKinProfiles(environmentId, orgId);
  const removeCommand = useAtomCommand(kinClient.bankSendersRemove, { reportFailure: false });

  const [adding, setAdding] = useState<KinBankSenderDraft | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [now] = useState(() => kinNow().getTime());

  if (!permissions.visible || state._tag === "refused") return null;

  const profiles =
    profilesResult === null ? null : Option.getOrNull(AsyncResult.value(profilesResult));
  const ownerName =
    profiles?.profiles.find((person) => person.personId === profiles.ownerPersonId)?.displayName ??
    null;

  if (gate === "offline") {
    return (
      <KinSettingsSection
        title={KIN_BANK_SENDERS.title}
        description={KIN_BANK_SENDERS.description}
        searchId={searchId}
      >
        <KinSettingsEmpty>{KIN_OFFLINE_PAGE.detail}</KinSettingsEmpty>
      </KinSettingsSection>
    );
  }
  if (gate === "failed") {
    return (
      <KinSettingsSection
        title={KIN_BANK_SENDERS.title}
        description={KIN_BANK_SENDERS.description}
        searchId={searchId}
      >
        <KinGateFailed className="px-4 py-3" />
      </KinSettingsSection>
    );
  }
  if (gate === "loading" || state._tag === "loading") {
    return (
      <KinSettingsSection
        title={KIN_BANK_SENDERS.title}
        description={KIN_BANK_SENDERS.description}
        searchId={searchId}
      >
        <KinSettingsLoading rows={2} />
      </KinSettingsSection>
    );
  }
  if (state._tag !== "ready") {
    const text =
      state._tag === "failed"
        ? kinFailureText(state.cause, KIN_BANK_SENDERS.loadFailed)
        : KIN_BANK_SENDERS.loadFailed;
    return (
      <KinSettingsSection
        title={KIN_BANK_SENDERS.title}
        description={KIN_BANK_SENDERS.description}
        searchId={searchId}
      >
        <KinSettingsLoadFailed onRetry={refresh}>{text}</KinSettingsLoadFailed>
      </KinSettingsSection>
    );
  }

  const rows = kinBankSenderRows(state.value.rows, { ownerName, now });
  const knownBanks = kinBankSenderKnownBanks({
    companyBankName:
      companyProfile.state._tag === "ready" ? companyProfile.state.value.bank.bankName : null,
    rows: state.value.rows,
  });

  const openAdd = (initial?: Partial<KinBankSenderDraft>) => {
    setProblem(null);
    setAdding({ ...KIN_BANK_SENDER_EMPTY_DRAFT, ...initial });
  };

  const remove = async (address: string) => {
    setRemoving(address);
    setProblem(null);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => removeCommand({ environmentId, input: { orgId, address } }),
    });
    setRemoving(null);
    refresh();
    if (!outcome.ok) setProblem(outcome.problem || KIN_BANK_SENDERS.removeFailed);
  };

  return (
    <>
      <KinSettingsSection
        title={KIN_BANK_SENDERS.title}
        description={KIN_BANK_SENDERS.description}
        searchId={searchId}
        problem={problem}
        action={
          rows.length > 0 && permissions.canAdd ? (
            <Button size="xs" variant="outline" onClick={() => openAdd()}>
              {KIN_BANK_SENDERS.add}
            </Button>
          ) : undefined
        }
      >
        {rows.length === 0 ? (
          <KinSettingsEmpty
            action={
              permissions.canAdd ? (
                <Button size="xs" variant="outline" onClick={() => openAdd()}>
                  {KIN_BANK_SENDERS.add}
                </Button>
              ) : undefined
            }
          >
            {KIN_BANK_SENDERS.empty}
          </KinSettingsEmpty>
        ) : (
          rows.map((row) => (
            <BankSenderRow
              key={row.address}
              row={row}
              canAdd={permissions.canAdd}
              canRemove={permissions.canRemove}
              busy={removing !== null}
              onRemove={() => setConfirmRemove(row.address)}
              onAddAgain={() => openAdd({ address: row.address, bankName: row.bankName })}
            />
          ))
        )}
      </KinSettingsSection>
      <KinConfirm
        ask={
          confirmRemove === null
            ? null
            : {
                title: KIN_BANK_SENDERS.removeTitle(confirmRemove),
                detail: KIN_BANK_SENDERS.removeDetail,
                action: KIN_BANK_SENDERS.removeConfirm,
                destructive: true,
              }
        }
        onConfirm={() => {
          const target = confirmRemove;
          setConfirmRemove(null);
          if (target !== null) void remove(target);
        }}
        onClose={() => setConfirmRemove(null)}
      />
      {adding === null ? null : (
        <AddBankSenderDialog
          environmentId={environmentId}
          orgId={orgId}
          initial={adding}
          knownBanks={knownBanks}
          rows={state.value.rows}
          ownerName={ownerName}
          onAdded={refresh}
          onClose={() => setAdding(null)}
        />
      )}
    </>
  );
}

/** Nothing pushes a change to this list, so read it again whenever Settings comes back into view. */
function useRefreshWhenShown(refresh: () => void, enabled: boolean, cached: boolean) {
  const again = useEffectEvent(() => refresh());
  const cachedAtStart = useEffectEvent(() => cached);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the page's visibility and focus; a card answered elsewhere changes the list without a push
  useEffect(() => {
    if (!enabled) return;
    // A list cached from an earlier visit may be out of date; a first load is already fresh.
    if (cachedAtStart()) again();
    const shown = () => {
      if (document.visibilityState === "visible") again();
    };
    document.addEventListener("visibilitychange", shown);
    window.addEventListener("focus", shown);
    return () => {
      document.removeEventListener("visibilitychange", shown);
      window.removeEventListener("focus", shown);
    };
  }, [enabled]);
}

function BankSenderRow(props: {
  readonly row: KinBankSenderRowView;
  readonly canAdd: boolean;
  readonly canRemove: boolean;
  readonly busy: boolean;
  readonly onRemove: () => void;
  readonly onAddAgain: () => void;
}) {
  const { row } = props;
  const bankSummary =
    row.accountsLine === null ? row.bankName : `${row.bankName} · ${row.accountsLine}`;
  const stateVariant =
    row.state === "approved" ? "success" : row.state === "waiting" ? "warning" : "secondary";
  return (
    <KinSettingsRow
      stack
      title={
        row.addressDomain === "" ? (
          <span className="break-all">{row.address}</span>
        ) : (
          <span className="break-all">
            <span className="font-normal text-muted-foreground">{row.addressLocal}@</span>
            <span className="font-semibold text-foreground">{row.addressDomain}</span>
          </span>
        )
      }
      detail={
        <span className="flex flex-col gap-0.5">
          <span>{bankSummary}</span>
          {row.waitingLine === null ? null : <span>{row.waitingLine}</span>}
          {row.countsLine === null ? null : <span>{row.countsLine}</span>}
          {row.decidedLine === null ? null : <span>{row.decidedLine}</span>}
        </span>
      }
      status={<Badge variant={stateVariant}>{row.stateLabel}</Badge>}
      control={
        row.canRemove && props.canRemove ? (
          <Button size="xs" variant="outline" disabled={props.busy} onClick={props.onRemove}>
            {KIN_BANK_SENDERS.remove}
          </Button>
        ) : row.canAddAgain && props.canAdd ? (
          <Button size="xs" variant="outline" disabled={props.busy} onClick={props.onAddAgain}>
            {KIN_BANK_SENDERS.countAgain}
          </Button>
        ) : null
      }
    />
  );
}

function AddBankSenderDialog(
  props: KinWorkTarget & {
    readonly initial: KinBankSenderDraft;
    readonly knownBanks: ReadonlyArray<string>;
    readonly rows: Parameters<typeof kinBankSenderAddNotice>[1];
    readonly ownerName: string | null;
    readonly onAdded: () => void;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId, initial, knownBanks } = props;
  const addCommand = useAtomCommand(kinClient.bankSendersAdd, { reportFailure: false });
  const [draft, setDraft] = useState<KinBankSenderDraft>(initial);
  const [problems, setProblems] = useState<Readonly<Partial<Record<KinBankSenderFieldId, string>>>>(
    {},
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const notice = kinBankSenderAddNotice(draft.address, props.rows, props.ownerName);

  const edit = (field: KinBankSenderFieldId, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    if (problems[field] !== undefined) {
      setProblems((current) => {
        const next = { ...current };
        delete next[field];
        return next;
      });
    }
  };

  const submit = async () => {
    const checked = kinBankSenderAddInput(orgId, draft);
    setProblem(null);
    if (!checked.ok) return setProblems(checked.problems);
    setProblems({});
    setSaving(true);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => addCommand({ environmentId, input: checked.input }),
    });
    setSaving(false);
    props.onAdded();
    if (!outcome.ok) return setProblem(outcome.problem || KIN_BANK_SENDERS.addFailed);
    props.onClose();
  };

  return (
    <KinSettingsFormDialog
      title={KIN_BANK_SENDERS.addTitle}
      description={KIN_BANK_SENDERS.addDescription}
      submitLabel={KIN_BANK_SENDERS.addSubmit}
      busy={saving}
      problem={problem}
      typed={kinFormTyped(initial, draft)}
      onSubmit={() => void submit()}
      onClose={props.onClose}
    >
      <KinSettingsField
        name="address"
        label={KIN_BANK_SENDERS.addressLabel}
        help={
          problems.address === undefined ? (
            (notice ?? KIN_BANK_SENDERS.addressHelp)
          ) : (
            <span className="text-destructive-foreground">{problems.address}</span>
          )
        }
      >
        {(ids) => (
          <Input
            id={ids.control}
            // Kin checks the address itself; the browser's own email check would hide the other fields' errors.
            inputMode="email"
            value={draft.address}
            placeholder={KIN_BANK_SENDERS.addressPlaceholder}
            disabled={saving}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={problems.address !== undefined}
            onChange={(event) => edit("address", event.target.value)}
          />
        )}
      </KinSettingsField>
      <KinSettingsField
        name="bankName"
        label={KIN_BANK_SENDERS.bankNameLabel}
        help={
          problems.bankName === undefined ? (
            KIN_BANK_SENDERS.bankNameHelp
          ) : (
            <span className="text-destructive-foreground">{problems.bankName}</span>
          )
        }
      >
        {(ids) => (
          <>
            <Input
              id={ids.control}
              value={draft.bankName}
              placeholder={KIN_BANK_SENDERS.bankNamePlaceholder}
              disabled={saving}
              autoComplete="off"
              aria-invalid={problems.bankName !== undefined}
              onChange={(event) => edit("bankName", event.target.value)}
            />
            {knownBanks.length === 0 ? null : (
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                <span className="text-xs text-muted-foreground">
                  {KIN_BANK_SENDERS.bankNameKnown}
                </span>
                {knownBanks.map((bank) => {
                  const selected = draft.bankName.trim().toLowerCase() === bank.toLowerCase();
                  return (
                    <Button
                      key={bank}
                      type="button"
                      size="xs"
                      variant={selected ? "secondary" : "outline"}
                      disabled={saving}
                      onClick={() => edit("bankName", bank)}
                    >
                      {bank}
                    </Button>
                  );
                })}
              </div>
            )}
          </>
        )}
      </KinSettingsField>
      <KinSettingsField
        name="accounts"
        label={KIN_BANK_SENDERS.accountsLabel}
        help={
          problems.accounts === undefined ? (
            KIN_BANK_SENDERS.accountsHelp
          ) : (
            <span className="text-destructive-foreground">{problems.accounts}</span>
          )
        }
      >
        {(ids) => (
          <Input
            id={ids.control}
            value={draft.accounts}
            placeholder={KIN_BANK_SENDERS.accountsPlaceholder}
            disabled={saving}
            autoComplete="off"
            spellCheck={false}
            inputMode="numeric"
            aria-invalid={problems.accounts !== undefined}
            onChange={(event) => edit("accounts", event.target.value)}
          />
        )}
      </KinSettingsField>
    </KinSettingsFormDialog>
  );
}
