import { useAtomValue } from "@effect/atom-react";
import {
  KIN_CREDIT_NOTES,
  KIN_INVOICES,
  kinCreditNoteActions,
  kinCreditNoteDraftCheck,
  type KinCreditNoteView,
} from "@t3tools/client-runtime/kin/kinInvoices";
import { KIN_WORK_COPY } from "@t3tools/client-runtime/kin/kinWorkChanges";
import type { KinMoney, KinRecordDetail } from "@t3tools/contracts";
import { BanIcon, FileTextIcon, StampIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Spinner } from "../components/ui/spinner";
import { randomUUID } from "../lib/utils";
import { KinConfirm } from "./KinConfirm";
import { kinClient } from "./kinClient";
import type { useKinMoneyActions } from "./useKinMoney";
import type { KinWorkTarget } from "./useKinWork";

type MoneyActions = ReturnType<typeof useKinMoneyActions>;

/** A credit note's summary line and taps: Issue, Make PDF, and Void, each confirmed where needed. */
export function KinCreditNoteActions(
  props: KinWorkTarget & {
    readonly item: KinRecordDetail;
    readonly note: KinCreditNoteView;
    readonly actions: MoneyActions;
    readonly busy: boolean;
    readonly onMakePdf: () => void;
  },
) {
  const { environmentId, item, note, actions } = props;
  const can = kinCreditNoteActions(note, {
    issue: useAtomValue(kinClient.workIssue.permissionAtom(environmentId)),
    render: useAtomValue(kinClient.docRender.permissionAtom(environmentId)),
  });
  const [asking, setAsking] = useState<"issue" | "void" | null>(null);
  const [next, setNext] = useState<string | null | "reading">(null);
  const busy = props.busy || actions.busy;
  const askIssue = async () => {
    setAsking("issue");
    setNext("reading");
    const number = await actions.nextNumber(item.key);
    setNext(number);
  };
  const ask =
    asking === "void"
      ? note.voidAsk
      : asking === "issue"
        ? note.issueAsk(next === "reading" ? null : next)
        : null;
  return (
    <div className="flex flex-col gap-2">
      {note.takesOff === null ? null : (
        <p className="text-sm text-muted-foreground">{note.takesOff}</p>
      )}
      {!can.issue && !can.makePdf && !can.void ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {can.issue ? (
            <Button size="sm" disabled={busy} onClick={() => void askIssue()}>
              <StampIcon />
              {KIN_CREDIT_NOTES.issue}
            </Button>
          ) : null}
          {can.makePdf ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                actions.dismiss();
                props.onMakePdf();
              }}
            >
              <FileTextIcon />
              {KIN_INVOICES.makePdf}
            </Button>
          ) : null}
          {can.void ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking("void")}>
              <BanIcon />
              {KIN_CREDIT_NOTES.voidAction}
            </Button>
          ) : null}
        </div>
      )}
      <KinConfirm
        ask={ask}
        notReady={asking === "issue" && next === "reading"}
        onConfirm={() => {
          if (asking === "issue") void actions.issue(item.key);
          if (asking === "void") void actions.void(item.key);
        }}
        onClose={() => setAsking(null)}
      >
        {asking === "issue" && next === "reading" ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            {KIN_INVOICES.readingNumber}
          </p>
        ) : null}
      </KinConfirm>
    </div>
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
  const [originKey] = useState(randomUUID);
  const ids = { amount: useId(), reason: useId() };
  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const checked = kinCreditNoteDraftCheck(amount, reason, props.owed);
        if (!checked.ok) return setProblem(checked.problem);
        setProblem(null);
        void props.onSave({ amount: checked.amount, reason: checked.reason, originKey });
      }}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.amount}>{KIN_CREDIT_NOTES.amount}</Label>
        <Input
          id={ids.amount}
          inputMode="decimal"
          autoComplete="off"
          autoFocus
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.reason}>{KIN_CREDIT_NOTES.reason}</Label>
        <Input
          id={ids.reason}
          maxLength={300}
          autoComplete="off"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {problem === null ? null : (
        <Alert variant="error">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={props.busy}
          onClick={props.onCancel}
        >
          {KIN_WORK_COPY.cancel}
        </Button>
        <Button type="submit" size="sm" disabled={props.busy} aria-busy={props.busy}>
          {KIN_CREDIT_NOTES.saveDraft}
        </Button>
      </div>
    </form>
  );
}
