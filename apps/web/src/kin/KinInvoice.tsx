import { useAtomValue } from "@effect/atom-react";
import {
  KIN_INVOICES,
  kinBase64Bytes,
  kinDocFileLine,
  kinInvoiceActions,
  kinInvoiceUnvoidState,
  kinTemplatesFor,
  type KinInvoiceView,
} from "@t3tools/client-runtime/kin/kinInvoices";
import { KIN_LISTS } from "@t3tools/client-runtime/kin/kinLists";
import { KIN_WORK_COPY } from "@t3tools/client-runtime/kin/kinWorkChanges";
import type {
  EnvironmentId,
  KinDocFile,
  KinListDefinition,
  KinRecipe,
  KinRecordKey,
} from "@t3tools/contracts";
import {
  BanIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileTextIcon,
  ReceiptIcon,
  RotateCcwIcon,
  StampIcon,
} from "lucide-react";
import { useId, useState } from "react";

import { useAssetUrls } from "../assets/assetUrls";
import { Alert, AlertDescription } from "../components/ui/alert";
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
import { useKinMoneyActions, useKinRecipes, type KinPreviewFile } from "./useKinMoney";
import type { KinWorkTarget } from "./useKinWork";

type MoneyActions = ReturnType<typeof useKinMoneyActions>;

/** What an invoice's actions said: the number it got, what couldn't be made, or why not. */
export function KinMoneyActionNotice(props: { readonly actions: MoneyActions }) {
  const { problem, notice } = props.actions;
  if (problem === null && notice === null) return null;
  return (
    <Alert variant={problem === null ? "info" : "error"}>
      <AlertDescription>{problem ?? notice}</AlertDescription>
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
    /** Moves it back from void, as a status change. */
    readonly onUnvoid: (state: "open" | "waiting") => void;
    readonly busy: boolean;
  },
) {
  const { environmentId, invoice, actions } = props;
  const allowed = {
    render: useAtomValue(kinClient.docRender.permissionAtom(environmentId)),
    issue: useAtomValue(kinClient.workIssue.permissionAtom(environmentId)),
    change: useAtomValue(kinClient.workUpdate.permissionAtom(environmentId)),
    receipt: useAtomValue(kinClient.makeReceipt.permissionAtom(environmentId)),
  };
  const can = kinInvoiceActions(invoice, props.def, allowed);
  const [asking, setAsking] = useState<"issue" | "void" | null>(null);
  const [making, setMaking] = useState(false);
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
              setMaking(true);
            }}
          >
            <FileTextIcon />
            {KIN_INVOICES.makeInvoice}
          </Button>
        ) : null}
        {can.issue ? (
          <Button size="sm" variant="outline" disabled={busy} onClick={() => setAsking("issue")}>
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
            onClick={() => props.onUnvoid(kinInvoiceUnvoidState(invoice))}
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
              {asking === "void"
                ? KIN_INVOICES.voidDetail
                : KIN_INVOICES.issueDetail(invoice.prefix)}
            </AlertDialogDescription>
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
      {making ? (
        <KinMakeDocumentDialog
          {...props}
          list={props.def?.list ?? "invoices"}
          onClose={() => setMaking(false)}
        />
      ) : null}
    </>
  );
}

/** A file shown from memory: a blob URL made when it arrives, let go when it is replaced. */
export function kinPreviewUrl(file: KinPreviewFile) {
  const bytes = kinBase64Bytes(file.base64);
  return URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: file.mimeType }));
}

/** Pick a template, see the document as it would be made, then file it. */
function KinMakeDocumentDialog(
  props: KinWorkTarget & {
    readonly itemKey: KinRecordKey;
    readonly list: string;
    readonly actions: MoneyActions;
    readonly onClose: () => void;
  },
) {
  const { actions } = props;
  const recipes = useKinRecipes(props, true);
  const templates: ReadonlyArray<KinRecipe> =
    recipes.state._tag === "ready" ? kinTemplatesFor(recipes.state.value.recipes, props.list) : [];
  const [picked, setPicked] = useState<string | null>(null);
  const recipe = templates.find((one) => one.name === picked) ?? templates[0] ?? null;
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
    setFailed(false);
    const files = await actions.preview(recipe.name, props.itemKey);
    const file = files?.[0];
    if (file === undefined) return setFailed(files !== null);
    show({ url: kinPreviewUrl(file), file });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !actions.busy) close();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{KIN_INVOICES.makeInvoice}</DialogTitle>
          {recipe === null ? null : <DialogDescription>{recipe.description}</DialogDescription>}
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            {recipes.state._tag === "loading" ? (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner />
                Loading templates…
              </p>
            ) : recipes.state._tag !== "ready" ? (
              <div className="flex flex-col items-start gap-2">
                <Alert variant="error">
                  <AlertDescription>Couldn't load your templates.</AlertDescription>
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
          </div>
        </DialogPanel>
        <DialogFooter>
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
                const filed = await actions.file(recipe.name, props.itemKey, requestId);
                if (filed !== null) close();
              }}
            >
              {KIN_INVOICES.file}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** Total, what came in and what is left; a void invoice says so instead of owing. */
export function KinInvoiceFigures(props: { readonly invoice: KinInvoiceView }) {
  const { invoice } = props;
  if (invoice.void) return <p className="text-sm text-muted-foreground">{KIN_INVOICES.voidNote}</p>;
  if (invoice.balance === null) return null;
  return (
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
                  <span className="truncate text-xs text-muted-foreground">
                    {[
                      payment.tds ? KIN_INVOICES.tdsDeducted : null,
                      payment.when,
                      payment.note,
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
  return (
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
}
