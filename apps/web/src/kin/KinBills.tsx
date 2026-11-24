import {
  KIN_BILLS,
  kinBillBatchSentence,
  kinBillCounts,
  kinBillExpenseStart,
  kinBillIsPdf,
  kinBillRowView,
  kinBillsButton,
  kinBillsCanKeepAll,
  kinBillsEntry,
  kinBillsOutcome,
  kinBillUploadText,
  type KinBillAction,
  type KinBillRowView,
  type KinBillTone,
} from "@t3tools/client-runtime/kin/kinBills";
import { kinCategoryLabel } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_DEFAULT_HOME_CURRENCY,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type EnvironmentId,
  type KinAttachment,
  type KinBillRow,
  type KinRecordKey,
} from "@t3tools/contracts";
import { ChevronRightIcon, FileIcon, UploadIcon, XIcon } from "lucide-react";
import { memo, useRef, useState } from "react";

import { useAssetUrls } from "../assets/assetUrls";
import { openExpandedImagePreview } from "../components/chat/ExpandedImageDialog";
import { normalizeComposerImageFileMimeType } from "../components/chat/composerAttachmentFiles";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../composerDraftStore";
import { AttachmentImage } from "../components/media/AttachmentImage";
import { Alert, AlertDescription } from "../components/ui/alert";
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
import {
  awaitAttachmentUploads,
  getUploadedAttachments,
  readAttachmentUpload,
  releaseAttachmentUpload,
  startAttachmentUpload,
} from "../lib/attachmentUploadQueue";
import { prepareImageForAttachment } from "../lib/imageCompression";
import { cn, randomUUID } from "../lib/utils";
import { KinNewExpenseDialog } from "./KinMoneyForms";
import { KinLoadFailed, KinWorkNotice, KinWorkRowSkeletons } from "./KinWorkParts";
import {
  useKinBillActions,
  useKinBillBatch,
  useKinBillBatches,
  useKinBillsAdd,
} from "./useKinBills";
import { useNowMinuteMs } from "./useKinClock";
import { kinListsOf, useKinHomeCurrency, useKinLists } from "./useKinMoney";
import type { KinWorkTarget } from "./useKinWork";

const OPENS =
  "rounded-md outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset";

/** One bill's bytes through the composer's upload path; the host claims it on the add. */
async function uploadBill(
  environmentId: EnvironmentId,
  file: File,
  name: string,
  held: Set<string>,
): Promise<KinAttachment> {
  const id = randomUUID();
  let draft: ComposerImageAttachment | ComposerFileAttachment;
  if (kinBillIsPdf({ name, mimeType: file.type })) {
    draft = {
      type: "file",
      id,
      name,
      mimeType: "application/pdf",
      sizeBytes: file.size,
      file,
    };
  } else {
    const prepared = await prepareImageForAttachment(
      normalizeComposerImageFileMimeType(file),
      PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
    ).catch(() => null);
    if (prepared === null || !prepared.ok)
      throw new Error(
        prepared?.ok === false && prepared.reason === "too-large"
          ? "Too large, even after making it smaller."
          : "Couldn't read this as a photo.",
      );
    draft = {
      type: "image",
      id,
      name,
      mimeType: prepared.file.type,
      sizeBytes: prepared.file.size,
      previewUrl: "",
      file: prepared.file,
    };
  }
  held.add(id);
  startAttachmentUpload({ environmentId, image: draft });
  await awaitAttachmentUploads([id]);
  const [uploaded] = getUploadedAttachments({ environmentId, images: [draft] }) ?? [];
  if (uploaded === undefined) {
    const upload = readAttachmentUpload(id);
    throw new Error(upload?.status === "failed" ? upload.reason : KIN_BILLS.uploadFailed);
  }
  const { mimeType, sizeBytes } = uploaded;
  return draft.type === "image"
    ? { type: "image", id: uploaded.id, name, mimeType, sizeBytes }
    : { type: "file", id: uploaded.id, name, mimeType, sizeBytes };
}

/**
 * Money's Add › Bills: many photos or PDFs at once, each uploaded, then one add. Once every file
 * went in as a new bill it closes onto that batch's list; else it stays to say what didn't.
 */
export function KinAddBillsDialog(
  props: KinWorkTarget & {
    readonly onReview: (batchId: string) => void;
    readonly onOpenKey: (key: KinRecordKey) => void;
    readonly onClose: () => void;
  },
) {
  const { environmentId } = props;
  const uploads = useRef(new Set<string>());
  const adding = useKinBillsAdd<File>(props, (file, name) =>
    uploadBill(environmentId, file, name, uploads.current),
  );
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const { state } = adding;
  const busy = state.phase !== "choosing";
  const button = kinBillsButton(state);
  const outcome = kinBillsOutcome(state);
  const leave = () => {
    for (const id of uploads.current) releaseAttachmentUpload(id);
    uploads.current.clear();
  };
  const close = () => {
    if (busy) return;
    leave();
    props.onClose();
  };
  const review = (batchId: string) => {
    leave();
    props.onReview(batchId);
  };
  const openExpense = (key: KinRecordKey) => {
    leave();
    props.onOpenKey(key);
  };
  const choose = (files: FileList | null) => {
    if (files === null || busy) return;
    adding.choose(
      [...files].map((file) => ({
        id: randomUUID(),
        name: file.name || "bill",
        mimeType: file.type,
        source: file,
      })),
    );
  };
  const send = async () => {
    const done = await adding.send();
    if (done?.close === true && done.review !== null) review(done.review);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{KIN_BILLS.title}</DialogTitle>
          <DialogDescription>{KIN_BILLS.hint}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div
              data-over={over}
              className="flex flex-col items-center gap-1 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm data-[over=true]:bg-accent"
              onDragOver={(event) => {
                event.preventDefault();
                setOver(true);
              }}
              onDragLeave={() => setOver(false)}
              onDrop={(event) => {
                event.preventDefault();
                setOver(false);
                choose(event.dataTransfer.files);
              }}
            >
              <UploadIcon className="size-5" aria-hidden />
              <p>
                {KIN_BILLS.drop}{" "}
                <Button
                  variant="link"
                  size="xs"
                  disabled={busy}
                  onClick={() => input.current?.click()}
                >
                  {KIN_BILLS.choose}
                </Button>
              </p>
              <input
                ref={input}
                type="file"
                multiple
                accept="image/*,application/pdf,.pdf,.heic,.heif"
                aria-label={KIN_BILLS.pick}
                className="hidden"
                onChange={(event) => {
                  choose(event.target.files);
                  event.target.value = "";
                }}
              />
            </div>
            {state.files.length === 0 ? null : (
              <ul aria-label={KIN_BILLS.chosen} className="flex flex-col divide-y divide-border">
                {state.files.map((file) => {
                  const wrong = file.upload._tag === "failed" || file.upload._tag === "refused";
                  const removable =
                    !busy && file.upload._tag !== "added" && file.upload._tag !== "uploading";
                  return (
                    <li key={file.id} className="flex min-h-9 items-center gap-3 py-1 text-sm">
                      <span className="min-w-0 flex-1 truncate text-foreground">{file.name}</span>
                      <span
                        className={cn(
                          "text-xs",
                          wrong
                            ? "min-w-0 max-w-[60%] text-right text-destructive-foreground"
                            : "shrink-0 text-muted-foreground",
                        )}
                      >
                        {kinBillUploadText(file.upload)}
                      </span>
                      <span className="size-7 shrink-0">
                        {removable ? (
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`${KIN_BILLS.remove} ${file.name}`}
                            onClick={() => adding.remove(file.id)}
                          >
                            <XIcon />
                          </Button>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
            {state.problem === null ? null : (
              <Alert variant="error">
                <AlertDescription>{state.problem}</AlertDescription>
              </Alert>
            )}
            {outcome === null ||
            (outcome.lines.length === 0 && outcome.dropped.length === 0) ? null : (
              <div role="status" className="flex flex-col gap-1 text-sm text-muted-foreground">
                {outcome.lines.map((line) => (
                  <p key={line}>{line}</p>
                ))}
                {outcome.dropped.map((one) => (
                  <p key={one.key}>
                    {one.text}{" "}
                    <Button
                      variant="link"
                      size="xs"
                      disabled={busy}
                      onClick={() => openExpense(one.expense)}
                    >
                      {KIN_BILLS.open(one.expense)}
                    </Button>
                  </p>
                ))}
              </div>
            )}
          </div>
        </DialogPanel>
        <DialogFooter>
          {outcome?.review == null ? (
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => review(outcome.review ?? "")}
            >
              {KIN_BILLS.review}
            </Button>
          )}
          {outcome !== null && button.count === 0 ? null : (
            <Button
              type="button"
              disabled={button.disabled}
              aria-busy={busy}
              onClick={() => void send()}
            >
              {button.label}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** On Expenses, once there are bills added in bulk: one quiet line to them. */
export function KinBillsAddedLink(
  props: KinWorkTarget & { readonly onOpen: (batchId: string | null) => void },
) {
  const { allowed, state } = useKinBillBatches(props);
  const nowMs = useNowMinuteMs();
  if (!allowed || state._tag !== "ready") return null;
  const entry = kinBillsEntry(state.value.batches, new Date(nowMs));
  if (entry === null) return null;
  return (
    <button
      type="button"
      onClick={() => props.onOpen(entry.batchId)}
      className={cn("flex w-full items-center gap-3 px-2 py-1.5 text-start", OPENS)}
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm text-foreground">{entry.label}</span>
        <span className="truncate text-xs text-muted-foreground">{entry.detail}</span>
      </span>
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** Under Money: every batch, newest first, or one batch's bills to review. */
export function KinBillsPage(
  props: KinWorkTarget & {
    readonly batchId: string | null;
    readonly onOpenKey: (key: KinRecordKey) => void;
    readonly onOpenBatch: (batchId: string) => void;
  },
) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-8 scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pt-4">
        {props.batchId === null ? (
          <KinBillBatches {...props} />
        ) : (
          <KinBillBatchReview key={props.batchId} {...props} batchId={props.batchId} />
        )}
      </div>
    </div>
  );
}

function Loading() {
  return (
    <div role="status" aria-label="Loading bills">
      <KinWorkRowSkeletons />
    </div>
  );
}

function KinBillBatches(
  props: KinWorkTarget & { readonly onOpenBatch: (batchId: string) => void },
) {
  const { state, refresh } = useKinBillBatches(props);
  const now = new Date(useNowMinuteMs());
  if (state._tag === "refused") return <KinWorkNotice {...KIN_BILLS.onlyOwner} />;
  if (state._tag === "loading") return <Loading />;
  if (state._tag !== "ready")
    return (
      <KinLoadFailed
        what={KIN_BILLS.loadFailed}
        cause={state._tag === "failed" ? state.cause : null}
        onRetry={refresh}
      />
    );
  if (state.value.batches.length === 0) return <KinWorkNotice {...KIN_BILLS.none} />;
  return (
    <ul className="flex flex-col">
      {state.value.batches.map((batch) => (
        <li key={batch.batchId}>
          <button
            type="button"
            onClick={() => props.onOpenBatch(batch.batchId)}
            className={cn("flex w-full items-center gap-3 px-2 py-1.5 text-start", OPENS)}
          >
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-sm text-foreground">
                {KIN_BILLS.batchTitle(batch.addedAt, now)}
              </span>
              <span className="truncate text-xs text-muted-foreground">
                {kinBillBatchSentence(batch.states, batch.bills)}
              </span>
            </span>
            <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function KinBillBatchReview(
  props: KinWorkTarget & {
    readonly batchId: string;
    readonly onOpenKey: (key: KinRecordKey) => void;
  },
) {
  const { environmentId } = props;
  const { state, rows, batch, refresh } = useKinBillBatch(props, props.batchId);
  const actions = useKinBillActions(props, props.batchId, refresh);
  const lists = useKinLists(props, { enabled: true });
  const expenses = kinListsOf(lists).find((one) => one.list === "expenses") ?? null;
  const home = useKinHomeCurrency(props) ?? KIN_DEFAULT_HOME_CURRENCY;
  const now = new Date(useNowMinuteMs());
  const [byHand, setByHand] = useState<KinBillRow | null>(null);
  const skipped = actions.kept?.skipped;
  const views = rows.map((row) =>
    kinBillRowView(row, {
      categoryLabel: (category) => kinCategoryLabel(category, expenses),
      ...(skipped === undefined ? {} : { skipped }),
    }),
  );
  const urls = useAssetUrls(
    environmentId,
    views.map((view) => ({
      _tag: "attachment" as const,
      attachmentId: view.file.attachmentId,
      fileName: view.file.name,
      mimeType: view.file.mimeType,
    })),
  );
  if (state._tag === "refused") return <KinWorkNotice {...KIN_BILLS.onlyOwner} />;
  if (state._tag === "gone") return <KinWorkNotice {...KIN_BILLS.gone} />;
  if (state._tag === "loading") return <Loading />;
  if (state._tag === "failed")
    return <KinLoadFailed what={KIN_BILLS.loadFailed} cause={state.cause} onRetry={refresh} />;
  const counts = batch?.states ?? kinBillCounts(rows);
  const canKeepAll = actions.allowed && kinBillsCanKeepAll(counts);
  const run = (view: KinBillRowView, action: KinBillAction) => {
    switch (action) {
      case "keep":
      case "drop":
      case "addAnyway":
      case "dismiss":
      case "readAgain":
        return void actions.act(view, action);
      case "edit":
      case "openExpense":
        return view.expense === null ? undefined : props.onOpenKey(view.expense.key);
      case "openDuplicate":
        return view.duplicateOf === null ? undefined : props.onOpenKey(view.duplicateOf);
      case "byHand":
        return setByHand(view.row);
    }
  };
  return (
    <>
      <section className="flex flex-col gap-2">
        <h2 className="text-base font-medium text-foreground">
          {batch === null ? KIN_BILLS.added : KIN_BILLS.batchTitle(batch.addedAt, now)}
        </h2>
        <p className="text-sm text-muted-foreground">
          {kinBillBatchSentence(counts, batch?.bills ?? rows.length)}
        </p>
        {actions.allowed ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button
              size="sm"
              variant="outline"
              disabled={!canKeepAll || actions.busy !== null}
              aria-busy={actions.busy === "all"}
              onClick={() => void actions.keepAll()}
            >
              {KIN_BILLS.keepAll}
            </Button>
            {actions.kept === null ? null : (
              <p role="status" className="text-sm text-foreground">
                {actions.kept.said}
              </p>
            )}
          </div>
        ) : null}
        {actions.problem?.key === "all" ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {actions.problem.text}
          </p>
        ) : null}
      </section>
      {views.length === 0 ? <KinWorkNotice {...KIN_BILLS.allDismissed} /> : null}
      <ul aria-label={KIN_BILLS.added} className="flex flex-col divide-y divide-border">
        {views.map((view, index) => (
          <BillRow
            key={view.key}
            view={view}
            src={urls[index] ?? null}
            previewKey={`kin-bills:${props.batchId}`}
            canChange={actions.allowed}
            busy={actions.busy !== null}
            problem={actions.problem?.key === view.key ? actions.problem.text : null}
            onAction={run}
          />
        ))}
      </ul>
      {byHand === null ? null : (
        <KinNewExpenseDialog
          {...props}
          start={{
            draft: kinBillExpenseStart(byHand, home, expenses?.categories ?? []),
            receipt: byHand.file,
          }}
          onClose={() => setByHand(null)}
        />
      )}
    </>
  );
}

const TONE: Record<KinBillTone, string> = {
  muted: "text-muted-foreground",
  active: "text-foreground",
  attention: "text-warning-foreground",
  done: "text-success-foreground",
};

const CHANGES: ReadonlySet<KinBillAction> = new Set([
  "keep",
  "drop",
  "addAnyway",
  "dismiss",
  "byHand",
  "readAgain",
  "edit",
]);

const LABEL = (view: KinBillRowView, action: KinBillAction) => {
  switch (action) {
    case "openDuplicate":
      return KIN_BILLS.open(view.duplicateOf ?? "");
    case "openExpense":
      return KIN_BILLS.open(view.expense?.key ?? "");
    default:
      return KIN_BILLS.action[action];
  }
};

/** One bill: its file, what was read in fixed places, its state and its taps. */
const BillRow = memo(function BillRow(props: {
  readonly view: KinBillRowView;
  readonly src: string | null;
  readonly previewKey: string;
  readonly canChange: boolean;
  readonly busy: boolean;
  readonly problem: string | null;
  readonly onAction: (view: KinBillRowView, action: KinBillAction) => void;
}) {
  const { view, src } = props;
  const { file } = view;
  const actions = view.actions.filter((action) => props.canChange || !CHANGES.has(action));
  const note = view.problem ?? view.skipped;
  return (
    <li aria-label={view.accessibilityLabel} className="flex gap-3 py-3">
      {view.pdf ? (
        <a
          {...(src === null ? {} : { href: src, download: file.name })}
          aria-label={`Open ${file.name}`}
          aria-disabled={src === null}
          className={cn(
            "flex size-16 shrink-0 flex-col items-center justify-center gap-1 border border-border/80 px-1 text-muted-foreground",
            OPENS,
          )}
        >
          <FileIcon aria-hidden className="size-5" />
          <span className="w-full truncate text-center text-3xs">{file.name}</span>
        </a>
      ) : src === null ? (
        <span className="block size-16 shrink-0 rounded-lg border border-border/80 bg-muted" />
      ) : (
        <button
          type="button"
          aria-label={`Open ${file.name}`}
          onClick={() =>
            openExpandedImagePreview(props.previewKey, {
              images: [{ src, name: file.name, mimeType: file.mimeType }],
              index: 0,
            })
          }
          className="block size-16 shrink-0 cursor-zoom-in overflow-hidden rounded-lg border border-border/80 outline-none ring-ring focus-visible:ring-2 focus-visible:ring-inset"
        >
          <AttachmentImage
            name={file.name}
            mimeType={file.mimeType}
            src={src}
            alt={file.name}
            loading="lazy"
            decoding="async"
            className="block size-full object-cover"
          />
        </button>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className={cn("text-sm font-medium", TONE[view.tone])}>{view.label}</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {view.fields.map((field) => (
            <div key={field.key} className="contents">
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="min-h-4 truncate text-foreground">{field.value}</dd>
            </div>
          ))}
        </dl>
        <p className="min-h-4 text-xs text-muted-foreground">{note}</p>
        {props.problem === null ? null : (
          <p role="alert" className="text-xs text-destructive-foreground">
            {props.problem}
          </p>
        )}
        <div className="flex min-h-7 flex-wrap items-center gap-1">
          {actions.map((action) => (
            <Button
              key={action}
              size="xs"
              variant={action === "keep" || action === "addAnyway" ? "outline" : "ghost"}
              disabled={props.busy && CHANGES.has(action)}
              aria-label={`${LABEL(view, action)}: ${file.name}`}
              onClick={() => props.onAction(view, action)}
            >
              {LABEL(view, action)}
            </Button>
          ))}
        </div>
      </div>
    </li>
  );
});
