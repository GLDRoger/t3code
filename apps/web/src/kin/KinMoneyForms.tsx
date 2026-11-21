import {
  KIN_MONEY_FORMS,
  kinExpenseChoices,
  kinExpenseDraft,
  kinExpenseInput,
  kinExpenseTyped,
  kinInvoiceBeforeTax,
  kinInvoiceDraft,
  kinInvoiceInput,
  kinInvoiceTax,
  kinInvoiceTaxText,
  kinInvoiceTyped,
  type KinExpenseDraft,
  type KinInvoiceDraft,
} from "@t3tools/client-runtime/kin/kinMoneyForms";
import type { KinWorkRef } from "@t3tools/client-runtime/kin/kinWork";
import { kinWorkDayOf } from "@t3tools/client-runtime/kin/kinWork";
import { KIN_WORK_COPY } from "@t3tools/client-runtime/kin/kinWorkChanges";
import { KIN_DEFAULT_HOME_CURRENCY, type KinRecordKey } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";
import { useId, useState } from "react";

import { Alert, AlertAction, AlertDescription } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
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
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Textarea } from "../components/ui/textarea";
import { randomUUID } from "../lib/utils";
import { KinLinesEditor } from "./KinMoneyAnswers";
import { KinPlaceCombobox } from "./KinPlaceCombobox";
import { useNowMinuteMs } from "./useKinClock";
import {
  kinListsOf,
  useKinCompanyProfile,
  useKinHomeCurrency,
  useKinLists,
  useKinWorkFiles,
} from "./useKinMoney";
import { useKinNewExpense, useKinNewInvoice } from "./useKinMoneyAnswers";
import { useKinWorkChoices, type KinWorkTarget } from "./useKinWork";

const NONE = "none";

/** A form's frame: it asks before closing over words typed, and never closes while it saves. */
function FormDialog(props: {
  readonly title: string;
  readonly detail?: string;
  readonly typed: boolean;
  readonly busy: boolean;
  readonly discardTitle: string;
  readonly saveLabel: string;
  readonly onSave: () => void;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}) {
  const [asking, setAsking] = useState(false);
  const close = () => {
    if (props.busy) return;
    if (props.typed) setAsking(true);
    else props.onClose();
  };
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogPopup className="max-w-2xl">
          <form
            className="contents"
            onSubmit={(event) => {
              event.preventDefault();
              props.onSave();
            }}
          >
            <DialogHeader>
              <DialogTitle>{props.title}</DialogTitle>
              {props.detail === undefined ? null : (
                <DialogDescription>{props.detail}</DialogDescription>
              )}
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-4">{props.children}</div>
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={props.busy} onClick={close}>
                {KIN_WORK_COPY.cancel}
              </Button>
              <Button type="submit" disabled={props.busy} aria-busy={props.busy}>
                {props.saveLabel}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{props.discardTitle}</AlertDialogTitle>
            <AlertDialogDescription>{KIN_MONEY_FORMS.discard.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {KIN_MONEY_FORMS.discard.keep}
            </AlertDialogClose>
            <Button variant="destructive" onClick={props.onClose}>
              {KIN_MONEY_FORMS.discard.discard}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function Problem(props: { readonly text: string | null }) {
  return props.text === null ? null : (
    <Alert variant="error">
      <AlertDescription>{props.text}</AlertDescription>
    </Alert>
  );
}

/**
 * A new invoice typed by hand: a Draft for its client, made with its lines, which opens on its
 * page, where Issue takes over.
 */
export function KinNewInvoiceDialog(
  props: KinWorkTarget & {
    /** The client it is opened from, already picked. */
    readonly party?: KinWorkRef | null;
    readonly onOpenKey: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  const [opened] = useState(() => kinInvoiceDraft(props.party?.key ?? null));
  const [draft, setDraft] = useState<KinInvoiceDraft>(opened);
  const [problem, setProblem] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [requestId] = useState(randomUUID);
  const [made, setMade] = useState<{
    readonly key: KinRecordKey;
    readonly problems: ReadonlyArray<string>;
  } | null>(null);
  const saving = useKinNewInvoice(props);
  const { clients, projects } = useKinWorkChoices(props, true);
  const profile = useKinCompanyProfile(props, true);
  const currency = useKinHomeCurrency(props) ?? KIN_DEFAULT_HOME_CURRENCY;
  const tax = profile.state._tag === "ready" ? kinInvoiceTax(profile.state.value) : null;
  const gst = tax?._tag === "gst";
  const taxText = tax === null ? null : kinInvoiceTaxText(tax);
  const ids = { what: useId(), rate: useId(), due: useId(), notes: useId() };
  const today = kinWorkDayOf(new Date(useNowMinuteMs()));
  const clientRef =
    clients.find((one) => one.key === draft.party) ??
    (props.party?.key === draft.party ? (props.party ?? null) : null);
  const set = (patch: Partial<KinInvoiceDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setProblem(null);
  };
  const save = async () => {
    const checked = kinInvoiceInput(props.orgId, draft, {
      currency,
      gst: gst && tax.registered,
      clientRequestId: requestId,
    });
    if (!checked.ok) return setProblem(checked.problem);
    setProblem(null);
    const result = await saving.save(checked.input);
    if (result === null) return;
    if (result.problems.length > 0)
      return setMade({ key: result.invoice, problems: result.problems });
    props.onOpenKey(result.invoice);
    props.onClose();
  };
  const locked = saving.busy || made !== null;
  return (
    <FormDialog
      title={KIN_MONEY_FORMS.invoice.title}
      detail={KIN_MONEY_FORMS.invoice.detail}
      typed={made === null && kinInvoiceTyped(draft, opened)}
      busy={saving.busy}
      discardTitle={KIN_MONEY_FORMS.discard.invoice}
      saveLabel={made === null ? KIN_MONEY_FORMS.invoice.save : KIN_MONEY_FORMS.invoice.tryAgain}
      onSave={() => void save()}
      onClose={props.onClose}
    >
      <KinPlaceCombobox
        target={props}
        noun="client"
        label={KIN_MONEY_FORMS.invoice.party}
        placeholder={KIN_MONEY_FORMS.invoice.pickClient}
        value={clientRef}
        choices={clients}
        onChange={(client) => {
          if (!locked) set({ party: client?.key ?? null });
        }}
      />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.what}>{KIN_MONEY_FORMS.invoice.what}</Label>
        <Input
          id={ids.what}
          maxLength={280}
          autoComplete="off"
          disabled={locked}
          placeholder={KIN_MONEY_FORMS.invoice.whatPlaceholder}
          value={draft.title}
          onChange={(event) => set({ title: event.target.value })}
        />
        <span className="text-xs text-muted-foreground">{KIN_MONEY_FORMS.invoice.whatHint}</span>
      </div>
      <KinLinesEditor
        lines={draft.lines}
        disabled={locked}
        codes={gst}
        detail={KIN_MONEY_FORMS.invoice.linesDetail}
        onChange={(lines) => set({ lines })}
      />
      {kinInvoiceBeforeTax(draft.lines, currency) === null ? null : (
        <p className="text-sm text-foreground tabular-nums">
          {kinInvoiceBeforeTax(draft.lines, currency)}
        </p>
      )}
      {gst && tax.registered ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.rate}>{KIN_MONEY_FORMS.invoice.gstRate}</Label>
          <Input
            id={ids.rate}
            className="w-28"
            inputMode="decimal"
            autoComplete="off"
            disabled={locked}
            value={draft.gstRate}
            onChange={(event) => set({ gstRate: event.target.value })}
          />
          <span className="text-xs text-muted-foreground">{KIN_MONEY_FORMS.invoice.gstHint}</span>
        </div>
      ) : taxText === null ? null : (
        <p className="text-sm text-muted-foreground">{taxText}</p>
      )}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.due}>{KIN_MONEY_FORMS.invoice.due}</Label>
        <Input
          id={ids.due}
          type="date"
          className="w-48"
          min={today}
          disabled={locked}
          value={draft.dueOn ?? ""}
          onChange={(event) =>
            set({ dueOn: event.target.value === "" ? null : event.target.value })
          }
        />
      </div>
      <div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={more}
          onClick={() => setMore(!more)}
        >
          <ChevronDownIcon className={more ? "rotate-180" : undefined} />
          {KIN_MONEY_FORMS.invoice.more}
        </Button>
      </div>
      {more ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.notes}>{KIN_MONEY_FORMS.invoice.notes}</Label>
            <Textarea
              id={ids.notes}
              maxLength={4_000}
              disabled={locked}
              value={draft.notes}
              onChange={(event) => set({ notes: event.target.value })}
            />
            <span className="text-xs text-muted-foreground">
              {KIN_MONEY_FORMS.invoice.notesHint}
            </span>
          </div>
          <KinPlaceCombobox
            target={props}
            noun="project"
            label={KIN_MONEY_FORMS.invoice.project}
            placeholder={KIN_MONEY_FORMS.invoice.noProject}
            value={projects.find((one) => one.key === draft.project) ?? null}
            choices={projects}
            onChange={(project) => {
              if (!locked) set({ project: project?.key ?? null });
            }}
          />
        </>
      ) : null}
      <Problem text={problem ?? saving.problem} />
      {made === null ? null : (
        <Alert variant="error" controlAlignment="first-line">
          <AlertDescription>
            {KIN_MONEY_FORMS.invoice.savedWithout(made.key, made.problems)}
          </AlertDescription>
          <AlertAction>
            <Button
              size="xs"
              variant="outline"
              onClick={() => {
                props.onOpenKey(made.key);
                props.onClose();
              }}
            >
              {KIN_MONEY_FORMS.invoice.openDraft(made.key)}
            </Button>
          </AlertAction>
        </Alert>
      )}
    </FormDialog>
  );
}

/** A new expense typed by hand; the first one starts the company's Expenses list. */
export function KinNewExpenseDialog(
  props: KinWorkTarget & {
    readonly onOpenKey: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  const today = kinWorkDayOf(new Date(useNowMinuteMs()));
  const [opened] = useState(() => kinExpenseDraft(today));
  const [draft, setDraft] = useState<KinExpenseDraft>(opened);
  const [problem, setProblem] = useState<string | null>(null);
  const [requestId] = useState(randomUUID);
  const saving = useKinNewExpense(props);
  const currency = useKinHomeCurrency(props) ?? KIN_DEFAULT_HOME_CURRENCY;
  const lists = useKinLists(props, { enabled: true });
  const choices = kinExpenseChoices(
    lists.state._tag === "ready"
      ? kinListsOf(lists).find((one) => one.list === "expenses")
      : undefined,
  );
  const files = useKinWorkFiles(props, "");
  const held = files.state._tag === "ready" ? files.state.files : [];
  const ids = {
    what: useId(),
    amount: useId(),
    day: useId(),
    vendor: useId(),
    category: useId(),
    paidWith: useId(),
    receipt: useId(),
  };
  const set = (patch: Partial<KinExpenseDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setProblem(null);
  };
  const save = async () => {
    const checked = kinExpenseInput(props.orgId, draft, { currency, clientRequestId: requestId });
    if (!checked.ok) return setProblem(checked.problem);
    setProblem(null);
    const key = await saving.save(checked.input);
    if (key === null) return;
    props.onOpenKey(key);
    props.onClose();
  };
  const pick = (
    id: string,
    label: string,
    value: string,
    none: string,
    options: ReadonlyArray<{ readonly value: string; readonly label: string }>,
    onPick: (value: string) => void,
  ) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select
        value={value === "" ? NONE : value}
        onValueChange={(picked) => onPick(picked === NONE || picked === null ? "" : picked)}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue>{options.find((one) => one.value === value)?.label ?? none}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          <SelectItem value={NONE}>{none}</SelectItem>
          {options.map((one) => (
            <SelectItem key={one.value} value={one.value}>
              {one.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
  return (
    <FormDialog
      title={KIN_MONEY_FORMS.expense.title}
      {...(choices.first ? { detail: KIN_MONEY_FORMS.expense.firstList } : {})}
      typed={kinExpenseTyped(draft, opened)}
      busy={saving.busy}
      discardTitle={KIN_MONEY_FORMS.discard.expense}
      saveLabel={KIN_MONEY_FORMS.expense.save}
      onSave={() => void save()}
      onClose={props.onClose}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.what}>{KIN_MONEY_FORMS.expense.what}</Label>
        <Input
          id={ids.what}
          maxLength={280}
          autoComplete="off"
          autoFocus
          placeholder={KIN_MONEY_FORMS.expense.whatPlaceholder}
          value={draft.title}
          onChange={(event) => set({ title: event.target.value })}
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.amount}>{KIN_MONEY_FORMS.expense.amount}</Label>
          <Input
            id={ids.amount}
            inputMode="decimal"
            autoComplete="off"
            placeholder={KIN_MONEY_FORMS.expense.amountPlaceholder}
            value={draft.amount}
            onChange={(event) => set({ amount: event.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={ids.day}>{KIN_MONEY_FORMS.expense.paidOn}</Label>
          <Input
            id={ids.day}
            type="date"
            value={draft.paidOn}
            onChange={(event) => set({ paidOn: event.target.value })}
          />
        </div>
      </div>
      {draft.paidOn > today ? (
        <p className="text-xs text-muted-foreground">{KIN_MONEY_FORMS.expense.paidOnHint}</p>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.vendor}>{KIN_MONEY_FORMS.expense.vendor}</Label>
        <Input
          id={ids.vendor}
          maxLength={200}
          autoComplete="off"
          value={draft.vendor}
          onChange={(event) => set({ vendor: event.target.value })}
        />
      </div>
      {choices.categories.length === 0 && choices.paidWith.length === 0 ? null : (
        <div className="grid grid-cols-2 gap-3">
          {choices.categories.length === 0
            ? null
            : pick(
                ids.category,
                KIN_MONEY_FORMS.expense.category,
                draft.category,
                KIN_MONEY_FORMS.expense.noCategory,
                choices.categories,
                (category) => set({ category }),
              )}
          {choices.paidWith.length === 0
            ? null
            : pick(
                ids.paidWith,
                KIN_MONEY_FORMS.expense.paidWith,
                draft.paidWith,
                KIN_MONEY_FORMS.expense.notSaid,
                choices.paidWith.map((value) => ({ value, label: value })),
                (paidWith) => set({ paidWith }),
              )}
        </div>
      )}
      {choices.receipt ? (
        <div className="flex flex-col gap-1.5">
          {pick(
            ids.receipt,
            KIN_MONEY_FORMS.expense.receipt,
            draft.receipt ?? "",
            KIN_MONEY_FORMS.expense.noReceipt,
            held.slice(0, 30).map((file) => ({ value: file.attachmentId, label: file.name })),
            (receipt) => set({ receipt: receipt === "" ? null : receipt }),
          )}
          <span className="text-xs text-muted-foreground">
            {KIN_MONEY_FORMS.expense.receiptHint}
          </span>
        </div>
      ) : null}
      <Problem text={problem ?? saving.problem} />
    </FormDialog>
  );
}
