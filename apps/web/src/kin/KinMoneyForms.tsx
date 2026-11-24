import {
  KIN_MONEY_FORMS,
  kinExpenseAmountAbout,
  kinExpenseChoices,
  kinExpenseDraft,
  kinExpenseInput,
  kinExpenseTyped,
  kinInvoiceAmountAbout,
  kinInvoiceBeforeTax,
  kinInvoiceBillsByName,
  kinInvoiceDraft,
  kinInvoiceInput,
  kinInvoiceTax,
  kinInvoiceTaxText,
  kinInvoiceTyped,
  type KinBillToDraft,
  type KinExpenseDraft,
  type KinInvoiceDraft,
} from "@t3tools/client-runtime/kin/kinMoneyForms";
import { KIN_BILL_TO, kinBillToOffered } from "@t3tools/client-runtime/kin/kinBillTo";
import {
  KIN_GST_STATE_NAMES,
  KIN_WORK_FORM_COPY,
  kinIndiaFields,
} from "@t3tools/client-runtime/kin/kinWorkForms";
import { KIN_AMOUNT_SLIP } from "@t3tools/client-runtime/kin/kinLists";
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
  useKinCompanyCountry,
  useKinCompanyProfile,
  useKinHomeCurrency,
  useKinLists,
  useKinWorkFiles,
} from "./useKinMoney";
import { useKinNewExpense, useKinNewInvoice } from "./useKinMoneyAnswers";
import { useKinWorkChoices, useKinWorkDirectory, type KinWorkTarget } from "./useKinWork";
import { useKinSectionNamed, useKinSectionOn } from "./useKinShell";

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

/** The one line a form asks under its amount when it reads like a slip. */
function Slip(props: { readonly line: string | null }) {
  return props.line === null ? null : (
    <p role="status" className="text-sm text-foreground">
      {props.line}
    </p>
  );
}

const NO_PLACE = "none";

/** Who an invoice bills when it isn't a client: a name, and its details folded under More details. */
function BillToFields(props: {
  readonly value: KinBillToDraft;
  readonly disabled: boolean;
  /** India's tax number and state, as the client form asks them. */
  readonly india: boolean;
  /** The way back to the client picker, beside the name. */
  readonly choice: React.ReactNode;
  readonly onChange: (patch: Partial<KinBillToDraft>) => void;
}) {
  const [more, setMore] = useState(false);
  const ids = { name: useId(), address: useId(), tax: useId(), place: useId(), email: useId() };
  const { value, disabled } = props;
  const party = KIN_WORK_FORM_COPY.party;
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={ids.name}>{KIN_BILL_TO.name}</Label>
        <Input
          id={ids.name}
          maxLength={200}
          autoComplete="off"
          disabled={disabled}
          placeholder={KIN_BILL_TO.namePlaceholder}
          value={value.name}
          onChange={(event) => props.onChange({ name: event.target.value })}
        />
      </div>
      {props.choice}
      <div>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-expanded={more}
          onClick={() => setMore(!more)}
        >
          <ChevronDownIcon className={more ? "rotate-180" : undefined} />
          {KIN_BILL_TO.more}
        </Button>
      </div>
      {more ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.address}>{KIN_BILL_TO.address}</Label>
            <Textarea
              id={ids.address}
              rows={3}
              maxLength={500}
              disabled={disabled}
              placeholder={party.addressPlaceholder}
              value={value.address}
              onChange={(event) => props.onChange({ address: event.target.value })}
            />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.tax}>{props.india ? party.gstin : KIN_BILL_TO.taxNumber}</Label>
              <Input
                id={ids.tax}
                maxLength={100}
                autoComplete="off"
                autoCapitalize={props.india ? "characters" : undefined}
                spellCheck={false}
                disabled={disabled}
                value={value.taxNumber}
                onChange={(event) => props.onChange({ taxNumber: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.place}>{props.india ? party.place : KIN_BILL_TO.place}</Label>
              {props.india ? (
                <Select
                  value={value.place || NO_PLACE}
                  disabled={disabled}
                  onValueChange={(next) =>
                    props.onChange({ place: next === NO_PLACE ? "" : String(next) })
                  }
                >
                  <SelectTrigger id={ids.place} className="w-full min-w-0">
                    <SelectValue>{value.place || party.placeNone}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    <SelectItem value={NO_PLACE}>{party.placeNone}</SelectItem>
                    {KIN_GST_STATE_NAMES.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              ) : (
                <Input
                  id={ids.place}
                  maxLength={100}
                  autoComplete="off"
                  disabled={disabled}
                  value={value.place}
                  onChange={(event) => props.onChange({ place: event.target.value })}
                />
              )}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={ids.email}>{KIN_BILL_TO.email}</Label>
            <Input
              id={ids.email}
              type="email"
              maxLength={100}
              autoComplete="off"
              disabled={disabled}
              value={value.email}
              onChange={(event) => props.onChange({ email: event.target.value })}
            />
          </div>
        </>
      ) : null}
    </>
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
  const { clients, projects, projectClients } = useKinWorkChoices(props, true);
  const clientsOn = useKinSectionOn(props.environmentId, "clients");
  const named = useKinSectionNamed(props.environmentId);
  const listsRead = useKinLists(props, { enabled: true }).state;
  const offered = listsRead._tag === "ready" && kinBillToOffered(listsRead.value);
  const india = kinIndiaFields(useKinCompanyCountry(props));
  const projectClient = draft.project === null ? null : (projectClients.get(draft.project) ?? null);
  const byName = kinInvoiceBillsByName(draft, { clientsOn, offered, projectClient });
  const projectBills =
    projectClient === null
      ? null
      : (clients.find((one) => one.key === projectClient)?.title ?? null);
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
      byName,
      india,
      projectClient,
    });
    if (!checked.ok) return setProblem(checked.problem);
    setProblem(null);
    const result = await saving.save(checked.input, about);
    if (result === null) return;
    if (result.problems.length > 0)
      return setMade({ key: result.invoice, problems: result.problems });
    props.onOpenKey(result.invoice);
    props.onClose();
  };
  const locked = saving.busy || made !== null;
  const about = kinInvoiceAmountAbout(draft.lines);
  const choice = !clientsOn ? null : projectClient !== null ? (
    projectBills === null ? null : (
      <p className="text-sm text-muted-foreground">{KIN_BILL_TO.projectBills(projectBills)}</p>
    )
  ) : offered ? (
    <div>
      <Button
        type="button"
        size="xs"
        variant="ghost"
        disabled={locked}
        onClick={() => set({ byName: !draft.byName })}
      >
        {draft.byName ? named(KIN_BILL_TO.pickClient) : KIN_BILL_TO.byName}
      </Button>
    </div>
  ) : null;
  const slip = saving.slip(about);
  return (
    <FormDialog
      title={KIN_MONEY_FORMS.invoice.title}
      detail={KIN_MONEY_FORMS.invoice.detail}
      typed={made === null && kinInvoiceTyped(draft, opened)}
      busy={saving.busy}
      discardTitle={KIN_MONEY_FORMS.discard.invoice}
      saveLabel={
        made !== null
          ? KIN_MONEY_FORMS.invoice.tryAgain
          : slip !== null
            ? KIN_AMOUNT_SLIP.save
            : KIN_MONEY_FORMS.invoice.save
      }
      onSave={() => void save()}
      onClose={props.onClose}
    >
      {byName ? (
        <BillToFields
          value={draft.billTo}
          disabled={locked}
          india={india}
          choice={choice}
          onChange={(patch) => set({ billTo: { ...draft.billTo, ...patch } })}
        />
      ) : (
        <>
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
          {choice}
        </>
      )}
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
      <Slip line={slip} />
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
          {!clientsOn ? null : (
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
          )}
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
  const directory = useKinWorkDirectory(props, true);
  const choices = kinExpenseChoices(
    lists.state._tag === "ready"
      ? kinListsOf(lists).find((one) => one.list === "expenses")
      : undefined,
    directory.names.people,
  );
  const files = useKinWorkFiles(props, "");
  const held = files.state._tag === "ready" ? files.state.files : [];
  const ids = {
    what: useId(),
    amount: useId(),
    amountHint: useId(),
    day: useId(),
    vendor: useId(),
    category: useId(),
    paidWith: useId(),
    fundedBy: useId(),
    receipt: useId(),
  };
  const slip = saving.slip(kinExpenseAmountAbout(draft));
  const set = (patch: Partial<KinExpenseDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setProblem(null);
  };
  const save = async () => {
    const checked = kinExpenseInput(props.orgId, draft, { currency, clientRequestId: requestId });
    if (!checked.ok) return setProblem(checked.problem);
    setProblem(null);
    const key = await saving.save(checked.input, kinExpenseAmountAbout(draft));
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
      saveLabel={slip === null ? KIN_MONEY_FORMS.expense.save : KIN_AMOUNT_SLIP.save}
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
          {/* No decimal keypad: the iPhone's has no minus, and a refund needs one. */}
          <Input
            id={ids.amount}
            autoComplete="off"
            placeholder={KIN_MONEY_FORMS.expense.amountPlaceholder}
            aria-describedby={ids.amountHint}
            value={draft.amount}
            onChange={(event) => set({ amount: event.target.value })}
          />
          <p id={ids.amountHint} className="text-xs text-muted-foreground">
            {KIN_MONEY_FORMS.expense.amountRefundHint}
          </p>
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
      <Slip line={slip} />
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
      {choices.fundedByNote === null ? null : (
        <p className="text-xs text-muted-foreground">{choices.fundedByNote}</p>
      )}
      {choices.fundedBy.length === 0 ? null : (
        <div className="flex flex-col gap-1.5">
          {pick(
            ids.fundedBy,
            KIN_MONEY_FORMS.expense.fundedBy,
            draft.fundedBy,
            KIN_MONEY_FORMS.expense.company,
            choices.fundedBy,
            (fundedBy) => set({ fundedBy }),
          )}
          {draft.fundedBy === "" ? null : (
            <span className="text-xs text-muted-foreground">
              {KIN_MONEY_FORMS.expense.fundedByHint}
            </span>
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
