import { useAtomValue } from "@effect/atom-react";
import {
  KIN_CREDIT_NOTES,
  KIN_CREDIT_NOTES_LIST,
  KIN_INVOICES,
  kinCreditNoteActions,
  kinCreditNoteDraftCheck,
  type KinCreditNoteView,
} from "@t3tools/client-runtime/kin/kinInvoices";
import { KIN_WORK_COPY } from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  KIN_DEFAULT_HOME_CURRENCY,
  type KinListDefinition,
  type KinMoney,
  type KinRecordDetail,
} from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { uuidv4 } from "../../lib/uuid";
import { KinWorkTextField } from "./components/KinWorkPieces";
import type { KinMakeStep } from "./kinMakeStep";
import { kinClient } from "./state/kinClient";
import type { useKinMoneyActions } from "./state/useKinMoney";
import type { KinWorkTarget } from "./state/useKinWork";

type MoneyActions = ReturnType<typeof useKinMoneyActions>;

/** A credit note's summary line and taps: Issue, Make PDF, and Void, each confirmed where needed. */
export function KinCreditNoteActions(
  props: KinWorkTarget & {
    readonly item: KinRecordDetail;
    readonly note: KinCreditNoteView;
    readonly def: KinListDefinition | null;
    readonly actions: MoneyActions;
    readonly busy: boolean;
    readonly onMakePdf: (step: KinMakeStep) => void;
  },
) {
  const { environmentId, item, note, actions } = props;
  const can = kinCreditNoteActions(note, {
    issue: useAtomValue(kinClient.workIssue.permissionAtom(environmentId)),
    render: useAtomValue(kinClient.docRender.permissionAtom(environmentId)),
  });
  const [reading, setReading] = useState(false);
  const busy = props.busy || actions.busy || reading;
  const askIssue = async () => {
    setReading(true);
    const next = await actions.nextNumber(item.key);
    setReading(false);
    const ask = note.issueAsk(next);
    Dialog.confirm({
      title: ask.title,
      message: ask.detail,
      confirmText: ask.action,
      onConfirm: () => void actions.issue(item.key),
    });
  };
  return (
    <View className="gap-2">
      {note.takesOff === null ? null : (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {note.takesOff}
        </Text>
      )}
      {can.issue ? (
        <Button
          tone="primary"
          fullWidth
          icon="checkmark.circle"
          label={KIN_CREDIT_NOTES.issue}
          loading={actions.busy || reading}
          disabled={busy}
          onPress={() => void askIssue()}
        />
      ) : null}
      {can.makePdf ? (
        <Button
          tone="secondary"
          fullWidth
          icon="doc.text"
          label={KIN_INVOICES.makePdf}
          disabled={busy}
          onPress={() =>
            props.onMakePdf({
              list: KIN_CREDIT_NOTES_LIST,
              currency: item.amount?.currency ?? props.def?.currency ?? KIN_DEFAULT_HOME_CURRENCY,
              party: item.party ?? null,
            })
          }
        />
      ) : null}
      {can.void ? (
        <Button
          tone="text"
          fullWidth
          label={KIN_CREDIT_NOTES.voidAction}
          disabled={busy}
          onPress={() =>
            Dialog.confirm({
              title: note.voidAsk.title,
              message: note.voidAsk.detail,
              confirmText: note.voidAsk.action,
              destructive: true,
              onConfirm: () => void actions.void(item.key),
            })
          }
        />
      ) : null}
    </View>
  );
}

/** Small inline form on an issued invoice to draft a credit note against its remaining balance. */
export function KinCreditNoteDraftForm(props: {
  readonly owed: KinMoney;
  readonly busy: boolean;
  readonly onSave: (input: {
    readonly amount: KinMoney;
    readonly reason: string;
    readonly originKey: string;
  }) => Promise<boolean>;
  readonly onCancel: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [originKey] = useState(uuidv4);
  const save = async () => {
    const checked = kinCreditNoteDraftCheck(amount, reason, props.owed);
    if (!checked.ok) return setProblem(checked.problem);
    setProblem(null);
    await props.onSave({ amount: checked.amount, reason: checked.reason, originKey });
  };
  return (
    <View className="gap-2">
      <ListSection title={KIN_CREDIT_NOTES.title}>
        <KinWorkTextField
          label={KIN_CREDIT_NOTES.amount}
          value={amount}
          autoFocus
          keyboard="numbers"
          disabled={props.busy}
          onChangeText={setAmount}
        />
        <KinWorkTextField
          label={KIN_CREDIT_NOTES.reason}
          value={reason}
          maxLength={300}
          disabled={props.busy}
          onChangeText={setReason}
        />
      </ListSection>
      {problem === null ? null : <Notice message={problem} tone="danger" />}
      <Button
        tone="primary"
        fullWidth
        label={KIN_CREDIT_NOTES.saveDraft}
        loading={props.busy}
        disabled={props.busy}
        onPress={() => void save()}
      />
      <Button
        tone="text"
        fullWidth
        label={KIN_WORK_COPY.cancel}
        disabled={props.busy}
        onPress={props.onCancel}
      />
    </View>
  );
}
