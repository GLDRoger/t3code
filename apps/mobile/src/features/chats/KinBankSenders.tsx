import { useAtomValue } from "@effect/atom-react";
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { KIN_OFFLINE_PAGE } from "@t3tools/client-runtime/kin/kinAnswers";
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
import { KIN_COMPANY } from "@t3tools/client-runtime/kin/kinCompanyProfile";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import { kinNow } from "@t3tools/client-runtime/kin/kinNow";
import { kinFormTyped } from "@t3tools/client-runtime/kin/kinWorkForms";
import { useEffect, useEffectEvent, useState } from "react";
import { AppState, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinLoadFailedRow } from "./components/KinLoadFailed";
import {
  KinGateView,
  KinWorkFrame,
  KinWorkLoading,
  KinWorkTextField,
  useKinAskBeforeDiscard,
} from "./components/KinWorkPieces";
import { NO_LINK, targetOf } from "./KinWorkFormScreens";
import { kinClient, retryKinAccess } from "./state/kinClient";
import { kinHostConnected, useKinGate } from "./state/useKinHost";
import { useKinBankSenders, useKinCompanyProfile } from "./state/useKinMoney";
import { useKinProfiles } from "./state/useKinProfiles";
import type { KinWorkTarget } from "./state/useKinWork";

export type KinBankSenderAddParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly address?: string;
  readonly bankName?: string;
};

/** Settings → Company details → Bank alert addresses on the phone, for owner and co-owners only. */
export function KinBankSendersSection(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const navigation = useNavigation();
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
  const { held: profiles } = useKinProfiles(environmentId, orgId);
  const removeCommand = useAtomCommand(kinClient.bankSendersRemove, { reportFailure: false });
  const [removing, setRemoving] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [now] = useState(() => kinNow().getTime());

  if (!permissions.visible || state._tag === "refused") return null;

  const ownerName =
    profiles?.profiles.find((person) => person.personId === profiles.ownerPersonId)?.displayName ??
    null;

  if (gate === "offline") {
    return (
      <ListSection title={KIN_BANK_SENDERS.title} footer={KIN_BANK_SENDERS.description}>
        <ListRowLayout label={KIN_OFFLINE_PAGE.detail} />
      </ListSection>
    );
  }
  if (gate === "failed") {
    return (
      <ListSection title={KIN_BANK_SENDERS.title} footer={KIN_BANK_SENDERS.description}>
        <KinLoadFailedRow
          title={KIN_BANK_SENDERS.loadFailed}
          cause={null}
          onRetry={() => retryKinAccess(environmentId)}
        />
      </ListSection>
    );
  }
  if (gate === "loading" || state._tag === "loading") {
    return (
      <ListSection title={KIN_BANK_SENDERS.title} footer={KIN_BANK_SENDERS.description}>
        <KinWorkLoading label={KIN_BANK_SENDERS.loading} />
      </ListSection>
    );
  }
  if (state._tag !== "ready") {
    return (
      <ListSection title={KIN_BANK_SENDERS.title} footer={KIN_BANK_SENDERS.description}>
        <KinLoadFailedRow
          title={KIN_BANK_SENDERS.loadFailed}
          cause={state._tag === "failed" ? state.cause : null}
          onRetry={refresh}
        />
      </ListSection>
    );
  }

  const rows = kinBankSenderRows(state.value.rows, { ownerName, now });

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

  const askRemove = (address: string) =>
    Dialog.confirm({
      title: KIN_BANK_SENDERS.removeTitle(address),
      message: KIN_BANK_SENDERS.removeDetail,
      confirmText: KIN_BANK_SENDERS.removeConfirm,
      destructive: true,
      onConfirm: () => {
        void remove(address);
      },
    });

  const openAdd = (prefill?: { readonly address?: string; readonly bankName?: string }) => {
    navigation.navigate("KinBankSenderAdd", {
      environmentId,
      orgId,
      ...(prefill?.address === undefined ? {} : { address: prefill.address }),
      ...(prefill?.bankName === undefined ? {} : { bankName: prefill.bankName }),
    });
  };

  return (
    <ListSection title={KIN_BANK_SENDERS.title} footer={KIN_BANK_SENDERS.description}>
      {problem === null ? null : (
        <Notice message={problem} tone="danger" onDismiss={() => setProblem(null)} />
      )}
      {rows.length === 0 ? (
        <View className="px-4 py-3">
          <Text textRole="footnote" className="text-foreground-muted">
            {KIN_BANK_SENDERS.empty}
          </Text>
        </View>
      ) : (
        rows.map((row) => (
          <BankSenderMobileRow
            key={row.address}
            row={row}
            canAdd={permissions.canAdd}
            canRemove={permissions.canRemove}
            busy={removing !== null}
            onRemove={() => askRemove(row.address)}
            onAddAgain={() => openAdd({ address: row.address, bankName: row.bankName })}
          />
        ))
      )}
      {permissions.canAdd ? (
        <ListActionRow
          icon="plus"
          label={KIN_BANK_SENDERS.add}
          disabled={removing !== null}
          onPress={() => openAdd()}
        />
      ) : null}
    </ListSection>
  );
}

/** Nothing pushes a change to this list, so read it again whenever the screen or the app comes back. */
function useRefreshWhenShown(refresh: () => void, enabled: boolean, cached: boolean) {
  const again = useEffectEvent(() => refresh());
  const cachedAtStart = useEffectEvent(() => cached);
  const focused = useIsFocused();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the list again when this screen regains focus, e.g. after a card was answered in chat
  useEffect(() => {
    // A list cached from an earlier visit may be out of date; a first load is already fresh.
    if (enabled && focused && cachedAtStart()) again();
  }, [enabled, focused]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to AppState; a card answered on another device changes the list without a push
  useEffect(() => {
    if (!enabled) return;
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") again();
    });
    return () => subscription.remove();
  }, [enabled]);
}

function BankSenderMobileRow(props: {
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
  const stateTone =
    row.state === "approved" ? "success" : row.state === "waiting" ? "warning" : "secondary";
  return (
    <View className="gap-1.5 px-4 py-3">
      {/* One text per piece in a wrapping row: the line breaks only after an @ or a dot, where a
          single text would also break at a hyphen inside the domain. */}
      <View accessible accessibilityLabel={row.address} className="flex-row flex-wrap">
        {row.addressSegments.map((segment) => (
          <Text
            key={segment.start}
            textRole="body"
            className={
              segment.domain
                ? "max-w-full font-t3-semibold text-foreground"
                : "max-w-full text-foreground-muted"
            }
          >
            {segment.text}
          </Text>
        ))}
      </View>
      <View className="flex-row flex-wrap items-center gap-2">
        <Chip size="small" tone={stateTone} label={row.stateLabel} />
      </View>
      <Text textRole="footnote" className="text-foreground-muted">
        {bankSummary}
      </Text>
      {row.waitingLine === null ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {row.waitingLine}
        </Text>
      )}
      {row.countsLine === null ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {row.countsLine}
        </Text>
      )}
      {row.decidedLine === null ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {row.decidedLine}
        </Text>
      )}
      {row.canRemove && props.canRemove ? (
        <View className="pt-1">
          <Button
            tone="outline"
            size="compact"
            label={KIN_BANK_SENDERS.remove}
            disabled={props.busy}
            onPress={props.onRemove}
          />
        </View>
      ) : row.canAddAgain && props.canAdd ? (
        <View className="pt-1">
          <Button
            tone="outline"
            size="compact"
            label={KIN_BANK_SENDERS.countAgain}
            disabled={props.busy}
            onPress={props.onAddAgain}
          />
        </View>
      ) : null}
    </View>
  );
}

/** Full sheet to add a bank alert address on the phone. */
export function KinBankSenderAddScreen({ route }: StaticScreenProps<KinBankSenderAddParams>) {
  const navigation = useNavigation();
  const target = targetOf(route.params);
  if (target === null) {
    return (
      <KinWorkFrame title={KIN_BANK_SENDERS.addTitle} form onClose={() => navigation.goBack()}>
        {NO_LINK}
      </KinWorkFrame>
    );
  }
  return (
    <AddPermitted
      {...target}
      initialAddress={route.params.address ?? ""}
      initialBankName={route.params.bankName ?? ""}
    />
  );
}

function AddPermitted(
  props: KinWorkTarget & {
    readonly initialAddress: string;
    readonly initialBankName: string;
  },
) {
  const navigation = useNavigation();
  const gate = useKinGate(
    kinClient.bankSendersAdd.permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  if (gate !== null) {
    return (
      <KinWorkFrame title={KIN_BANK_SENDERS.addTitle} form onClose={() => navigation.goBack()}>
        <KinGateView
          gate={gate}
          refused={KIN_COMPANY.onlyOwner}
          label={KIN_BANK_SENDERS.addTitle}
        />
      </KinWorkFrame>
    );
  }
  return <AddForm {...props} />;
}

function AddForm(
  props: KinWorkTarget & {
    readonly initialAddress: string;
    readonly initialBankName: string;
  },
) {
  const { environmentId, orgId } = props;
  const navigation = useNavigation();
  const addCommand = useAtomCommand(kinClient.bankSendersAdd, { reportFailure: false });
  const companyProfile = useKinCompanyProfile(props, true);
  const senders = useKinBankSenders(props, true);
  const { held: profiles } = useKinProfiles(environmentId, orgId);

  const [initial] = useState<KinBankSenderDraft>(() => ({
    ...KIN_BANK_SENDER_EMPTY_DRAFT,
    address: props.initialAddress,
    bankName: props.initialBankName,
  }));
  const [draft, setDraft] = useState<KinBankSenderDraft>(initial);
  const [problems, setProblems] = useState<Readonly<Partial<Record<KinBankSenderFieldId, string>>>>(
    {},
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const dirty = kinFormTyped(initial, draft);
  const leave = useKinAskBeforeDiscard(dirty && !saving);

  const knownBanks = kinBankSenderKnownBanks({
    companyBankName:
      companyProfile.state._tag === "ready" ? companyProfile.state.value.bank.bankName : null,
    rows: senders.state._tag === "ready" ? senders.state.value.rows : [],
  });

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
    if (saving) return;
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
    appAtomRegistry.refresh(kinClient.bankSenders({ environmentId, input: { orgId } }));
    if (!outcome.ok) return setProblem(outcome.problem || KIN_BANK_SENDERS.addFailed);
    leave();
    navigation.goBack();
  };

  const ownerName =
    profiles?.profiles.find((person) => person.personId === profiles.ownerPersonId)?.displayName ??
    null;
  const notice = kinBankSenderAddNotice(
    draft.address,
    senders.state._tag === "ready" ? senders.state.value.rows : [],
    ownerName,
  );

  const firstFieldProblem = problems.address ?? problems.bankName ?? problems.accounts ?? null;

  return (
    <KinWorkFrame
      title={KIN_BANK_SENDERS.addTitle}
      form
      guardBack={dirty && !saving}
      showTop={problem ?? firstFieldProblem}
      onClose={() => navigation.goBack()}
      confirm={{
        label: KIN_BANK_SENDERS.addSubmit,
        onPress: () => void submit(),
        loading: saving,
        disabled: saving,
      }}
    >
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {KIN_BANK_SENDERS.addDescription}
      </Text>
      {problem === null ? null : (
        <Notice message={problem} tone="danger" onDismiss={() => setProblem(null)} />
      )}
      <ListSection>
        <KinWorkTextField
          label={KIN_BANK_SENDERS.addressLabel}
          value={draft.address}
          placeholder={KIN_BANK_SENDERS.addressPlaceholder}
          keyboard="email"
          disabled={saving}
          hint={problems.address ?? notice ?? KIN_BANK_SENDERS.addressHelp}
          onChangeText={(value) => edit("address", value)}
        />
        <KinWorkTextField
          label={KIN_BANK_SENDERS.bankNameLabel}
          value={draft.bankName}
          placeholder={KIN_BANK_SENDERS.bankNamePlaceholder}
          disabled={saving}
          hint={problems.bankName ?? KIN_BANK_SENDERS.bankNameHelp}
          onChangeText={(value) => edit("bankName", value)}
        />
        {knownBanks.length === 0 ? null : (
          <View className="gap-2 px-4 py-3">
            <Text textRole="footnote" className="text-foreground-muted">
              {KIN_BANK_SENDERS.bankNameKnown}
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {knownBanks.map((bank) => (
                <Chip
                  key={bank}
                  label={bank}
                  selected={draft.bankName.trim().toLowerCase() === bank.toLowerCase()}
                  disabled={saving}
                  onPress={() => edit("bankName", bank)}
                />
              ))}
            </View>
          </View>
        )}
        <KinWorkTextField
          label={KIN_BANK_SENDERS.accountsLabel}
          value={draft.accounts}
          placeholder={KIN_BANK_SENDERS.accountsPlaceholder}
          keyboard="numbers"
          disabled={saving}
          hint={problems.accounts ?? KIN_BANK_SENDERS.accountsHelp}
          onChangeText={(value) => edit("accounts", value)}
        />
      </ListSection>
    </KinWorkFrame>
  );
}
