import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { KIN_OFFLINE_PAGE } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_BILL_SENDERS,
  kinBillSenderAddInput,
  kinBillSenderConfirm,
  kinBillSenderGroups,
  kinBillSenderPermissions,
  type KinBillSenderAction,
  type KinBillSenderRowView,
} from "@t3tools/client-runtime/kin/kinBillSenders";
import { KIN_COMPANY } from "@t3tools/client-runtime/kin/kinCompanyProfile";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import { kinNow } from "@t3tools/client-runtime/kin/kinNow";
import { Fragment, useState, type ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinLoadFailedRow } from "./components/KinLoadFailed";
import { KinSenderAddress } from "./components/KinSenderAddress";
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
import { useKinBillSenders } from "./state/useKinMoney";
import type { KinWorkTarget } from "./state/useKinWork";

export type KinBillSenderAddParams = {
  readonly environmentId: string;
  readonly orgId: string;
};

/** What the host said back on an add that reversed a decline, if anything. */
const messageOf = (value: unknown) =>
  typeof value === "object" && value !== null && "message" in value ? String(value.message) : null;

/** Settings → Company details → Billing senders on the phone, for the owner and co-owners only. */
export function KinBillSendersSection(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const navigation = useNavigation();
  const listPermission = useAtomValue(kinClient.billSendersList.permissionStateAtom(environmentId));
  const canApprove = useAtomValue(kinClient.billSendersApprove.permissionAtom(environmentId));
  const canDecline = useAtomValue(kinClient.billSendersDecline.permissionAtom(environmentId));
  const canRemove = useAtomValue(kinClient.billSendersRemove.permissionAtom(environmentId));
  const canAdd = useAtomValue(kinClient.billSendersAdd.permissionAtom(environmentId));
  const permissions = kinBillSenderPermissions({
    list: listPermission,
    grants: {
      approve: canApprove,
      decline: canDecline,
      remove: canRemove,
      addBack: canAdd,
      add: canAdd,
    },
  });
  const gate = useKinGate(
    kinClient.billSendersList.permissionStateAtom(environmentId),
    environmentId,
  );
  const { state, refresh } = useKinBillSenders(props, gate === null);
  const commands = {
    approve: useAtomCommand(kinClient.billSendersApprove, { reportFailure: false }),
    decline: useAtomCommand(kinClient.billSendersDecline, { reportFailure: false }),
    remove: useAtomCommand(kinClient.billSendersRemove, { reportFailure: false }),
    addBack: useAtomCommand(kinClient.billSendersAdd, { reportFailure: false }),
  };
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const [now] = useState(() => kinNow().getTime());

  if (!permissions.visible || state._tag === "refused") return null;

  const frame = (children: ReactNode) => (
    <ListSection title={KIN_BILL_SENDERS.title} footer={KIN_BILL_SENDERS.description}>
      {children}
    </ListSection>
  );

  if (gate === "offline") return frame(<ListRowLayout label={KIN_OFFLINE_PAGE.detail} />);
  if (gate === "failed")
    return frame(
      <KinLoadFailedRow
        title={KIN_BILL_SENDERS.loadFailed}
        cause={null}
        onRetry={() => retryKinAccess(environmentId)}
      />,
    );
  if (gate === "loading" || state._tag === "loading")
    return frame(<KinWorkLoading label={KIN_BILL_SENDERS.loading} />);
  if (state._tag !== "ready")
    return frame(
      <KinLoadFailedRow
        title={KIN_BILL_SENDERS.loadFailed}
        cause={state._tag === "failed" ? state.cause : null}
        onRetry={refresh}
      />,
    );

  const groups = kinBillSenderGroups(state.value.rows, { now });

  const act = async (action: KinBillSenderAction, address: string) => {
    setBusy(address);
    setProblem(null);
    setSaid(null);
    const command = commands[action];
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => command({ environmentId, input: { orgId, address } }),
    });
    setBusy(null);
    refresh();
    if (!outcome.ok) return setProblem(outcome.problem || KIN_BILL_SENDERS.failed[action]);
    setSaid(messageOf(outcome.value));
  };

  const ask = (action: KinBillSenderAction, address: string) => {
    const question = kinBillSenderConfirm(action, address);
    Dialog.confirm({
      title: question.title,
      message: question.detail,
      confirmText: question.action,
      destructive: question.destructive,
      onConfirm: () => {
        void act(action, address);
      },
    });
  };

  return frame(
    <>
      {problem === null ? null : (
        <Notice message={problem} tone="danger" onDismiss={() => setProblem(null)} />
      )}
      {said === null ? null : <Notice message={said} onDismiss={() => setSaid(null)} />}
      {groups.length === 0 ? (
        <View className="px-4 py-3">
          <Text textRole="footnote" className="text-foreground-muted">
            {KIN_BILL_SENDERS.empty}
          </Text>
        </View>
      ) : (
        groups.map((group) => (
          <Fragment key={group.state}>
            <View className="px-4 pt-3">
              <Text textRole="footnote" className="font-t3-medium text-foreground-muted">
                {group.title}
              </Text>
            </View>
            {group.rows.map((row) => (
              <BillSenderMobileRow
                key={row.address}
                row={row}
                can={permissions.can}
                busy={busy !== null}
                onAct={(action) => ask(action, row.address)}
              />
            ))}
          </Fragment>
        ))
      )}
      {permissions.can("add") ? (
        <ListActionRow
          icon="plus"
          label={KIN_BILL_SENDERS.add}
          disabled={busy !== null}
          onPress={() => navigation.navigate("KinBillSenderAdd", { environmentId, orgId })}
        />
      ) : null}
    </>,
  );
}

function BillSenderMobileRow(props: {
  readonly row: KinBillSenderRowView;
  readonly can: (action: KinBillSenderAction) => boolean;
  readonly busy: boolean;
  readonly onAct: (action: KinBillSenderAction) => void;
}) {
  const { row } = props;
  const lines = [row.seenLine, row.askedLine, row.decidedLine].filter((line) => line !== null);
  const actions = row.actions.filter(props.can);
  return (
    <View className="gap-1.5 px-4 py-3">
      <KinSenderAddress address={row.address} segments={row.addressSegments} />
      {lines.map((line) => (
        <Text key={line} textRole="footnote" className="text-foreground-muted">
          {line}
        </Text>
      ))}
      {actions.length === 0 ? null : (
        <View className="flex-row flex-wrap gap-2 pt-1">
          {actions.map((action) => (
            <Button
              key={action}
              tone={action === "approve" ? "primary" : "outline"}
              size="compact"
              label={KIN_BILL_SENDERS.action[action]}
              accessibilityLabel={`${KIN_BILL_SENDERS.action[action]}: ${row.address}`}
              disabled={props.busy}
              onPress={() => props.onAct(action)}
            />
          ))}
        </View>
      )}
    </View>
  );
}

/** Full sheet to add a billing sender on the phone. */
export function KinBillSenderAddScreen({ route }: StaticScreenProps<KinBillSenderAddParams>) {
  const navigation = useNavigation();
  const target = targetOf(route.params);
  if (target === null) {
    return (
      <KinWorkFrame title={KIN_BILL_SENDERS.addTitle} form onClose={() => navigation.goBack()}>
        {NO_LINK}
      </KinWorkFrame>
    );
  }
  return <AddPermitted {...target} />;
}

function AddPermitted(props: KinWorkTarget) {
  const navigation = useNavigation();
  const gate = useKinGate(
    kinClient.billSendersAdd.permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  if (gate !== null) {
    return (
      <KinWorkFrame title={KIN_BILL_SENDERS.addTitle} form onClose={() => navigation.goBack()}>
        <KinGateView
          gate={gate}
          refused={KIN_COMPANY.onlyOwner}
          label={KIN_BILL_SENDERS.addTitle}
        />
      </KinWorkFrame>
    );
  }
  return <AddForm {...props} />;
}

function AddForm(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const navigation = useNavigation();
  const addCommand = useAtomCommand(kinClient.billSendersAdd, { reportFailure: false });
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const dirty = draft.trim() !== "";
  const leave = useKinAskBeforeDiscard(dirty && !saving);

  const send = async (address: string) => {
    setSaving(true);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => addCommand({ environmentId, input: { orgId, address } }),
    });
    setSaving(false);
    appAtomRegistry.refresh(kinClient.billSenders({ environmentId, input: { orgId } }));
    if (!outcome.ok) return setProblem(outcome.problem || KIN_BILL_SENDERS.addFailed);
    const said = messageOf(outcome.value);
    leave();
    navigation.goBack();
    if (said !== null) Dialog.alert(KIN_BILL_SENDERS.addedTitle, said);
  };

  const submit = () => {
    if (saving) return;
    const checked = kinBillSenderAddInput(orgId, draft);
    if (!checked.ok) return setProblem(checked.problem);
    setProblem(null);
    const question = kinBillSenderConfirm("add", checked.input.address);
    Dialog.confirm({
      title: question.title,
      message: question.detail,
      confirmText: question.action,
      onConfirm: () => {
        void send(checked.input.address);
      },
    });
  };

  return (
    <KinWorkFrame
      title={KIN_BILL_SENDERS.addTitle}
      form
      guardBack={dirty && !saving}
      showTop={problem}
      onClose={() => navigation.goBack()}
      confirm={{
        label: KIN_BILL_SENDERS.addSubmit,
        onPress: submit,
        loading: saving,
        disabled: saving,
      }}
    >
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {KIN_BILL_SENDERS.addDescription}
      </Text>
      {problem === null ? null : (
        <Notice message={problem} tone="danger" onDismiss={() => setProblem(null)} />
      )}
      <ListSection>
        <KinWorkTextField
          label={KIN_BILL_SENDERS.addressLabel}
          value={draft}
          placeholder={KIN_BILL_SENDERS.addressPlaceholder}
          keyboard="email"
          disabled={saving}
          onChangeText={(value) => {
            setDraft(value);
            setProblem(null);
          }}
        />
      </ListSection>
    </KinWorkFrame>
  );
}
