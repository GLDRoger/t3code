import { useAtomValue } from "@effect/atom-react";
import {
  KIN_INVOICES,
  kinBase64Bytes,
  kinConfirmTotal,
  kinDocFileLine,
  kinInvoiceActions,
  kinInvoiceMissingClient,
  kinTemplatesFor,
  type KinInvoiceView,
} from "@t3tools/client-runtime/kin/kinInvoices";
import { KIN_LISTS, kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_LINES,
  KIN_QUOTES,
  kinLineDrafts,
  kinLinesInput,
  kinQuoteActions,
  kinQuoteInvoice,
  type KinLineDraft,
  type KinQuoteRowView,
} from "@t3tools/client-runtime/kin/kinMoneyAnswers";
import { KIN_TEMPLATES, kinDefaultTemplate } from "@t3tools/client-runtime/kin/kinTemplates";
import { KIN_WORK_COPY } from "@t3tools/client-runtime/kin/kinWorkChanges";
import type {
  EnvironmentId,
  KinDocFile,
  KinListDefinition,
  KinRecipe,
  KinPartyRef,
  KinRecordDetail,
  KinRecordKey,
  KinRecordState,
} from "@t3tools/contracts";
import {
  BanIcon,
  CheckIcon,
  ChevronLeftIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  ReceiptIcon,
  RotateCcwIcon,
  StampIcon,
} from "lucide-react";
import { useEffect, useId, useState } from "react";

import { useAtomCommand } from "../state/use-atom-command";
import { kinHostConnected } from "./useKinHost";

import { useAssetUrls } from "../assets/assetUrls";
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
import { SheetDescription, SheetHeader, SheetTitle } from "../components/ui/sheet";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { cn, randomUUID } from "../lib/utils";
import { KinWorkSection as Section } from "./KinWorkParts";
import { kinClient } from "./kinClient";
import { KinLinesEditor } from "./KinMoneyAnswers";
import { useKinMoneyActions, useKinRecipes, type KinPreviewFile } from "./useKinMoney";
import { useKinEntryLines, useKinInvoiceFromQuote } from "./useKinMoneyAnswers";
import type { KinWorkTarget } from "./useKinWork";

type MoneyActions = ReturnType<typeof useKinMoneyActions>;

/** What an invoice's actions said: the number it got, what couldn't be made, or why not. */
export function KinMoneyActionNotice(props: {
  readonly actions: MoneyActions;
  /** Opens the document an action filed, named in its notice. */
  readonly onOpenDoc?: (key: KinRecordKey) => void;
}) {
  const { problem, notice, filed } = props.actions;
  const { onOpenDoc } = props;
  if (problem === null && notice === null) return null;
  return (
    <Alert variant={problem === null ? "info" : "error"} controlAlignment="first-line">
      <AlertDescription>{problem ?? notice}</AlertDescription>
      {problem !== null || filed === null || onOpenDoc === undefined ? null : (
        <AlertAction>
          <Button size="xs" variant="outline" onClick={() => onOpenDoc(filed)}>
            {KIN_INVOICES.openFiled(filed)}
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}

/** Make invoice, Issue, Void and its way back, beside the entry's own taps. */
export function KinInvoiceActions(
  props: KinWorkTarget & {
    readonly itemKey: KinRecordKey;
    readonly invoice: KinInvoiceView;
    readonly def: KinListDefinition | null;
    readonly actions: MoneyActions;
    /** The invoice's client, to edit when Make invoice needs a detail of theirs. */
    readonly party: KinPartyRef | null;
    readonly busy: boolean;
    /** Opens Make invoice as the sheet's next step. */
    readonly onMake: () => void;
  },
) {
  const { environmentId, orgId, invoice, actions } = props;
  const allowed = {
    render: useAtomValue(kinClient.docRender.permissionAtom(environmentId)),
    issue: useAtomValue(kinClient.workIssue.permissionAtom(environmentId)),
    receipt: useAtomValue(kinClient.makeReceipt.permissionAtom(environmentId)),
  };
  const can = kinInvoiceActions(invoice, props.def, allowed);
  const [asking, setAsking] = useState<"issue" | "void" | null>(null);
  const readNext = useAtomCommand(kinClient.workNextNumber, { reportFailure: false });
  const [next, setNext] = useState<{ readonly number: string | null } | "reading" | null>(null);
  const askIssue = async () => {
    setAsking("issue");
    setNext("reading");
    const read = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => readNext({ environmentId, input: { orgId, key: props.itemKey } }),
    });
    setNext(read.ok ? read.value : null);
  };
  const busy = props.busy || actions.busy;
  if (!can.make && !can.issue && !can.void && !can.unvoid) return null;
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {can.make ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              actions.dismiss();
              props.onMake();
            }}
          >
            <FileTextIcon />
            {KIN_INVOICES.makePdf}
          </Button>
        ) : null}
        {can.issue ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void askIssue()}>
            <StampIcon />
            {KIN_INVOICES.issue}
          </Button>
        ) : null}
        {can.void ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setAsking("void")}>
            <BanIcon />
            {KIN_INVOICES.voidAction}
          </Button>
        ) : null}
        {can.unvoid ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void actions.unvoid(props.itemKey)}
          >
            <RotateCcwIcon />
            {KIN_INVOICES.unvoid}
          </Button>
        ) : null}
      </div>
      <AlertDialog
        open={asking !== null}
        onOpenChange={(next) => {
          if (!next) setAsking(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {asking === "void" ? KIN_INVOICES.voidTitle : KIN_INVOICES.issueTitle}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {asking === "issue" && invoice.issueTotal !== null ? (
                <span className="block">{invoice.issueTotal}</span>
              ) : null}
              {asking === "void"
                ? KIN_INVOICES.voidDetail
                : next !== null && next !== "reading" && next.number !== null
                  ? KIN_INVOICES.issueNumber(next.number)
                  : KIN_INVOICES.issueDetail(invoice.prefix)}
            </AlertDialogDescription>
            {asking === "issue" && next === "reading" ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                {KIN_INVOICES.readingNumber}
              </p>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {KIN_WORK_COPY.cancel}
            </AlertDialogClose>
            <Button
              variant={asking === "void" ? "destructive" : "default"}
              onClick={() => {
                const doing = asking;
                setAsking(null);
                if (doing === "issue") void actions.issue(props.itemKey);
                if (doing === "void") void actions.void(props.itemKey);
              }}
            >
              {asking === "void" ? KIN_INVOICES.voidAction : KIN_INVOICES.issue}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** A quote's taps: its PDF, sent, accepted or declined and back, and its invoice made from it. */
export function KinQuoteActions(
  props: KinWorkTarget & {
    readonly item: KinRecordDetail;
    readonly quote: KinQuoteRowView;
    readonly def: KinListDefinition | null;
    readonly actions: MoneyActions;
    readonly busy: boolean;
    readonly canChange: boolean;
    readonly onState: (state: KinRecordState) => void;
    readonly onOpenKey: (key: KinRecordKey) => void;
    /** Opens Make its PDF as the sheet's next step. */
    readonly onMakePdf: () => void;
  },
) {
  const { environmentId, item, quote, actions } = props;
  const allowed = {
    render: useAtomValue(kinClient.docRender.permissionAtom(environmentId)),
    issue: useAtomValue(kinClient.workIssue.permissionAtom(environmentId)),
    invoice: useAtomValue(kinClient.workInvoiceFromQuote.permissionAtom(environmentId)),
  };
  const invoicing = useKinInvoiceFromQuote(props);
  const invoiced = invoicing.invoice ?? kinQuoteInvoice(item.links);
  const can = kinQuoteActions(quote.state, props.def?.numbering !== undefined, invoiced !== null);
  const [sending, setSending] = useState(false);
  const [requestId] = useState(randomUUID);
  const busy = props.busy || actions.busy || invoicing.busy;
  const numbered = quote.number !== item.key;
  const sendTotal = kinConfirmTotal(item.amount, item.party?.title);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {invoiced === null || invoicing.invoice !== null ? null : (
          <>
            <span className="text-sm text-muted-foreground">{KIN_QUOTES.invoicedAs(invoiced)}</span>
            <Button size="sm" variant="outline" onClick={() => props.onOpenKey(invoiced)}>
              <FileTextIcon />
              {KIN_QUOTES.openInvoice}
            </Button>
          </>
        )}
        {can.makeInvoice && allowed.invoice ? (
          <Button
            size="sm"
            disabled={busy}
            aria-busy={invoicing.busy}
            onClick={() => void invoicing.make(item.key, requestId)}
          >
            <FileTextIcon />
            {invoicing.busy ? KIN_QUOTES.makingInvoice : KIN_QUOTES.makeInvoice}
          </Button>
        ) : null}
        {can.send && allowed.issue ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setSending(true)}>
            <StampIcon />
            {KIN_QUOTES.send}
          </Button>
        ) : null}
        {can.accept && props.canChange ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => props.onState("done")}>
            <CheckIcon />
            {KIN_QUOTES.accept}
          </Button>
        ) : null}
        {can.decline && allowed.issue ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void actions.void(item.key)}
          >
            <BanIcon />
            {KIN_QUOTES.decline}
          </Button>
        ) : null}
        {can.unaccept && props.canChange ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => props.onState(numbered ? "waiting" : "open")}
          >
            <RotateCcwIcon />
            {KIN_QUOTES.unaccept}
          </Button>
        ) : null}
        {can.undecline && allowed.issue ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void actions.unvoid(item.key)}
          >
            <RotateCcwIcon />
            {KIN_QUOTES.undecline}
          </Button>
        ) : null}
        {quote.state !== "declined" && allowed.render ? (
          <Button size="sm" variant="ghost" disabled={busy} onClick={props.onMakePdf}>
            <FileTextIcon />
            {KIN_INVOICES.makePdf}
          </Button>
        ) : null}
      </div>
      {invoicing.problem === null && invoicing.notice === null ? null : (
        <Alert
          variant={invoicing.problem === null ? "info" : "error"}
          controlAlignment="first-line"
        >
          <AlertDescription>{invoicing.problem ?? invoicing.notice}</AlertDescription>
          {invoicing.invoice === null ? null : (
            <AlertAction>
              <Button
                size="xs"
                variant="outline"
                onClick={() => props.onOpenKey(invoicing.invoice!)}
              >
                {KIN_QUOTES.openInvoice}
              </Button>
            </AlertAction>
          )}
        </Alert>
      )}
      <AlertDialog open={sending} onOpenChange={setSending}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{KIN_QUOTES.sendTitle}</AlertDialogTitle>
            <AlertDialogDescription>
              {sendTotal === null ? null : <span className="block">{sendTotal}</span>}
              {KIN_QUOTES.sendDetail}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              {KIN_WORK_COPY.cancel}
            </AlertDialogClose>
            <Button
              onClick={() => {
                setSending(false);
                void actions.issue(item.key);
              }}
            >
              {KIN_QUOTES.send}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

/** A file shown from memory: a blob URL made when it arrives, let go when it is replaced. */
export function kinPreviewUrl(file: KinPreviewFile) {
  const bytes = kinBase64Bytes(file.base64);
  return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: file.mimeType }));
}

/**
 * Pick a template, see the document as it would be made, then file it: a step inside the entry's
 * sheet, never a dialog over it, with the preview in the sheet and a way back to the entry.
 */
export function KinMakeDocumentStep(
  props: KinWorkTarget & {
    readonly itemKey: KinRecordKey;
    readonly list: string;
    readonly title?: string;
    /** The entry's currency: every line is in it. */
    readonly currency: string;
    readonly actions: MoneyActions;
    readonly party: KinPartyRef | null;
    /** What Back returns to: the entry's own heading. */
    readonly backLabel: string;
    readonly onOpenClient: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  const { actions } = props;
  const readLines = useKinEntryLines(props);
  const [lines, setLines] = useState<ReadonlyArray<KinLineDraft> | null>(null);
  const [linesProblem, setLinesProblem] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the lines its last document was made with from the host once, when the form opens
  useEffect(() => {
    let live = true;
    void readLines(props.itemKey).then((held) => {
      if (live) setLines(kinLineDrafts(held));
    });
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- once per entry; the reader is remade every render
  }, [props.itemKey]);
  const inputsOf = () => {
    const checked = kinLinesInput(lines ?? [], props.currency);
    if (!checked.ok) {
      setLinesProblem(checked.problem);
      return null;
    }
    setLinesProblem(null);
    return checked.lines === null ? {} : { lines: checked.lines };
  };
  const recipes = useKinRecipes(props, true);
  const templates: ReadonlyArray<KinRecipe> =
    recipes.state._tag === "ready" ? kinTemplatesFor(recipes.state.value.recipes, props.list) : [];
  const [picked, setPicked] = useState<string | null>(null);
  const recipe = templates.find((one) => one.name === picked) ?? kinDefaultTemplate(templates);
  const missing = kinInvoiceMissingClient(actions.problem, props.party);
  const [shown, setShown] = useState<{
    readonly url: string;
    readonly file: KinPreviewFile;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [requestId] = useState(randomUUID);
  const selectId = useId();
  const show = (next: typeof shown) => {
    if (shown !== null) URL.revokeObjectURL(shown.url);
    setShown(next);
  };
  const close = () => {
    show(null);
    props.onClose();
  };
  const preview = async () => {
    if (recipe === null) return;
    const inputs = inputsOf();
    if (inputs === null) return;
    setFailed(false);
    const files = await actions.preview(recipe.name, props.itemKey, inputs);
    const file = files?.[0];
    if (file === undefined) return setFailed(files !== null);
    show({ url: kinPreviewUrl(file), file });
  };
  return (
    <>
      <SheetHeader>
        <div className="flex flex-col items-start gap-1 pe-8">
          <Button size="xs" variant="ghost" disabled={actions.busy} onClick={close}>
            <ChevronLeftIcon />
            {props.backLabel}
          </Button>
          <SheetTitle>{props.title ?? KIN_INVOICES.makePdf}</SheetTitle>
          {recipe === null ? null : <SheetDescription>{recipe.description}</SheetDescription>}
        </div>
      </SheetHeader>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6">
        {recipes.state._tag === "loading" ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Loading templates…
          </p>
        ) : recipes.state._tag !== "ready" ? (
          <div className="flex flex-col items-start gap-2">
            <Alert variant="error">
              <AlertDescription>{KIN_TEMPLATES.loadFailed}</AlertDescription>
            </Alert>
            <Button size="sm" variant="outline" onClick={recipes.refresh}>
              Retry
            </Button>
          </div>
        ) : recipe === null ? (
          <p className="text-sm text-muted-foreground">{KIN_INVOICES.noTemplate}</p>
        ) : templates.length > 1 ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={selectId}>{KIN_INVOICES.template}</Label>
            <Select
              value={recipe.name}
              onValueChange={(value) => {
                setPicked(templates.find((one) => one.name === value)?.name ?? null);
                show(null);
              }}
            >
              <SelectTrigger id={selectId} className="w-full sm:w-80">
                <SelectValue>{recipe.title}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {templates.map((one) => (
                  <SelectItem key={one.name} value={one.name}>
                    {one.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
        ) : null}
        {recipe === null || shown !== null ? null : lines === null ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            {KIN_LINES.title}…
          </p>
        ) : (
          <KinLinesEditor
            lines={lines}
            disabled={actions.busy}
            onChange={(next) => {
              setLines(next);
              setLinesProblem(null);
            }}
          />
        )}
        {linesProblem === null ? null : (
          <Alert variant="error">
            <AlertDescription>{linesProblem}</AlertDescription>
          </Alert>
        )}
        {shown !== null ? (
          // oxlint-disable-next-line react/iframe-missing-sandbox -- Chrome will not render a PDF in a sandboxed frame; the src is a blob made here
          <iframe
            title={`${KIN_INVOICES.preview}: ${shown.file.name}`}
            src={shown.url}
            className="h-[60vh] w-full rounded-md border border-border bg-white"
          />
        ) : actions.busy ? (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            {KIN_INVOICES.previewing}
          </p>
        ) : null}
        {failed ? (
          <Alert variant="error">
            <AlertDescription>{KIN_INVOICES.previewFailed}</AlertDescription>
          </Alert>
        ) : null}
        <KinMoneyActionNotice actions={actions} />
        {missing === null ? null : (
          <div className="flex flex-col items-start gap-2">
            <p className="text-sm text-foreground">{KIN_INVOICES.missingClient(missing.name)}</p>
            <Button size="sm" variant="outline" onClick={() => props.onOpenClient(missing.key)}>
              {KIN_INVOICES.editClient(missing.name)}
            </Button>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="outline" disabled={actions.busy} onClick={close}>
            {KIN_WORK_COPY.cancel}
          </Button>
          {shown !== null ? (
            <Button variant="outline" render={<a href={shown.url} download={shown.file.name} />}>
              Download preview
            </Button>
          ) : null}
          {recipe === null ? null : shown === null ? (
            <Button disabled={actions.busy} aria-busy={actions.busy} onClick={() => void preview()}>
              {KIN_INVOICES.preview}
            </Button>
          ) : (
            <Button
              disabled={actions.busy}
              aria-busy={actions.busy}
              onClick={async () => {
                const inputs = inputsOf();
                if (inputs === null) return;
                const filed = await actions.file(recipe.name, props.itemKey, requestId, inputs);
                if (filed !== null) close();
              }}
            >
              {KIN_INVOICES.file}
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

/** Where the invoice was sent from Kin, newest first. */
export function KinInvoiceSent(props: { readonly invoice: KinInvoiceView }) {
  if (props.invoice.sent.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
      {props.invoice.sent.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/** Total, what came in and what is left; a void invoice says so instead of owing. */
export function KinInvoiceFigures(props: { readonly invoice: KinInvoiceView }) {
  const { invoice } = props;
  if (invoice.void) return <p className="text-sm text-muted-foreground">{KIN_INVOICES.voidNote}</p>;
  if (invoice.balance === null) return null;
  const figures = (
    <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
      <div className="flex flex-col">
        <dt className="text-xs text-muted-foreground">{KIN_INVOICES.balance}</dt>
        <dd className="text-foreground tabular-nums">
          {invoice.settled ? KIN_INVOICES.paidInFull : invoice.balance}
        </dd>
      </div>
      <div className="flex flex-col">
        <dt className="text-xs text-muted-foreground">{KIN_INVOICES.received}</dt>
        <dd className="text-foreground tabular-nums">{invoice.received}</dd>
      </div>
      {invoice.tdsDeducted === null ? null : (
        <div className="flex flex-col">
          <dt className="text-xs text-muted-foreground">{KIN_INVOICES.tdsDeducted}</dt>
          <dd className="text-foreground tabular-nums">{invoice.tdsDeducted}</dd>
        </div>
      )}
    </dl>
  );
  return invoice.bank === null ? (
    figures
  ) : (
    <>
      {figures}
      <p className="text-xs text-muted-foreground">{invoice.bank}</p>
    </>
  );
}

/** Each payment with its receipt: open it, or make one. Taking a payment back stays here too. */
export function KinInvoicePayments(
  props: KinWorkTarget & {
    readonly itemKey: KinRecordKey;
    readonly invoice: KinInvoiceView;
    readonly actions: MoneyActions;
    readonly canPay: boolean;
    readonly busy: boolean;
    readonly onTakeBack: (paymentId: string) => void;
    readonly onOpenDoc: (key: KinRecordKey) => void;
  },
) {
  const { invoice, actions } = props;
  const canReceipt = useAtomValue(kinClient.makeReceipt.permissionAtom(props.environmentId));
  const busy = props.busy || actions.busy;
  return (
    <Section title={KIN_INVOICES.payments}>
      {invoice.payments.length === 0 ? (
        <p className="text-sm text-muted-foreground">{KIN_INVOICES.noPayments}</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border/60">
          {invoice.payments.map((payment) => {
            const { receipt } = payment;
            const number = receipt === null || receipt._tag === "none" ? null : receipt.number;
            return (
              <li key={payment.paymentId} className="flex items-start gap-3 py-2 text-sm">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    className={cn(
                      "tabular-nums",
                      payment.voided ? "text-muted-foreground line-through" : "text-foreground",
                    )}
                  >
                    {payment.amount}
                  </span>
                  <span className="text-xs break-words text-muted-foreground">
                    {[
                      payment.tds ? KIN_INVOICES.tdsDeducted : null,
                      payment.when,
                      payment.note,
                      payment.source,
                      payment.voided ? KIN_INVOICES.takenBack : null,
                    ]
                      .filter((part) => part !== null)
                      .join(" · ")}
                  </span>
                  {number === null ? null : (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <ReceiptIcon aria-hidden className="size-3" />
                      {number}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 flex-wrap justify-end gap-1">
                  {receipt?._tag === "ready" ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`${KIN_INVOICES.openPdf}: ${number ?? payment.amount}`}
                      onClick={() => props.onOpenDoc(receipt.document)}
                    >
                      {KIN_INVOICES.openPdf}
                    </Button>
                  ) : receipt === null || !canReceipt ? null : (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      aria-label={`${receipt._tag === "noPdf" ? KIN_INVOICES.makePdf : KIN_INVOICES.makeReceipt}: ${payment.amount}`}
                      onClick={() =>
                        void actions.makeReceipt(
                          props.itemKey,
                          receipt._tag === "noPdf"
                            ? { key: receipt.key }
                            : { paymentId: payment.paymentId },
                          `receipt:${payment.paymentId}`,
                        )
                      }
                    >
                      {receipt._tag === "noPdf" ? KIN_INVOICES.makePdf : KIN_INVOICES.makeReceipt}
                    </Button>
                  )}
                  {payment.voided || !props.canPay ? null : (
                    <Button
                      size="xs"
                      variant="ghost"
                      disabled={busy}
                      aria-label={`${KIN_LISTS.entry.takeBack}: ${payment.amount}`}
                      onClick={() => props.onTakeBack(payment.paymentId)}
                    >
                      {KIN_LISTS.entry.takeBack}
                    </Button>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </Section>
  );
}

/** The PDFs made for it, newest first, each opened on its doc's page. */
export function KinInvoiceDocuments(props: {
  readonly invoice: KinInvoiceView;
  readonly onOpenDoc: (key: KinRecordKey) => void;
}) {
  return (
    <Section title={KIN_INVOICES.documents}>
      {props.invoice.documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">{KIN_INVOICES.noDocuments}</p>
      ) : (
        <ul className="flex flex-col">
          {props.invoice.documents.map((doc) => (
            <li key={doc.key}>
              <button
                type="button"
                onClick={() => props.onOpenDoc(doc.key)}
                className="flex min-h-9 w-full items-center gap-3 rounded-md px-1 py-1.5 text-start text-sm outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
              >
                <FileTextIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-foreground">{doc.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{doc.key}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** A doc's made file, such as an invoice's PDF: open it in a tab or keep a copy. */
export function KinDocFileCard(props: {
  readonly environmentId: EnvironmentId;
  readonly file: KinDocFile;
}) {
  const { file } = props;
  const [url] = useAssetUrls(props.environmentId, [
    {
      _tag: "attachment",
      attachmentId: file.attachmentId,
      fileName: file.name,
      mimeType: file.mimeType,
    },
  ]);
  const href = url ?? null;
  const row = (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
      <FileTextIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-foreground">{file.name}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{kinDocFileLine(file)}</span>
      </span>
      <span className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={href === null}
          render={href === null ? undefined : <a href={href} target="_blank" rel="noreferrer" />}
        >
          <ExternalLinkIcon />
          Open
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={href === null}
          render={href === null ? undefined : <a href={href} download={file.name} />}
        >
          <DownloadIcon />
          Download
        </Button>
      </span>
    </div>
  );
  // A picture is shown as itself, above the row that opens and downloads it.
  if (href === null || !file.mimeType.startsWith("image/")) return row;
  return (
    <>
      <img
        src={href}
        alt={file.name}
        className="block h-auto max-h-[70vh] w-auto max-w-full rounded-lg border border-border"
      />
      {row}
    </>
  );
}
