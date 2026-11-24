// @effect-diagnostics globalDate:off - Pure view helpers format host ISO times for React render, outside an Effect runtime.
import {
  KIN_BILL_BATCH_CARD,
  KinBillBatchCard,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  kinWhenFormat,
  parseKinMoney,
  type KinAttachment,
  type KinBillBatchSummary,
  type KinBillRead,
  type KinBillRow,
  type KinBillState,
  type KinBillsAddResult,
  type KinBillsKeepReadResult,
  type KinFileRef,
  type KinOrgId,
  type KinRecordKey,
  type KinWidget,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { kinMoneyText } from "./kinLists.ts";

/**
 * Bills added in bulk, as both apps show them: the words, what each bill offers by its state, the
 * files an add takes, and the upload-then-add steps. The host reads, records and decides; this
 * only says it.
 */

export const KIN_BILLS = {
  add: "Bills (photos or PDFs)",
  addDetail: "Kin reads each one",
  title: "Add bills",
  hint: "Each bill Kin reads becomes a suggested expense with its file. Nothing counts in Money until you keep it.",
  drop: "Drop photos or PDFs of bills here, or",
  choose: "choose them",
  /** The file picker's own name, and the list of what was chosen. */
  pick: "Photos or PDFs of bills",
  chosen: "Chosen bills",
  photoLibrary: "Photo library",
  files: "Files",
  takePhoto: "Take photo",
  cameraRefused: "Kin can't use the camera. Allow it in Settings to take a photo of a bill.",
  addN: (count: number) => (count === 1 ? "Add 1 bill" : `Add ${count} bills`),
  remove: "Remove",
  uploading: (done: number, total: number) => `Uploading ${done} of ${total}`,
  adding: "Adding…",
  notABill: "Only photos and PDFs are read as bills.",
  tooMany: `Up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} bills at a time.`,
  uploadFailed: "Couldn't upload this one.",
  noneUploaded: "None of them uploaded: what went wrong is beside each one.",
  upload: {
    waiting: "Ready",
    uploading: "Uploading…",
    uploaded: "Uploaded",
    added: "Added",
  },
  review: "Review",
  /** On Expenses: where bills added in bulk are, once there are any. */
  added: "Bills added",
  batchTitle: (addedAt: string, now: Date) => `Bills added on ${kinBillDay(addedAt, now)}`,
  newest: (addedAt: string, now: Date) => `Newest on ${kinBillDay(addedAt, now)}`,
  state: {
    reading: "Reading…",
    read: "Read",
    kept: "Kept",
    dropped: "Dropped",
    unreadable: "Couldn't read this one",
    duplicate: (key: string, title: string) => `Looks like ${key} ${title}`.trim(),
  } as const,
  field: {
    vendor: "Who was paid",
    date: "Date",
    amount: "Amount",
    tax: "Tax",
    category: "Category",
    number: "Bill number",
  },
  action: {
    keep: "Keep",
    edit: "Edit",
    drop: "Drop",
    addAnyway: "Add anyway",
    dismiss: "Dismiss",
    byHand: "Enter by hand",
    readAgain: "Read again",
  },
  open: (key: string) => `Open ${key}`,
  keepAll: "Keep all that read cleanly",
  loadFailed: "Couldn't load these bills",
  none: {
    title: "No bills added yet",
    detail: "Add photos or PDFs of bills from Money's Add, and Kin reads each one.",
  },
  gone: {
    title: "These bills aren't here any more",
    detail: "Open Money to see the bills added since.",
  },
  onlyOwner: {
    title: "Bills are for the owners",
    detail: "Only the owner or a co-owner adds and keeps bills.",
  },
  more: "Show more",
} as const;

const dayOfYear = kinWhenFormat("dateYear", { zone: "UTC" });
const dayInYear = kinWhenFormat("date");
const dayWithYear = kinWhenFormat("dateYear");

/** "24 Nov" this year, "24 Nov 2025" before it, in the reader's own zone. */
function kinBillDay(iso: string, now: Date) {
  const when = new Date(iso);
  return when.getFullYear() === now.getFullYear()
    ? dayInYear.format(when)
    : dayWithYear.format(when);
}

// What an add takes

const extensionOf = (name: string) => name.split(".").at(-1)?.toLowerCase() ?? "";

/** Null for a photo or a PDF, which Kin reads as bills; else why not, before anything uploads. */
export function kinBillFileRefusal(file: {
  readonly name: string;
  readonly mimeType: string;
}): string | null {
  const mime = file.mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
  if (mime.startsWith("image/") || mime === "application/pdf") return null;
  // A picker can leave the type blank; the name still says what the file is.
  if (mime === "" || mime === "application/octet-stream")
    return ["pdf", "jpg", "jpeg", "png", "gif", "webp", "heic", "heif"].includes(
      extensionOf(file.name),
    )
      ? null
      : KIN_BILLS.notABill;
  return KIN_BILLS.notABill;
}

export const kinBillIsPdf = (file: { readonly name: string; readonly mimeType: string }) =>
  file.mimeType.toLowerCase().startsWith("application/pdf") || extensionOf(file.name) === "pdf";

// One bill on the review list

export type KinBillAction =
  | "keep"
  | "edit"
  | "drop"
  | "addAnyway"
  | "dismiss"
  | "openDuplicate"
  | "byHand"
  | "readAgain"
  | "openExpense";

export type KinBillTone = "muted" | "active" | "attention" | "done";

export interface KinBillField {
  readonly key: keyof typeof KIN_BILLS.field;
  readonly label: string;
  /** Null for a blank the reader left: shown empty, never filled in. */
  readonly value: string | null;
}

export interface KinBillRowView {
  readonly key: string;
  readonly row: KinBillRow;
  readonly file: KinFileRef;
  readonly pdf: boolean;
  readonly label: string;
  readonly tone: KinBillTone;
  readonly fields: ReadonlyArray<KinBillField>;
  readonly problem: string | null;
  readonly actions: ReadonlyArray<KinBillAction>;
  /** The expense made for it, which Keep, Edit, Drop and its link act on. */
  readonly expense: { readonly key: KinRecordKey; readonly rev: number } | null;
  readonly duplicateOf: KinRecordKey | null;
  /** Why "Keep all" left it, in the host's words, until the list reads again. */
  readonly skipped: string | null;
  readonly accessibilityLabel: string;
}

const TONE: Record<KinBillState, KinBillTone> = {
  reading: "muted",
  read: "active",
  kept: "done",
  dropped: "muted",
  duplicate: "attention",
  unreadable: "attention",
};

/** A printed amount in its own currency, never converted; as printed when it won't read as one. */
export function kinBillAmountText(amount: string | undefined, currency: string | undefined) {
  if (amount === undefined || amount.trim() === "") return null;
  if (currency === undefined) return amount.trim();
  const read = parseKinMoney(amount, currency);
  return "money" in read && read.money.currency === currency
    ? kinMoneyText(read.money, true)
    : `${amount.trim()} ${currency}`;
}

const blank = (value: string | undefined) =>
  value === undefined || value.trim() === "" ? null : value.trim();

/** What the reader read off the bill, every field in its place, a blank left empty. */
export function kinBillFields(
  read: KinBillRead,
  categoryLabel: (category: string) => string = (category) => category,
): ReadonlyArray<KinBillField> {
  const category = blank(read.category);
  const day = blank(read.date);
  return [
    { key: "vendor", label: KIN_BILLS.field.vendor, value: blank(read.vendor) },
    {
      key: "date",
      label: KIN_BILLS.field.date,
      value: day === null ? null : dayOfYear.format(new Date(`${day}T00:00:00Z`)),
    },
    {
      key: "amount",
      label: KIN_BILLS.field.amount,
      value: kinBillAmountText(read.amount, read.currency),
    },
    { key: "tax", label: KIN_BILLS.field.tax, value: kinBillAmountText(read.tax, read.currency) },
    {
      key: "category",
      label: KIN_BILLS.field.category,
      value: category === null ? null : categoryLabel(category),
    },
    { key: "number", label: KIN_BILLS.field.number, value: blank(read.number) },
  ];
}

function actionsOf(row: KinBillRow): ReadonlyArray<KinBillAction> {
  switch (row.state) {
    case "read":
      return row.expense === undefined ? [] : ["keep", "edit", "drop"];
    case "duplicate":
      return row.duplicateOf === undefined
        ? ["addAnyway", "dismiss"]
        : ["addAnyway", "dismiss", "openDuplicate"];
    case "unreadable":
      return ["byHand", "readAgain", "dismiss"];
    case "kept":
    case "dropped":
      return row.expense === undefined ? [] : ["openExpense"];
    case "reading":
      return [];
  }
}

export function kinBillStateLabel(row: KinBillRow) {
  return row.state === "duplicate"
    ? KIN_BILLS.state.duplicate(row.duplicateOf?.key ?? "", row.duplicateOf?.title ?? "")
    : KIN_BILLS.state[row.state];
}

export function kinBillRowView(
  row: KinBillRow,
  options: {
    readonly categoryLabel?: (category: string) => string;
    readonly skipped?: ReadonlyMap<string, string>;
  } = {},
): KinBillRowView {
  const label = kinBillStateLabel(row);
  const fields = kinBillFields(row.read, options.categoryLabel);
  const problem = row.state === "unreadable" ? (row.problem ?? null) : null;
  const read = fields.flatMap((field) =>
    field.value === null ? [] : [`${field.label} ${field.value}`],
  );
  return {
    key: row.sha256,
    row,
    file: row.file,
    pdf: kinBillIsPdf(row.file),
    label,
    tone: TONE[row.state],
    fields,
    problem,
    actions: actionsOf(row),
    expense: row.expense === undefined ? null : { key: row.expense.key, rev: row.expense.rev },
    duplicateOf: row.duplicateOf?.key ?? null,
    skipped: options.skipped?.get(row.sha256) ?? null,
    accessibilityLabel: [
      row.file.name,
      label,
      ...read,
      ...(problem === null ? [] : [problem]),
    ].join(". "),
  };
}

// A batch: its counts, its sentence, and the way to it from Expenses

export type KinBillCounts = KinBillBatchSummary["states"];

export const kinBillCounts = (rows: ReadonlyArray<Pick<KinBillRow, "state">>): KinBillCounts => {
  const count = (state: KinBillState) => rows.filter((row) => row.state === state).length;
  return {
    reading: count("reading"),
    read: count("read"),
    kept: count("kept"),
    dropped: count("dropped"),
    duplicate: count("duplicate"),
    unreadable: count("unreadable"),
  };
};

/** "12 bills: 5 to keep, 1 looks like a duplicate, 3 kept." The host writes no line for this. */
export function kinBillBatchSentence(counts: KinBillCounts, bills: number) {
  const parts = [
    counts.read === 0 ? null : `${counts.read} to keep`,
    counts.duplicate === 0
      ? null
      : `${counts.duplicate} ${counts.duplicate === 1 ? "looks like a duplicate" : "look like duplicates"}`,
    counts.unreadable === 0 ? null : `${counts.unreadable} couldn't be read`,
    counts.reading === 0 ? null : `${counts.reading} being read`,
    counts.kept === 0 ? null : `${counts.kept} kept`,
    counts.dropped === 0 ? null : `${counts.dropped} dropped`,
  ].filter((part) => part !== null);
  const total = bills === 1 ? "1 bill" : `${bills} bills`;
  return parts.length === 0 ? `${total}.` : `${total}: ${parts.join(", ")}.`;
}

/** Keep all is offered while at least one bill was read cleanly and is still a suggestion. */
export const kinBillsCanKeepAll = (counts: KinBillCounts) => counts.read > 0;

/**
 * Expenses' quiet way to bills added in bulk: none before the first batch; one batch opens
 * straight; several open their list, newest first.
 */
export function kinBillsEntry(batches: ReadonlyArray<KinBillBatchSummary>, now: Date) {
  const [newest] = batches;
  if (newest === undefined) return null;
  if (batches.length === 1)
    return {
      batchId: newest.batchId,
      label: KIN_BILLS.batchTitle(newest.addedAt, now),
      detail: kinBillBatchSentence(newest.states, newest.bills),
    };
  const toKeep = batches.reduce((sum, batch) => sum + batch.states.read, 0);
  return {
    batchId: null,
    label: KIN_BILLS.added,
    detail: [KIN_BILLS.newest(newest.addedAt, now), toKeep === 0 ? null : `${toKeep} to keep`]
      .filter((part) => part !== null)
      .join(" · "),
  };
}

/** After Keep all: how many were kept, and each skipped bill's reason by its file. */
export function kinBillsKeptAll(result: KinBillsKeepReadResult) {
  const kept = result.kept.length;
  const skipped = result.skipped.length;
  const said =
    kept === 0 ? "None were kept." : kept === 1 ? "Kept 1 expense." : `Kept ${kept} expenses.`;
  return {
    said:
      skipped === 0
        ? said
        : `${said} ${skipped === 1 ? "1 wasn't" : `${skipped} weren't`}: why is on each.`,
    skipped: new Map(result.skipped.map((one) => [one.sha256, one.why])),
  };
}

// The card in chat

export interface KinBillBatchCardView {
  readonly orgId: KinOrgId;
  readonly batchId: string;
  /** The host's own sentence, the same an older app shows. */
  readonly text: string;
  readonly reading: boolean;
  /** "12 of 50" while Kin reads; null once done. */
  readonly progress: string | null;
}

const decodeCard = Schema.decodeUnknownOption(KinBillBatchCard);

export function kinBillBatchCardView(widget: KinWidget): KinBillBatchCardView | null {
  if (widget.type !== KIN_BILL_BATCH_CARD) return null;
  const card = decodeCard(widget.state);
  if (Option.isNone(card)) return null;
  const { text, status, done, total, batchId } = card.value;
  return {
    orgId: widget.orgId,
    batchId,
    text,
    reading: status === "reading",
    progress: status === "reading" ? `${Math.min(done, total)} of ${total}` : null,
  };
}

// Adding: choose, upload each, then one add

export type KinBillUpload =
  | { readonly _tag: "waiting" }
  | { readonly _tag: "uploading" }
  | { readonly _tag: "uploaded"; readonly attachment: KinAttachment }
  | { readonly _tag: "failed"; readonly problem: string }
  /** Sent in an add the host answered. */
  | { readonly _tag: "added" }
  /** Not a photo or a PDF: never uploaded. */
  | { readonly _tag: "refused"; readonly reason: string };

export interface KinBillDraft<F> {
  readonly id: string;
  readonly name: string;
  readonly source: F;
  readonly upload: KinBillUpload;
}

export interface KinBillsAdding<F> {
  readonly files: ReadonlyArray<KinBillDraft<F>>;
  readonly phase: "choosing" | "uploading" | "adding";
  /** The add last sent: a retry of the same files sends the same `clientRequestId`. */
  readonly attempt: { readonly requestId: string; readonly sent: string } | null;
  readonly result: KinBillsAddResult | null;
  readonly problem: string | null;
}

export type KinBillsEvent<F> =
  | {
      readonly _tag: "chose";
      readonly files: ReadonlyArray<{
        readonly id: string;
        readonly name: string;
        readonly mimeType: string;
        readonly source: F;
      }>;
    }
  | { readonly _tag: "removed"; readonly id: string }
  | { readonly _tag: "started" }
  | { readonly _tag: "uploaded"; readonly id: string; readonly attachment: KinAttachment }
  | { readonly _tag: "uploadFailed"; readonly id: string; readonly problem: string }
  | { readonly _tag: "adding"; readonly freshId: string }
  | { readonly _tag: "added"; readonly result: KinBillsAddResult }
  | { readonly _tag: "addFailed"; readonly problem: string };

export const kinBillsAddingStart = <F>(): KinBillsAdding<F> => ({
  files: [],
  phase: "choosing",
  attempt: null,
  result: null,
  problem: null,
});

const live = (upload: KinBillUpload) => upload._tag !== "added" && upload._tag !== "refused";
const sentKey = (attachments: ReadonlyArray<KinAttachment>) =>
  attachments.map((attachment) => attachment.id).join(",");

export const kinBillsToUpload = <F>(state: KinBillsAdding<F>) =>
  state.files.filter((file) => file.upload._tag === "waiting" || file.upload._tag === "failed");

export const kinBillsUploaded = <F>(state: KinBillsAdding<F>): ReadonlyArray<KinAttachment> =>
  state.files.flatMap((file) => (file.upload._tag === "uploaded" ? [file.upload.attachment] : []));

export function kinBillsStep<F>(state: KinBillsAdding<F>, event: KinBillsEvent<F>) {
  const set = (id: string, upload: KinBillUpload): KinBillsAdding<F> => ({
    ...state,
    files: state.files.map((file) => (file.id === id ? { ...file, upload } : file)),
  });
  switch (event._tag) {
    case "chose": {
      let room =
        PROVIDER_SEND_TURN_MAX_ATTACHMENTS - state.files.filter((f) => live(f.upload)).length;
      const added = event.files.map((file): KinBillDraft<F> => {
        const refusal = kinBillFileRefusal(file) ?? (room <= 0 ? KIN_BILLS.tooMany : null);
        if (refusal === null) room -= 1;
        return {
          id: file.id,
          name: file.name,
          source: file.source,
          upload: refusal === null ? { _tag: "waiting" } : { _tag: "refused", reason: refusal },
        };
      });
      return { ...state, files: [...state.files, ...added], problem: null };
    }
    case "removed":
      return { ...state, files: state.files.filter((file) => file.id !== event.id) };
    case "started":
      return {
        ...state,
        phase: "uploading" as const,
        problem: null,
        result: null,
        files: state.files.map((file) =>
          file.upload._tag === "waiting" || file.upload._tag === "failed"
            ? { ...file, upload: { _tag: "uploading" as const } }
            : file,
        ),
      };
    case "uploaded":
      return set(event.id, { _tag: "uploaded", attachment: event.attachment });
    case "uploadFailed":
      return set(event.id, { _tag: "failed", problem: event.problem });
    case "adding": {
      const sent = sentKey(kinBillsUploaded(state));
      // The same files again are the same request: the host answers it once.
      const requestId =
        state.attempt !== null && state.attempt.sent === sent
          ? state.attempt.requestId
          : event.freshId;
      return { ...state, phase: "adding" as const, attempt: { requestId, sent } };
    }
    case "added":
      return {
        ...state,
        phase: "choosing" as const,
        attempt: null,
        result: event.result,
        problem: null,
        files: state.files.map((file) =>
          file.upload._tag === "uploaded" ? { ...file, upload: { _tag: "added" as const } } : file,
        ),
      };
    case "addFailed":
      return { ...state, phase: "choosing" as const, problem: event.problem };
  }
}

/** The one button: how many of the chosen files an add would take now. */
export function kinBillsButton<F>(state: KinBillsAdding<F>) {
  const count = state.files.filter((file) => live(file.upload)).length;
  return {
    count,
    label:
      state.phase === "adding"
        ? KIN_BILLS.adding
        : state.phase === "uploading"
          ? KIN_BILLS.uploading(
              state.files.filter((file) => file.upload._tag === "uploaded").length,
              count,
            )
          : KIN_BILLS.addN(count),
    disabled: count === 0 || state.phase !== "choosing",
  };
}

export function kinBillUploadText(upload: KinBillUpload) {
  switch (upload._tag) {
    case "failed":
      return upload.problem;
    case "refused":
      return upload.reason;
    default:
      return KIN_BILLS.upload[upload._tag];
  }
}

/**
 * What the last add came to. It closes onto the batch's list only when every file went in as a
 * new bill; else it stays to say what didn't, with the list one tap away.
 */
export function kinBillsOutcome<F>(state: KinBillsAdding<F>) {
  const { result } = state;
  if (result === null) return null;
  const failed = state.files.some((file) => file.upload._tag === "failed");
  const lines = [
    result.already.length === 0
      ? null
      : `Already added before: ${result.already.map((one) => one.name).join(", ")}.`,
    ...result.refused.map((one) => `${one.name}: ${one.reason}`),
  ].filter((line) => line !== null);
  const review = result.added.length === 0 ? null : result.batchId;
  return {
    review,
    close: review !== null && lines.length === 0 && !failed,
    lines,
  };
}

/**
 * Uploads every file still to go, a few at a time, then sends the one add. A file that fails
 * stays failed while the rest go on; the add takes the ones that uploaded.
 */
export async function kinBillsSend<F>(input: {
  readonly state: () => KinBillsAdding<F>;
  readonly dispatch: (event: KinBillsEvent<F>) => void;
  readonly upload: (source: F, name: string) => Promise<KinAttachment>;
  readonly add: (
    attachments: ReadonlyArray<KinAttachment>,
    clientRequestId: string,
  ) => Promise<
    | { readonly ok: true; readonly value: KinBillsAddResult }
    | { readonly ok: false; readonly problem: string }
  >;
  readonly newId: () => string;
  readonly at?: number;
}): Promise<KinBillsAddResult | null> {
  const queue = [...kinBillsToUpload(input.state())];
  input.dispatch({ _tag: "started" });
  const next = async (): Promise<void> => {
    const file = queue.shift();
    if (file === undefined) return;
    try {
      const attachment = await input.upload(file.source, file.name);
      input.dispatch({ _tag: "uploaded", id: file.id, attachment });
    } catch (cause) {
      const said = cause instanceof Error ? cause.message.trim() : "";
      input.dispatch({
        _tag: "uploadFailed",
        id: file.id,
        problem: said === "" ? KIN_BILLS.uploadFailed : said,
      });
    }
    return next();
  };
  await Promise.all(Array.from({ length: Math.max(1, input.at ?? 3) }, next));
  const attachments = kinBillsUploaded(input.state());
  if (attachments.length === 0) {
    input.dispatch({ _tag: "addFailed", problem: KIN_BILLS.noneUploaded });
    return null;
  }
  input.dispatch({ _tag: "adding", freshId: input.newId() });
  const { attempt } = input.state();
  const sent = await input.add(attachments, attempt?.requestId ?? input.newId());
  if (!sent.ok) {
    input.dispatch({ _tag: "addFailed", problem: sent.problem });
    return null;
  }
  input.dispatch({ _tag: "added", result: sent.value });
  return sent.value;
}

/**
 * "Enter by hand" on a bill Kin couldn't read: the new-expense form with the bill's file as its
 * receipt and what was read in its fields. An amount goes in only in the company's own currency,
 * which the form takes it in; a category only when it is one of the list's.
 */
export function kinBillExpenseStart(
  row: Pick<KinBillRow, "read" | "file">,
  home: string,
  categories: ReadonlyArray<string>,
) {
  const { read } = row;
  const category = categories.find(
    (one) => one.toLowerCase() === read.category?.trim().toLowerCase(),
  );
  const amount = blank(read.amount);
  return {
    receipt: row.file.attachmentId,
    ...(blank(read.vendor) === null ? {} : { vendor: blank(read.vendor) ?? "" }),
    ...(blank(read.date) === null ? {} : { paidOn: blank(read.date) ?? "" }),
    ...(amount !== null && read.currency === home ? { amount } : {}),
    ...(category === undefined ? {} : { category }),
  };
}
