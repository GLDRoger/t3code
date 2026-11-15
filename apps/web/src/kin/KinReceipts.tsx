import { useAtomValue } from "@effect/atom-react";
import {
  KIN_RECEIPT_MODES,
  KIN_RECEIPTS,
  kinReceiptModeLabel,
  kinAdvanceDraft,
  kinAdvanceInput,
  kinReceiptView,
  type KinAdvanceDraft,
  type KinReceiptView,
} from "@t3tools/client-runtime/kin/kinInvoices";
import { kinMoneyText } from "@t3tools/client-runtime/kin/kinLists";
import { kinWorkDayOf } from "@t3tools/client-runtime/kin/kinWork";
import { KIN_WORK_COPY } from "@t3tools/client-runtime/kin/kinWorkChanges";
import { KinListId, type KinRecord, type KinRecordKey } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { PlusIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
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
import { Skeleton } from "../components/ui/skeleton";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { KinMoneyActionNotice } from "./KinInvoice";
import { KinWorkSection } from "./KinWorkParts";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import { useKinMoneyActions, useKinReceipts } from "./useKinMoney";
import { kinWorkChoicesAtom, type KinWorkTarget } from "./useKinWork";

const SHOWN = 8;
const KIN_INVOICES_LIST = KinListId.make("invoices");
const NO_CLIENT = "none";

/** Money's receipts: what came in, from whom, and the advances still to set against an invoice. */
export function KinReceiptsSection(
  props: KinWorkTarget & {
    readonly seq: number | null;
    readonly onOpenDoc: (key: KinRecordKey) => void;
    readonly onOpenKey: (key: KinRecordKey) => void;
  },
) {
  const { environmentId } = props;
  const canRead = useAtomValue(kinClient.receiptsRead.permissionAtom(environmentId));
  const canMake = useAtomValue(kinClient.makeReceipt.permissionAtom(environmentId));
  const { state, refresh } = useKinReceipts(props, { enabled: canRead, seq: props.seq });
  const actions = useKinMoneyActions(props);
  const now = new Date(useNowMinuteMs());
  const [all, setAll] = useState(false);
  const [adding, setAdding] = useState(false);
  const [setting, setSetting] = useState<KinReceiptView | null>(null);
  if (!canRead || state._tag === "refused") return null;
  const receipts =
    state._tag === "ready" ? state.value.receipts.map((one) => kinReceiptView(one, now)) : [];
  const shown = all ? receipts : receipts.slice(0, SHOWN);
  return (
    <KinWorkSection
      title={KIN_RECEIPTS.title}
      action={
        canMake ? (
          <Button size="xs" variant="ghost" onClick={() => setAdding(true)}>
            <PlusIcon />
            {KIN_RECEIPTS.newReceipt}
          </Button>
        ) : null
      }
    >
      {state._tag === "loading" ? (
        <div className="flex flex-col gap-2 px-2" role="status" aria-label="Loading receipts">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-4 w-2/5" />
        </div>
      ) : state._tag !== "ready" ? (
        <div className="flex flex-col items-start gap-2 px-2">
          <Alert variant="error">
            <AlertDescription>{KIN_RECEIPTS.loadFailed}. Check your connection.</AlertDescription>
          </Alert>
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : receipts.length === 0 ? (
        <p className="px-2 text-sm text-muted-foreground">{KIN_RECEIPTS.empty}</p>
      ) : (
        <>
          <KinMoneyActionNotice actions={actions} />
          <ul className="flex flex-col divide-y divide-border/60">
            {shown.map((receipt) => (
              <li key={receipt.key} className="flex items-start gap-3 px-2 py-2 text-sm">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={
                        receipt.void
                          ? "text-muted-foreground line-through"
                          : "font-medium text-foreground tabular-nums"
                      }
                    >
                      {receipt.heading}
                    </span>
                    {receipt.advance ? (
                      <Badge size="sm" variant="info">
                        {KIN_RECEIPTS.advance}
                      </Badge>
                    ) : null}
                    {receipt.void ? (
                      <Badge size="sm" variant="secondary">
                        {KIN_RECEIPTS.void}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {[receipt.when, receipt.from, receipt.towards]
                      .filter((part) => part !== null)
                      .join(" · ")}
                  </span>
                  {receipt.applied === null ? null : receipt.invoice === null ? (
                    <span className="text-xs text-muted-foreground">{receipt.applied}</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => receipt.invoice !== null && props.onOpenKey(receipt.invoice)}
                      className="self-start rounded text-xs text-muted-foreground underline-offset-2 outline-none ring-ring hover:underline focus-visible:ring-2 focus-visible:ring-inset"
                    >
                      {receipt.applied}
                    </button>
                  )}
                  {(receipt.settable !== null && canMake) || receipt.document !== null ? (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {receipt.settable !== null && canMake ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={actions.busy}
                          onClick={() => setSetting(receipt)}
                        >
                          {KIN_RECEIPTS.setAgainst}
                        </Button>
                      ) : null}
                      {receipt.document === null ? null : (
                        <Button
                          size="xs"
                          variant="ghost"
                          aria-label={`Open PDF: ${receipt.heading}`}
                          onClick={() =>
                            receipt.document !== null && props.onOpenDoc(receipt.document)
                          }
                        >
                          Open PDF
                        </Button>
                      )}
                    </span>
                  ) : null}
                </span>
                <span className="shrink-0 text-foreground tabular-nums">
                  {receipt.amount ?? "–"}
                </span>
              </li>
            ))}
          </ul>
          {receipts.length > SHOWN && !all ? (
            <div className="px-2">
              <Button size="xs" variant="ghost" onClick={() => setAll(true)}>
                Show all {receipts.length}
              </Button>
            </div>
          ) : null}
        </>
      )}
      {adding ? (
        <KinAdvanceDialog {...props} actions={actions} onClose={() => setAdding(false)} />
      ) : null}
      {setting !== null ? (
        <KinSetAgainstDialog
          {...props}
          receipt={setting}
          actions={actions}
          onClose={() => setSetting(null)}
        />
      ) : null}
    </KinWorkSection>
  );
}

type Actions = ReturnType<typeof useKinMoneyActions>;

/** Money received before any invoice: its receipt, numbered, with its PDF. */
function KinAdvanceDialog(
  props: KinWorkTarget & { readonly actions: Actions; readonly onClose: () => void },
) {
  const { actions, orgId } = props;
  const today = kinWorkDayOf(new Date(useNowMinuteMs()));
  const [draft, setDraft] = useState<KinAdvanceDraft>(() => kinAdvanceDraft(today));
  const [problem, setProblem] = useState<string | null>(null);
  const [requestId] = useState(randomUUID);
  const clients =
    Option.getOrNull(AsyncResult.value(useAtomValue(kinWorkChoicesAtom(props))))?.clients ?? [];
  const ids = {
    party: useId(),
    amount: useId(),
    day: useId(),
    towards: useId(),
    mode: useId(),
    reference: useId(),
  };
  const payer = clients.find((one) => one.key === draft.party) ?? null;
  const save = async () => {
    const checked = kinAdvanceInput(orgId, draft, "INR", requestId);
    if (!checked.ok) return setProblem(checked.problem);
    setProblem(null);
    const { orgId: _orgId, clientRequestId, ...input } = checked.input;
    const made = await actions.makeReceipt(undefined, input, clientRequestId);
    if (made !== null) props.onClose();
  };
  const text = (key: "towards" | "reference", label: string, placeholder: string, max: number) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={ids[key]}>{label}</Label>
      <Input
        id={ids[key]}
        maxLength={max}
        autoComplete="off"
        placeholder={placeholder}
        value={draft[key]}
        onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
      />
    </div>
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !actions.busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{KIN_RECEIPTS.newReceipt}</DialogTitle>
            <DialogDescription>{KIN_RECEIPTS.newDetail}</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={ids.party}>{KIN_RECEIPTS.party}</Label>
                <Select
                  value={draft.party ?? NO_CLIENT}
                  onValueChange={(value) =>
                    setDraft({
                      ...draft,
                      party: clients.find((one) => one.key === value)?.key ?? null,
                    })
                  }
                >
                  <SelectTrigger id={ids.party} className="w-full">
                    <SelectValue>{payer?.name ?? KIN_RECEIPTS.noClient}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value={NO_CLIENT}>{KIN_RECEIPTS.noClient}</SelectItem>
                    {clients.map((one) => (
                      <SelectItem key={one.key} value={one.key}>
                        {one.name}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={ids.amount}>{KIN_RECEIPTS.amount}</Label>
                  <Input
                    id={ids.amount}
                    inputMode="decimal"
                    autoComplete="off"
                    autoFocus
                    placeholder={KIN_RECEIPTS.amountPlaceholder}
                    value={draft.amount}
                    onChange={(event) => setDraft({ ...draft, amount: event.target.value })}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={ids.day}>{KIN_RECEIPTS.day}</Label>
                  <Input
                    id={ids.day}
                    type="date"
                    max={today}
                    value={draft.receivedOn}
                    onChange={(event) => setDraft({ ...draft, receivedOn: event.target.value })}
                  />
                </div>
              </div>
              {text("towards", KIN_RECEIPTS.towards, KIN_RECEIPTS.towardsPlaceholder, 300)}
              <div className="grid grid-cols-2 gap-3">
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={ids.mode}>{KIN_RECEIPTS.mode}</Label>
                  <Select
                    value={draft.mode === "" ? NO_CLIENT : draft.mode}
                    onValueChange={(value) =>
                      setDraft({ ...draft, mode: value === NO_CLIENT ? "" : String(value) })
                    }
                  >
                    <SelectTrigger id={ids.mode} className="w-full">
                      <SelectValue>{kinReceiptModeLabel(draft.mode)}</SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value={NO_CLIENT}>{KIN_RECEIPTS.noMode}</SelectItem>
                      {KIN_RECEIPT_MODES.map((one) => (
                        <SelectItem key={one.value} value={one.value}>
                          {one.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
                {text("reference", KIN_RECEIPTS.reference, KIN_RECEIPTS.referencePlaceholder, 120)}
              </div>
              {problem === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{problem}</AlertDescription>
                </Alert>
              )}
              {actions.problem === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{actions.problem}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={actions.busy} onClick={props.onClose}>
              {KIN_WORK_COPY.cancel}
            </Button>
            <Button type="submit" disabled={actions.busy} aria-busy={actions.busy}>
              {KIN_RECEIPTS.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}

/** Puts an advance against one of the client's open invoices, as a payment on it. */
function KinSetAgainstDialog(
  props: KinWorkTarget & {
    readonly receipt: KinReceiptView;
    readonly actions: Actions;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId, receipt, actions } = props;
  const [attempt, setAttempt] = useState(0);
  const [held, setHeld] = useState<{
    readonly attempt: number;
    readonly invoices: ReadonlyArray<KinRecord> | null;
  } | null>(null);
  const [picked, setPicked] = useState<KinRecordKey | null>(null);
  const [requestId] = useState(randomUUID);
  const payer = receipt.settable?.party ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the client's open invoices from the host when the dialog opens or Retry is pressed
  useEffect(() => {
    let current = true;
    void kinClient.workList
      .run(appAtomRegistry, {
        environmentId,
        input: {
          orgId,
          list: KIN_INVOICES_LIST,
          states: ["waiting"],
          ...(payer === null ? {} : { party: payer }),
          limit: 50,
        },
      })
      .then((result) => {
        if (current)
          setHeld({
            attempt,
            invoices: AsyncResult.isSuccess(result) ? result.value.records : null,
          });
      });
    return () => {
      current = false;
    };
  }, [environmentId, orgId, payer, attempt]);
  const invoices = held?.attempt === attempt ? held.invoices : undefined;
  const choice = invoices?.find((one) => one.key === picked) ?? invoices?.[0] ?? null;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !actions.busy) props.onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{KIN_RECEIPTS.setAgainst}</DialogTitle>
          <DialogDescription>
            {`${receipt.heading} · ${receipt.amount ?? ""}. ${KIN_RECEIPTS.setAgainstDetail}`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {invoices === undefined ? (
            <div role="status" aria-label="Loading invoices">
              <Skeleton className="h-9 w-full" />
            </div>
          ) : invoices === null ? (
            <div className="flex flex-col items-start gap-2">
              <Alert variant="error">
                <AlertDescription>Couldn't load invoices.</AlertDescription>
              </Alert>
              <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
                Retry
              </Button>
            </div>
          ) : invoices.length === 0 || choice === null ? (
            <p className="text-sm text-muted-foreground">{KIN_RECEIPTS.noInvoices}</p>
          ) : (
            <Select
              value={choice.key}
              onValueChange={(value) =>
                setPicked(invoices.find((one) => one.key === value)?.key ?? null)
              }
            >
              <SelectTrigger aria-label={KIN_RECEIPTS.pickInvoice} className="w-full">
                <SelectValue>{choice.title}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {invoices.map((one) => (
                  <SelectItem key={one.key} value={one.key}>
                    {one.title}
                    {one.balance === undefined ? null : (
                      <span className="ms-auto ps-3 text-muted-foreground tabular-nums">
                        {kinMoneyText(one.balance)}
                      </span>
                    )}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          {actions.problem === null ? null : (
            <Alert variant="error" className="mt-3">
              <AlertDescription>{actions.problem}</AlertDescription>
            </Alert>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={actions.busy} onClick={props.onClose}>
            {KIN_WORK_COPY.cancel}
          </Button>
          <Button
            disabled={actions.busy || choice === null}
            aria-busy={actions.busy}
            onClick={async () => {
              if (choice === null) return;
              const made = await actions.makeReceipt(
                choice.key,
                { key: receipt.key, against: choice.key },
                requestId,
              );
              if (made !== null) props.onClose();
            }}
          >
            {KIN_RECEIPTS.setAgainst}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
