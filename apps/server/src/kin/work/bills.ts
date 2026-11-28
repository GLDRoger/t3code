// @effect-diagnostics nodeBuiltinImport:off -- a file's sha256 over bytes already read; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import {
  type ChatAttachment,
  KIN_BILL_BATCH_CARD,
  KIN_BILLS_PER_TURN,
  KIN_CURRENCY_CODES,
  KinAgentId,
  type KinAttachment,
  KinBillBatchCard,
  KinBillRead,
  type KinBillRow,
  type KinRecordState,
  type KinBillsAddAnywayInput,
  KinBillsAddAnywayResult,
  KinBillsAddResult,
  type KinBillsDismissInput,
  KinBillsKeepReadChanged,
  type KinBillsKeepReadInput,
  KinBillsKeepReadResult,
  type KinBillsListInput,
  type KinBillsReadAgainInput,
  type KinBillState,
  KinChatError,
  KinChatId,
  type KinEvent,
  KinMessageId,
  type KinOrgId,
  KinPersonId,
  KinSignedMoney,
  KinWidgetId,
  type KinWakeupId,
  formatKinMoney,
  formatKinWhen,
  isKinCurrency,
  KIN_TEXT_LOCALE,
  parseKinMoney,
} from "@t3tools/contracts";
import {
  BILL_PHOTO_MAX_PIXELS,
  IMAGE_DIMENSIONS_HEADER_BYTES,
  readImageDimensions,
} from "@t3tools/shared/imageDimensions";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { PendingUploadOwner } from "../../assets/AttachmentUpload.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import { KinAttachmentStore } from "../chat/KinAttachmentStore.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import { KinRefreshObserver } from "../chat/KinRefreshHub.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { billsOnly } from "../lead/billsOnly.ts";
import { hashedEventId } from "../lead/eventIds.ts";
import { KinEventQueue } from "../lead/KinEventQueue.ts";
import { shownAsPicture } from "../lead/turn/content.ts";
import { PDF_PAGE_IMAGES } from "../lead/turn/pdfPageImages.ts";
import { ownerLevelSql } from "../people/KinAccess.ts";
import { directChatWith } from "../triggers/deferralOrigin.ts";
import { cutBillPage } from "./billCutter.ts";
import { billPhotoForModel, isBillPdf as isPdf } from "./billPhotoForModel.ts";
import { MAX_BILL_BOXES, refuseBillPage, type BillBox } from "./billCutterProtocol.ts";
import { countryFirst, homeCurrency } from "./companyProfile.ts";
import { billReader } from "./billReader.ts";
import { KinRecords, type Writer } from "./KinRecords.ts";
import { currencyDigits, dayIn, farAbove, largestIn } from "./money.ts";
import { fold } from "./nameMatch.ts";
import { confirm, theOwner } from "./ownerWork.ts";
import { endOfDay, ownerZone, workFailure } from "./recordRows.ts";
import { listDef, presetList } from "./registers.ts";
import { notAVendor } from "./vendorName.ts";

/**
 * Bills in bulk. Kin keeps one row per file's bytes from the moment it is added; the reading
 * agent reads each once in quiet turns Kin queues (`bills.read`), and everything after a read is
 * this file's: the duplicate check, one suggested expense per bill read cleanly, the card.
 */

/** Kin queues a bill on its own at most this often; the owner's Read again is beside it. */
const AUTO_READS = 2;
const UNCLEAR_CURRENCY = "Couldn't read: currency.";
const COULD_NOT_READ = "Kin could not read this one";
const UNSHOWN_PHOTO = "Kin can't read this kind of photo: add it as a JPEG or PNG.";
/** A clean read whose amount or date is the owner's to check: reading it again reads the same. */
const CHECK_IT = {
  farAbove: "The amount is far above the rest of Expenses: check it.",
  ahead: "The date is after today: check it.",
  old: "The date is more than ten years back: check it.",
} as const;
const READ_CLEAN: ReadonlyMap<string, "amount" | "date"> = new Map([
  [CHECK_IT.farAbove, "amount"],
  [CHECK_IT.ahead, "date"],
  [CHECK_IT.old, "date"],
]);
const checkOf = (problem: string | null) => {
  const check = READ_CLEAN.get(problem ?? "");
  return check === undefined ? {} : { readClean: true, check };
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const notFound = new KinChatError({ reason: "not_found", message: "No such bill." });
const retryConflict = new KinChatError({
  reason: "not_allowed",
  message: "This request was already made with something else.",
});

const sha256 = (bytes: Uint8Array | string) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const billWidgetId = (batchId: string) => KinWidgetId.make(`bills:${batchId}`);
const batchIdFor = (key: string) => `b-${sha256(key).slice(0, 24)}`;

const mimeOf = (file: Pick<ChatAttachment, "mimeType">) =>
  file.mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
const isText = (file: Pick<ChatAttachment, "mimeType">) => mimeOf(file) === "text/plain";
/** A bill is a photo or a PDF; anything else is refused on its own. */
const isBillFile = (file: Pick<ChatAttachment, "type" | "mimeType" | "name">) =>
  file.type === "image" || mimeOf(file).startsWith("image/") || isPdf(file);
const NOT_A_BILL = "Only photos and PDFs are read as bills.";
/** A file's name as an add answers it: a chat file's may be longer than the answer carries. */
const answerName = (name: string) => name.slice(0, 200);

/**
 * `bill_read`'s figures are plain numbers, a dot for decimals, with no more decimals than the
 * currency has: "1.200" in euros reads two ways, so it is not read.
 */
const PLAIN_NUMBER = /^-?\d+(?:\.(\d+))?$/u;
const plainNumber = (figure: string | undefined, currency: string | undefined) => {
  const found = figure === undefined ? null : PLAIN_NUMBER.exec(figure.trim());
  if (found === null) return undefined;
  if (
    currency !== undefined &&
    isKinCurrency(currency) &&
    (found[1]?.length ?? 0) > currencyDigits(currency)
  )
    return undefined;
  return found[0];
};

const ReadJson = Schema.fromJsonString(
  Schema.Struct({
    vendor: Schema.optional(Schema.String),
    date: Schema.optional(Schema.String),
    amount: Schema.optional(Schema.String),
    currency: Schema.optional(Schema.String),
    currencyMark: KinBillRead.fields.currencyMark,
    currencyAssumed: Schema.optional(Schema.Literal(true)),
    tax: Schema.optional(Schema.String),
    category: Schema.optional(Schema.String),
    number: Schema.optional(Schema.String),
  }),
);
const encodeRead = Schema.encodeEffect(ReadJson);
const decodeRead = Schema.decodeUnknownOption(ReadJson);
// A cut source is terminal, with a list of pages cut instead of a bill_read object.
const CutPages = Schema.fromJsonString(Schema.Array(Schema.Int));
const decodeCutPages = Schema.decodeUnknownOption(CutPages);
const encodeCutPages = Schema.encodeEffect(CutPages);
const NOT_CUT = "json_type(read_json) IS NOT 'array'";
const SourceSlot = Schema.Struct({ id: Schema.String, photo: Schema.Boolean });
type SourceSlot = typeof SourceSlot.Type;
// Keep the original file order even when a cut inserts rows or a duplicate leaves no row.
const StoredCard = Schema.Struct({
  ...KinBillBatchCard.fields,
  sourceSlots: Schema.optional(Schema.Array(SourceSlot)),
});
type StoredCard = typeof StoredCard.Type;
const CardJson = Schema.decodeUnknownOption(StoredCard);
const sameCard = Schema.toEquivalence(StoredCard);
const Stored = Schema.fromJsonString(Schema.Unknown);
const decodeStored = Schema.decodeEffect(Stored);
const encodeStored = Schema.encodeEffect(Stored);
const decodeAdded = Schema.decodeUnknownEffect(KinBillsAddResult);
const decodeKept = Schema.decodeUnknownEffect(KinBillsKeepReadResult);
const decodeAnyway = Schema.decodeUnknownEffect(KinBillsAddAnywayResult);

type Row = {
  readonly sha256: string;
  readonly attachmentId: string;
  readonly previewId: string | null;
  readonly chatId: string;
  readonly messageId: string;
  readonly name: string;
  readonly fileType: "image" | "file";
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly batchId: string;
  readonly position: number;
  readonly agentId: string;
  readonly cardChatId: string;
  readonly widgetId: string;
  readonly addedBy: string;
  readonly addedAt: number;
  readonly state: "waiting" | "reading" | "read" | "duplicate" | "unreadable";
  readonly eventId: string | null;
  readonly reads: number;
  readonly readJson: string | null;
  readonly problem: string | null;
  readonly duplicateOf: string | null;
  readonly recordId: string | null;
  readonly dismissedAt: number | null;
  readonly parentSha256: string | null;
  readonly cutPage: number | null;
  readonly cut: number;
  readonly mailFrom: string | null;
  readonly mailAt: number | null;
};
// A crop keeps its source's provenance through the two supported cuts.
const mailColumn = (column: "mail_from" | "mail_at") =>
  `COALESCE(b.${column}, (SELECT COALESCE(parent.${column}, original.${column})
    FROM kin_bill_reads parent LEFT JOIN kin_bill_reads original
      ON original.org_id = parent.org_id AND original.sha256 = parent.parent_sha256
    WHERE parent.org_id = b.org_id AND parent.sha256 = b.parent_sha256))`;
const COLUMNS = `sha256, attachment_id AS "attachmentId", preview_id AS "previewId",
  chat_id AS "chatId",
  message_id AS "messageId", name, file_type AS "fileType", mime_type AS "mimeType",
  size_bytes AS "sizeBytes",
  batch_id AS "batchId", position, agent_id AS "agentId", card_chat_id AS "cardChatId",
  widget_id AS "widgetId", added_by_person_id AS "addedBy", added_at AS "addedAt", state,
  event_id AS "eventId", reads, read_json AS "readJson", problem, duplicate_of AS "duplicateOf",
  record_id AS "recordId", dismissed_at AS "dismissedAt", parent_sha256 AS "parentSha256",
  cut_page AS "cutPage", json_type(read_json) IS 'array' AS cut,
  ${mailColumn("mail_from")} AS "mailFrom", ${mailColumn("mail_at")} AS "mailAt"`;

const batchRows = Effect.fn("KinBills.batchRows")(function* (
  orgId: KinOrgId,
  batchId: string,
  { includeCut = false } = {},
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<Row>`SELECT ${sql.literal(COLUMNS)} FROM kin_bill_reads b
    WHERE org_id = ${orgId} AND batch_id = ${batchId}
      AND ${includeCut ? sql.literal("1") : sql.literal(NOT_CUT)}
    ORDER BY position, sha256`;
});
const billRow = Effect.fn("KinBills.billRow")(function* (orgId: KinOrgId, hash: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<Row>`SELECT ${sql.literal(COLUMNS)} FROM kin_bill_reads b
    WHERE org_id = ${orgId} AND sha256 = ${hash}`;
  return row;
});

/** A retried write's first answer, or nothing; the same id asking for something else is refused. */
const storedAnswer = Effect.fn("KinBills.storedAnswer")(function* (
  orgId: KinOrgId,
  personId: string,
  kind: string,
  requestId: string,
  inputHash: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ inputHash: string; json: string }>`SELECT input_hash AS "inputHash",
      result_json AS json FROM kin_bill_requests
    WHERE org_id = ${orgId} AND person_id = ${personId} AND kind = ${kind}
      AND request_id = ${requestId}`;
  if (row === undefined) return undefined;
  if (row.inputHash !== inputHash) return yield* retryConflict;
  return yield* decodeStored(row.json);
});
const keepAnswer = Effect.fn("KinBills.keepAnswer")(function* (
  orgId: KinOrgId,
  personId: string,
  kind: string,
  requestId: string,
  inputHash: string,
  result: unknown,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_bill_requests (org_id, person_id, kind, request_id, input_hash,
      result_json, created_at)
    VALUES (${orgId}, ${personId}, ${kind}, ${requestId}, ${inputHash},
      ${yield* encodeStored(result)}, ${yield* Clock.currentTimeMillis})
    ON CONFLICT DO NOTHING`;
});

const fileBytes = Effect.fn("KinBills.fileBytes")(function* (attachment: ChatAttachment) {
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = resolveAttachmentPath({ attachmentsDir, attachment });
  if (path === null) return yield* invalid(`${attachment.name.slice(0, 80)} couldn't be read.`);
  return yield* fs
    .readFile(path)
    .pipe(Effect.mapError(() => invalid(`${attachment.name.slice(0, 80)} couldn't be read.`)));
});

/** Where a batch's card goes: the adder's own direct chat with the reading agent. */
const cardChat = Effect.fn("KinBills.cardChat")(function* (
  orgId: KinOrgId,
  personId: string,
  agentId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* directChatWith(sql, orgId, personId, agentId);
});

const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const countText = (count: number) => counted(count, "bill");
const sourceText = (slots: ReadonlyArray<SourceSlot>) =>
  counted(slots.length, slots.every((file) => file.photo) ? "photo" : "file");
/** The card's words, the whole truth for a client that draws no card. */
const legacyCardText = (card: Omit<KinBillBatchCard, "text">) => {
  const count = countText(card.total) + (card.from === "mail" ? " from mail" : "");
  if (card.status === "reading") return `Reading ${count}: ${card.done} done.`;
  const parts = [
    card.counts.read > 0 ? `${card.counts.read} read` : undefined,
    card.counts.duplicate > 0
      ? `${card.counts.duplicate} ${card.counts.duplicate === 1 ? "looks like a duplicate" : "look like duplicates"}`
      : undefined,
    card.counts.unreadable > (card.counts.check ?? 0)
      ? `${card.counts.unreadable - (card.counts.check ?? 0)} couldn't be read`
      : undefined,
    (card.counts.check ?? 0) > 0
      ? `${card.counts.check} ${card.counts.check === 1 ? "needs" : "need"} a check`
      : undefined,
    card.counts.already > 0
      ? `${card.counts.already} ${card.counts.already === 1 ? "was" : "were"} already added`
      : undefined,
    (card.refused ?? 0) > 0
      ? `${card.refused} ${card.refused === 1 ? "isn't a photo or PDF" : "aren't photos or PDFs"}`
      : undefined,
  ].filter((part) => part !== undefined);
  return `${count}: ${parts.length === 0 ? "none to read" : parts.join(", ")}.`;
};

const cardText = (
  card: Omit<KinBillBatchCard, "text">,
  slots: ReadonlyArray<SourceSlot>,
  kept: number,
  needs: number,
) => {
  if (card.from === "mail" || card.pausedUntil !== undefined) return legacyCardText(card);
  const clean = card.keepable?.count ?? 0;
  if (card.status === "reading") {
    const read = clean + kept;
    return `Reading ${sourceText(slots)}${read === 0 ? "" : `: ${countText(read)} read so far`}.`;
  }
  const needsYou = needs === 1 ? "needs you" : "need you";
  if (kept > 0) {
    const left = [
      clean > 0 ? `${clean} ready to keep` : undefined,
      needs > 0 ? `${needs} still ${needsYou}` : undefined,
    ].filter((part) => part !== undefined);
    return `${kept} kept.${left.length === 0 ? "" : ` ${left.join(", ")}.`}`;
  }
  if (clean + needs === 0) return "No bills to keep.";
  return `${countText(clean + needs)} from ${sourceText(slots)}: ${needs === 0 ? "all read cleanly" : `${clean} read cleanly, ${needs} ${needsYou}`}.`;
};

/**
 * Posts the batch's card, Kin's own, for the adder alone, silent while Kin reads; the bills' files
 * ride on it when they were added from Money, so every rule for a chat's files holds for them.
 */
const postCard = Effect.fn("KinBills.postCard")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
  readonly batchId: string;
  readonly card: StoredCard;
  readonly attachments: ReadonlyArray<KinAttachment>;
}) {
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const sql = yield* SqlClient.SqlClient;
  const widgetId = billWidgetId(input.batchId);
  const at = iso(yield* Clock.currentTimeMillis);
  const message = yield* repo.insertMessage({
    orgId: input.orgId,
    chatId: input.chatId,
    audience: "owner",
    messageId: KinMessageId.make(`bills:${input.batchId}`),
    author: { _tag: "system" },
    kind: "system",
    body: input.card.text,
    ...(input.attachments.length === 0 ? {} : { attachments: input.attachments }),
    intent: null,
    mentions: [],
    replyTo: null,
    widgetId: null,
    floorRunId: null,
    status: "posted",
    sentBy: null,
    clientMessageId: null,
    createdAt: at,
    editedAt: null,
    silent: true,
  });
  const widget = {
    orgId: input.orgId,
    chatId: input.chatId,
    messageId: message.messageId,
    widgetId,
    widgetClass: "native" as const,
    type: KIN_BILL_BATCH_CARD,
    state: input.card,
    source: null,
    feed: null,
    awaiting: [],
    pinnedAt: null,
    closedAt: null,
    updatedAt: at,
  };
  yield* repo.insertWidget({ ...widget, audience: "owner" });
  yield* sql.afterCommit(
    hub.publish({ type: "message.posted", orgId: input.orgId, message: { ...message, widgetId } }),
  );
  yield* sql.afterCommit(
    hub.publish({ type: "widget.updated", orgId: input.orgId, widget: { ...widget, revision: 1 } }),
  );
  return { chatId: input.chatId, widgetId };
});

const waitingRows = Effect.fn("KinBills.waitingRows")(function* (orgId: KinOrgId, batchId: string) {
  const sql = yield* SqlClient.SqlClient;
  // New crops wait for the turn that cut them; a read again need not wait on its old event.
  return yield* sql<Row>`SELECT ${sql.literal(COLUMNS)} FROM kin_bill_reads b
    WHERE org_id = ${orgId} AND batch_id = ${batchId} AND state = 'waiting'
      AND (b.reads > 0 OR NOT EXISTS (SELECT 1 FROM kin_events e WHERE e.org_id = b.org_id
        AND e.event_id = b.event_id AND e.state IN ('queued', 'claimed')))
    ORDER BY position, sha256`;
});

type RowAttachment = Pick<Row, "attachmentId" | "fileType" | "name" | "mimeType" | "sizeBytes">;

const rowAttachment = (row: RowAttachment): ChatAttachment => ({
  id: row.attachmentId,
  type: row.fileType,
  name: row.name,
  mimeType: row.mimeType,
  sizeBytes: row.sizeBytes,
});

const photoNeedsPreparation = (file: ChatAttachment) => !isPdf(file) && shownAsPicture(file);

const preparePhotos = Effect.fn("KinBills.preparePhotos")(function* (
  files: Iterable<ChatAttachment>,
) {
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const prepared = new Map<string, ChatAttachment | undefined>();
  for (const file of files) {
    if (photoNeedsPreparation(file) && !prepared.has(file.id))
      prepared.set(file.id, yield* billPhotoForModel(attachmentsDir, file));
  }
  return prepared;
});

const indexPreview = Effect.fn("KinBills.indexPreview")(function* (
  orgId: KinOrgId,
  row: RowAttachment & Pick<Row, "sha256">,
  photo: ChatAttachment | undefined,
) {
  if (photo === undefined || photo.id === row.attachmentId) return false;
  const sql = yield* SqlClient.SqlClient;
  const changed = yield* sql`UPDATE kin_bill_reads SET preview_id = ${photo.id}
    WHERE org_id = ${orgId} AND sha256 = ${row.sha256}
      AND attachment_id = ${row.attachmentId} AND preview_id IS NOT ${photo.id}
    RETURNING sha256`;
  return changed.length > 0 && photo.sizeBytes < row.sizeBytes;
});

/** Bills and statements share the existing owner-level Money refresh revision. */
const touchBills = Effect.fn("KinBills.touchBills")(function* (orgId: KinOrgId) {
  yield* (yield* KinRefreshObserver).touch(orgId, "moneyStatements");
});

export class KinBillPreviews extends Context.Service<
  KinBillPreviews,
  {
    readonly start: (orgId: KinOrgId, batchId: string) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/kin/work/bills/KinBillPreviews") {}

export const previewLayer = Layer.effect(
  KinBillPreviews,
  Effect.gen(function* () {
    const work = yield* FiberSet.make<void, never>();
    const services = yield* Effect.context<
      SqlClient.SqlClient | ServerConfig.ServerConfig | FileSystem.FileSystem
    >();
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const copyBatch = Effect.fn("KinBills.copyBatch")(function* (orgId: KinOrgId, batchId: string) {
      let shown = false;
      for (const row of yield* batchRows(orgId, batchId)) {
        const file = rowAttachment(row);
        if (!photoNeedsPreparation(file) || row.previewId !== null) continue;
        const indexed = yield* billPhotoForModel(attachmentsDir, file).pipe(
          Effect.flatMap((photo) => indexPreview(orgId, row, photo)),
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin could not save a bill preview", { cause }).pipe(
              Effect.as(false),
            ),
          ),
        );
        shown ||= indexed;
      }
      // One refresh a batch: a copy takes longer than a refresh settles, so one a copy would
      // reload Money's screens once a photo.
      if (shown) yield* touchBills(orgId);
    });
    return KinBillPreviews.of({
      start: Effect.fn("KinBillPreviews.start")((orgId, batchId) =>
        copyBatch(orgId, batchId).pipe(
          Effect.provide(services),
          Effect.catchCause((cause) =>
            Effect.logWarning("Kin could not prepare a batch's previews", { cause }),
          ),
          FiberSet.run(work, { startImmediately: false }),
          Effect.asVoid,
        ),
      ),
      drain: FiberSet.awaitEmpty(work),
    });
  }),
);

const billGroups = (
  rows: ReadonlyArray<Row>,
  photos: ReadonlyMap<string, ChatAttachment | undefined> | undefined,
) => {
  const groups: Array<Array<Row>> = [];
  let bytes = 0;
  for (const row of rows) {
    const last = groups.at(-1);
    const shown = photos?.get(row.attachmentId)?.sizeBytes ?? 0;
    if (
      last === undefined ||
      last.length >= KIN_BILLS_PER_TURN ||
      bytes + shown > PDF_PAGE_IMAGES.bytesPerTurn
    ) {
      groups.push([row]);
      bytes = shown;
    } else {
      last.push(row);
      bytes += shown;
    }
  }
  return groups;
};

/** Queues a batch's waiting bills to its reader, a few a quiet turn, below anyone's message. */
const queueWaiting = Effect.fn("KinBills.queueWaiting")(function* (
  orgId: KinOrgId,
  batchId: string,
  prepared: ReadonlyMap<string, ChatAttachment | undefined> | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue;
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* waitingRows(orgId, batchId);
  // A photo no turn can show (a phone's HEIC) is told at once, without spending a turn.
  const unshown = rows.filter(
    (row) =>
      !isPdf(row) &&
      !isText(row) &&
      !shownAsPicture({ type: row.fileType, mimeType: row.mimeType }),
  );
  if (unshown.length > 0)
    yield* sql`UPDATE kin_bill_reads SET state = 'unreadable', problem = ${UNSHOWN_PHOTO},
        read_at = ${now}
      WHERE org_id = ${orgId} AND sha256 IN ${sql.in(unshown.map((row) => row.sha256))}
        AND state = 'waiting'`;
  const failed = rows.filter(
    (row) => prepared?.has(row.attachmentId) && prepared.get(row.attachmentId) === undefined,
  );
  if (failed.length > 0)
    yield* sql`UPDATE kin_bill_reads SET state = 'unreadable', problem = ${COULD_NOT_READ},
        read_at = ${now}
      WHERE org_id = ${orgId} AND sha256 IN ${sql.in(failed.map((row) => row.sha256))}
        AND state = 'waiting'`;
  const waiting = rows.filter(
    (row) =>
      isPdf(row) ||
      isText(row) ||
      (prepared === undefined
        ? photoNeedsPreparation(rowAttachment(row))
        : prepared.get(row.attachmentId) !== undefined),
  );
  let shown = false;
  for (const row of waiting)
    shown = (yield* indexPreview(orgId, row, prepared?.get(row.attachmentId))) || shown;
  if (shown) yield* touchBills(orgId);
  for (const group of billGroups(waiting, prepared)) {
    const first = group[0]!;
    const reads = Math.max(...group.map((row) => row.reads)) + 1;
    const key = `${orgId}:${batchId}:${group.map((row) => row.sha256).join(",")}:${reads}`;
    const eventId = hashedEventId("bills", key);
    const hashes = group.map((row) => row.sha256);
    const send = (agentId: KinAgentId) =>
      queue
        .enqueue({
          _tag: "bills.read",
          orgId,
          agentId,
          eventId,
          receivedAt: DateTime.makeUnsafe(now),
          dedupeKey: null,
          provenance: { _tag: "system" },
          chatId: KinChatId.make(first.cardChatId),
          batchId,
          bills: hashes,
          ...(prepared !== undefined || group.every((row) => isPdf(row) || isText(row))
            ? { photosPrepared: true }
            : {}),
        })
        .pipe(
          Effect.as(true),
          Effect.catchTags({
            KinEventQueueRetiredAgent: () => Effect.succeed(false),
            KinEventQueueUnknownAgent: () => Effect.succeed(false),
          }),
        );
    let reader = KinAgentId.make(first.agentId);
    // A retired reader's bills go to the company's reader now; with none, they can't be read.
    if (!(yield* send(reader))) {
      const next = yield* billReader(orgId);
      if (next === undefined || next.agentId === reader || !(yield* send(next.agentId))) {
        yield* sql`UPDATE kin_bill_reads SET state = 'unreadable', problem = ${COULD_NOT_READ},
            read_at = ${now}
          WHERE org_id = ${orgId} AND sha256 IN ${sql.in(hashes)} AND state = 'waiting'`;
        continue;
      }
      reader = next.agentId;
    }
    yield* sql`UPDATE kin_bill_reads SET state = 'reading', event_id = ${eventId},
        reads = reads + 1, agent_id = ${reader}
      WHERE org_id = ${orgId} AND sha256 IN ${sql.in(hashes)} AND state = 'waiting'`;
  }
  return rows.length;
});

/** What the owner sees a bill as: its expense's state once one was made for it. */
const shownState = (
  row: Pick<Row, "state" | "recordId">,
  record: { readonly confirmed: number; readonly state: string } | undefined,
): KinBillState => {
  if (row.state === "waiting" || row.state === "reading") return "reading";
  if (row.recordId !== null && record !== undefined)
    return record.state === "dropped" ? "dropped" : record.confirmed === 1 ? "kept" : "read";
  return row.state === "read" ? "read" : row.state;
};

type RecordBrief = {
  readonly recordId: string;
  readonly key: string;
  readonly rev: number;
  readonly title: string;
  readonly state: KinRecordState;
  readonly confirmed: number;
  readonly minor: number | null;
  readonly currency: string | null;
  readonly dateAt: number | null;
  readonly category: string | null;
  readonly vendor: unknown;
  readonly taxJson: unknown;
};
const recordsById = Effect.fn("KinBills.recordsById")(function* (
  orgId: KinOrgId,
  ids: ReadonlyArray<string>,
) {
  if (ids.length === 0) return new Map<string, RecordBrief>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<RecordBrief>`SELECT record_id AS "recordId", key, rev, title, state,
      confirmed, amount_minor AS minor, currency, date_at AS "dateAt", category,
      json_extract(fields_json, '$.vendor') AS vendor, json_extract(fields_json, '$.tax') AS "taxJson"
    FROM kin_records
    WHERE org_id = ${orgId} AND record_id IN ${sql.in([...new Set(ids)])} ORDER BY record_id`;
  return new Map(rows.map((row) => [row.recordId, row]));
});

const keepableRecords = (rows: ReadonlyArray<Row>, records: ReadonlyMap<string, RecordBrief>) =>
  new Map(
    rows.flatMap((row) => {
      const record = row.recordId === null ? undefined : records.get(row.recordId);
      return row.dismissedAt === null &&
        row.state === "read" &&
        record?.confirmed === 0 &&
        (record.state === "done" ||
          (record.state === "open" && row.mailFrom !== null && row.mailAt !== null))
        ? [[row.sha256, record] as const]
        : [];
    }),
  );

const keepableSummary = (records: ReadonlyMap<string, RecordBrief>) => ({
  count: records.size,
  revision: sha256(
    JSON.stringify([...records].map(([bill, record]) => [bill, record.recordId, record.rev])),
  ).slice(0, 24),
});

const cardTotals = (
  records: ReadonlyMap<string, RecordBrief>,
  categories: ReadonlyArray<string>,
) => {
  const sums = new Map<string, Map<string, bigint>>();
  for (const { minor, currency, category } of records.values()) {
    if (minor === null || currency === null) continue;
    const label = category !== null && categories.includes(category) ? category : "No category";
    const byCategory = sums.get(currency) ?? new Map<string, bigint>();
    byCategory.set(label, (byCategory.get(label) ?? 0n) + BigInt(minor));
    sums.set(currency, byCategory);
  }
  return [...sums.keys()].sort().map((currency) => ({
    currency,
    categories: [...sums.get(currency)!]
      .sort(([a, left], [b, right]) =>
        left > right ? -1 : left < right ? 1 : a < b ? -1 : a > b ? 1 : 0,
      )
      .map(([category, minor]) => ({
        category,
        amount: formatKinMoney(minor, currency, { bare: true, cents: "always" }),
      })),
  }));
};

const sourceSlot = (file: ChatAttachment): SourceSlot => ({
  id: file.id,
  photo: !isPdf(file) && (file.type === "image" || mimeOf(file).startsWith("image/")),
});

const billNames = (rows: ReadonlyArray<Row>, slots: ReadonlyArray<SourceSlot> | undefined) => {
  const byHash = new Map(rows.map((row) => [row.sha256, row]));
  const sources =
    slots ??
    rows.filter((row) => row.parentSha256 === null).map((row) => sourceSlot(rowAttachment(row)));
  const roots = new Map<string, string>();
  for (const [i, { id, photo }] of sources.entries())
    if (!roots.has(id)) roots.set(id, `${photo ? "Photo" : "File"} ${i + 1}`);
  const nameFor = (row: Row): string => {
    if (row.parentSha256 === null) return roots.get(row.attachmentId) ?? `File ${row.position + 1}`;
    const parent = byHash.get(row.parentSha256);
    const piece = / · (?:bill )?(\d{1,2}) of (\d{1,2})$/u.exec(row.name);
    if (parent === undefined || piece === null) return `File ${row.position + 1}`;
    const page = isPdf(rowAttachment(parent)) ? ` · page ${row.cutPage ?? 1}` : "";
    return `${nameFor(parent)}${page} · bill ${piece[1]} of ${piece[2]}`;
  };
  return { sources, nameFor };
};

const missingFields = ["date", "amount", "who was paid", "currency", "tax"];
const listWords = (words: ReadonlyArray<string>) =>
  words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;

const needReason = (row: Row, records: ReadonlyMap<string, RecordBrief>) => {
  if (row.state === "duplicate") {
    const twin = row.duplicateOf === null ? undefined : records.get(row.duplicateOf);
    if (twin !== undefined) return `looks like ${twin.key}, already recorded.`;
    return "looks like an expense already recorded.";
  }
  if (row.state === "read" && row.recordId !== null && records.has(row.recordId))
    return "the expense's state changed: check it.";
  switch (row.problem) {
    case UNCLEAR_CURRENCY:
      return "the currency isn't clear.";
    case CHECK_IT.farAbove:
      return "the amount is far above the rest of Expenses: check it.";
    case CHECK_IT.ahead:
      return "the date is after today: check it.";
    case CHECK_IT.old:
      return "the date is more than ten years back: check it.";
    case "It is for 0":
      return "the amount is zero: no expense.";
    case UNSHOWN_PHOTO:
      return "Kin can't read this kind of photo: add it as a JPEG or PNG.";
  }
  // Recognize only the exact reader example; no word from the reader goes onto the card.
  if (row.problem !== null && /^[^:]+: two different totals[.!]?$/iu.test(row.problem))
    return "two different totals.";
  const missing = /^Couldn't read: ([^.]+)/u.exec(row.problem ?? "")?.[1]?.split(", ") ?? [];
  const known = missingFields
    .filter((field) => missing.includes(field))
    .map((field) => (field === "who was paid" ? "payee" : field));
  if (known.length === 1)
    return known[0] === "tax" ? "the tax amount needs a check." : `no ${known[0]} printed.`;
  if (known.length > 1) return `missing ${listWords(known)}.`;
  return "couldn't be read.";
};

/**
 * Redraws a batch's card from its rows: progress while Kin reads, the counts when done. Once done
 * it waits on the adder while a bill still needs them, which rings them once; else it closes.
 * `pause` holds reading until a time (the daily limit) or ends the hold; left out, a hold stands
 * until its time.
 */
const refreshCard = Effect.fn("KinBills.refreshCard")(function* (
  orgId: KinOrgId,
  batchId: string,
  {
    pause,
    newlyAlready = 0,
    appended = [],
    progressOnly = false,
  }: {
    readonly pause?: number | null;
    readonly newlyAlready?: number;
    readonly appended?: ReadonlyArray<SourceSlot>;
    readonly progressOnly?: boolean;
  } = {},
) {
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const sql = yield* SqlClient.SqlClient;
  const found = yield* repo.getWidget({ orgId, widgetId: billWidgetId(batchId) });
  if (Option.isNone(found)) return;
  const stored = Option.getOrUndefined(CardJson(found.value.state));
  if (stored === undefined) return;
  const now = yield* Clock.currentTimeMillis;
  const all = yield* batchRows(orgId, batchId, { includeCut: true });
  const rows = all.filter((row) => row.cut === 0);
  const records = yield* recordsById(
    orgId,
    rows.flatMap(({ recordId, duplicateOf }) =>
      [recordId, duplicateOf].filter((id) => id !== null),
    ),
  );
  const keepable = keepableRecords(rows, records);
  const sourceSlots =
    stored.sourceSlots === undefined
      ? undefined
      : appended.length === 0
        ? stored.sourceSlots
        : [...stored.sourceSlots, ...appended];
  const { sources, nameFor } = billNames(all, sourceSlots);
  const kept = rows.filter(
    (row) =>
      row.dismissedAt === null && shownState(row, records.get(row.recordId ?? "")) === "kept",
  ).length;
  const problemRows = rows.filter(
    (row) =>
      row.dismissedAt === null &&
      !keepable.has(row.sha256) &&
      ["read", "duplicate", "unreadable"].includes(
        shownState(row, records.get(row.recordId ?? "")),
      ),
  );
  const pending = rows.filter((row) => row.state === "waiting" || row.state === "reading").length;
  const counts = {
    read: rows.filter((row) => row.state === "read").length,
    duplicate: rows.filter((row) => row.state === "duplicate").length,
    unreadable: rows.filter((row) => row.state === "unreadable").length,
    check: rows.filter((row) => row.state === "unreadable" && READ_CLEAN.has(row.problem ?? ""))
      .length,
    already: stored.counts.already + newlyAlready,
  };
  const total = rows.length + counts.already;
  const status = pending === 0 ? ("done" as const) : ("reading" as const);
  const held =
    pause === null
      ? undefined
      : pause !== undefined
        ? pause
        : stored.pausedUntil === undefined
          ? undefined
          : Date.parse(stored.pausedUntil);
  const pausedUntil = status === "reading" && held !== undefined && held > now ? held : undefined;
  const { pausedUntil: _held, ...rest } = stored;
  const base = {
    ...rest,
    status,
    total,
    done: total - pending,
    counts,
    ...(sourceSlots === undefined ? {} : { sourceSlots }),
    keepable: keepableSummary(keepable),
    totals: cardTotals(
      keepable,
      keepable.size === 0 ? [] : ((yield* listDef(orgId, "expenses"))?.categories ?? []),
    ),
    needs: problemRows
      .slice(0, 5)
      .map((row) => ({ name: nameFor(row), reason: needReason(row, records) })),
    needsMore: Math.max(0, problemRows.length - 5),
    ...(pausedUntil === undefined ? {} : { pausedUntil: iso(pausedUntil) }),
  };
  const reader = rows.find((row) => row.state === "waiting" || row.state === "reading")?.agentId;
  const text = cardText(base, sources, kept, problemRows.length);
  const card: StoredCard = {
    ...base,
    text:
      pausedUntil === undefined || reader === undefined
        ? text
        : `${text} Paused until ${yield* clockTime(orgId, pausedUntil)}: today's limit for ${yield* agentName(orgId, reader)} is used up.`,
  };
  const open = rows.some((row) => {
    if (row.dismissedAt !== null) return false;
    const shown = shownState(row, records.get(row.recordId ?? ""));
    return shown === "read" || shown === "duplicate" || shown === "unreadable";
  });
  const awaiting = progressOnly
    ? found.value.awaiting
    : open && (stored.from === "mail" || status === "done")
      ? [stored.addedBy]
      : [];
  const closed = progressOnly ? found.value.closedAt !== null : status === "done" && !open;
  const rowName = sourceSlots === undefined ? undefined : nameFor;
  if (
    sameCard(stored, card) &&
    found.value.awaiting.length === awaiting.length &&
    (found.value.closedAt !== null) === closed
  )
    return rowName;
  const at = iso(yield* Clock.currentTimeMillis);
  const widget = yield* repo.updateWidget({
    ...found.value,
    audience: "owner",
    state: card,
    awaiting,
    expectedRevision: found.value.revision,
    closedAt: closed ? (found.value.closedAt ?? at) : null,
    updatedAt: at,
  });
  yield* sql.afterCommit(hub.publish({ type: "widget.updated", orgId, widget }));
  if (stored.text !== card.text) {
    // A chat list's line is the card message's body: it says what the card says now.
    const messageId = KinMessageId.make(`bills:${batchId}`);
    yield* sql`UPDATE kin_messages SET body = ${card.text}
      WHERE org_id = ${orgId} AND message_id = ${messageId}`;
    const message = yield* repo.getMessage({ orgId, messageId });
    if (Option.isSome(message))
      yield* sql.afterCommit(
        hub.publish({ type: "message.changed", orgId, message: message.value }),
      );
  }
  return rowName;
});

const DeferCardRefresh = Context.Reference("t3/kin/work/bills/DeferCardRefresh", {
  defaultValue: () => false,
});

export const refreshForExpense = Effect.fn("KinBills.refreshForExpense")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  if (yield* DeferCardRefresh) return;
  const repo = yield* Effect.serviceOption(KinChatRepository);
  const hub = yield* Effect.serviceOption(KinChatHub);
  if (Option.isNone(repo) || Option.isNone(hub)) return;
  const sql = yield* SqlClient.SqlClient;
  const batches = yield* sql<{ batchId: string }>`SELECT DISTINCT batch_id AS "batchId"
    FROM kin_bill_reads WHERE org_id = ${orgId} AND record_id = ${recordId}`;
  for (const { batchId } of batches)
    yield* refreshCard(orgId, batchId).pipe(
      Effect.provideService(KinChatRepository, repo.value),
      Effect.provideService(KinChatHub, hub.value),
    );
});

/** A time on the company's clock, as the card's words say it. */
const clockTime = Effect.fn("KinBills.clockTime")(function* (orgId: KinOrgId, at: number) {
  return formatKinWhen(at, "time", { zone: yield* ownerZone(orgId), locale: KIN_TEXT_LOCALE });
});
const agentName = Effect.fn("KinBills.agentName")(function* (orgId: KinOrgId, agentId: string) {
  const sql = yield* SqlClient.SqlClient;
  const [agent] = yield* sql<{ name: string }>`SELECT COALESCE(l.name, a.display_name) AS name
    FROM kin_agents a LEFT JOIN kin_leads l ON l.org_id = a.org_id AND l.agent_id = a.agent_id
    WHERE a.org_id = ${orgId} AND a.agent_id = ${agentId}`;
  return agent?.name ?? "the agent";
});

const batchesOf = (events: ReadonlyArray<KinEvent>) =>
  new Set(events.flatMap((event) => (event._tag === "bills.read" ? [event.batchId] : [])));
/**
 * Bills turns the daily limit held until `until`: each batch's card says so once, in place of a
 * line in the chat per turn.
 */
export const paused = Effect.fn("KinBills.paused")(function* (
  orgId: KinOrgId,
  events: ReadonlyArray<KinEvent>,
  until: number,
) {
  const batches = batchesOf(events);
  if (batches.size === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.forEach(batches, (batchId) => refreshCard(orgId, batchId, { pause: until }), {
      discard: true,
    }),
  );
});
/** A bills turn starting: its batches' cards say they are reading again. */
export const resumed = Effect.fn("KinBills.resumed")(function* (
  orgId: KinOrgId,
  events: ReadonlyArray<KinEvent>,
) {
  const batches = batchesOf(events);
  if (batches.size === 0) return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.forEach(batches, (batchId) => refreshCard(orgId, batchId, { pause: null }), {
      discard: true,
    }),
  );
});

type BillMail = { readonly from: string; readonly at: number };

/** Bills stored and waiting to be queued, in one transaction with their card. */
const insertBills = Effect.fn("KinBills.insertBills")(function* (input: {
  readonly orgId: KinOrgId;
  readonly batchId: string;
  readonly agentId: string;
  readonly cardChatId: KinChatId;
  readonly addedBy: string;
  readonly startPosition?: number;
  readonly mail?: BillMail;
  readonly source?: { readonly sha256: string; readonly page: number; readonly eventId: string };
  readonly files: ReadonlyArray<{
    readonly attachment: KinAttachment;
    readonly sha256: string;
    readonly chatId: string;
    readonly messageId: string;
    readonly boxJson?: string;
  }>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const added: Array<string> = [];
  const parent = input.source?.sha256 ?? null;
  const page = input.source?.page ?? null;
  const eventId = input.source?.eventId ?? null;
  for (const [index, file] of input.files.entries()) {
    const position = (input.startPosition ?? 0) + index;
    const box = file.boxJson ?? null;
    const inserted = yield* sql`INSERT INTO kin_bill_reads (org_id, sha256, attachment_id, chat_id,
        message_id, name, file_type, mime_type, size_bytes, batch_id, position, agent_id,
        card_chat_id, widget_id, added_by_person_id, added_at, state, event_id,
        parent_sha256, cut_page, cut_box_json, mail_from, mail_at)
      VALUES (${input.orgId}, ${file.sha256}, ${file.attachment.id}, ${file.chatId},
        ${file.messageId}, ${file.attachment.name}, ${file.attachment.type},
        ${file.attachment.mimeType},
        ${file.attachment.sizeBytes}, ${input.batchId}, ${position}, ${input.agentId},
        ${input.cardChatId}, ${billWidgetId(input.batchId)}, ${input.addedBy}, ${now}, 'waiting',
        ${eventId}, ${parent}, ${page}, ${box}, ${input.mail?.from ?? null}, ${input.mail?.at ?? null})
      ON CONFLICT DO NOTHING RETURNING sha256`;
    // A dismissed or orphaned bill comes back as this batch's, on this file, to be read anew.
    const revived =
      inserted.length > 0
        ? []
        : yield* sql`UPDATE kin_bill_reads AS b SET attachment_id = ${file.attachment.id},
              preview_id = CASE WHEN b.attachment_id = ${file.attachment.id} THEN preview_id END,
              chat_id = ${file.chatId}, message_id = ${file.messageId},
              name = ${file.attachment.name}, file_type = ${file.attachment.type},
              mime_type = ${file.attachment.mimeType}, size_bytes = ${file.attachment.sizeBytes},
              batch_id = ${input.batchId}, position = ${position}, agent_id = ${input.agentId},
              card_chat_id = ${input.cardChatId}, widget_id = ${billWidgetId(input.batchId)},
              added_by_person_id = ${input.addedBy}, added_at = ${now}, state = 'waiting',
              event_id = ${eventId}, reads = 0, read_json = NULL, problem = NULL, duplicate_of = NULL,
              read_at = NULL, dismissed_at = NULL, parent_sha256 = ${parent}, cut_page = ${page},
              cut_box_json = ${box}, mail_from = ${input.mail?.from ?? null},
              mail_at = ${input.mail?.at ?? null}
            WHERE b.org_id = ${input.orgId} AND b.sha256 = ${file.sha256}
              AND ${revivable(sql)}
            RETURNING sha256`;
    if (inserted.length > 0 || revived.length > 0) added.push(file.sha256);
  }
  return added;
});

/**
 * A bill with no expense that its owner dismissed, or whose file is on no message any more (its
 * chat was cleared): the same bytes added again bring it back to be read.
 */
const revivable = (sql: SqlClient.SqlClient) =>
  sql.literal(`(b.record_id IS NULL AND (b.dismissed_at IS NOT NULL OR NOT EXISTS (
    SELECT 1 FROM kin_message_attachments a JOIN kin_messages m ON m.org_id = a.org_id
      AND m.message_id = a.message_id
    WHERE a.org_id = b.org_id AND a.attachment_id = b.attachment_id AND m.status <> 'deleted')))`);

type Known = {
  readonly expense: string | undefined;
  readonly dropped: boolean;
  readonly revive: boolean;
  readonly batchId: string;
};
/** The files already a bill in this company: the expense made for each, and whether it returns. */
const alreadyAdded = Effect.fn("KinBills.alreadyAdded")(function* (
  orgId: KinOrgId,
  hashes: ReadonlyArray<string>,
) {
  if (hashes.length === 0) return new Map<string, Known>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    sha256: string;
    key: string | null;
    recordState: string | null;
    revive: number;
    batchId: string;
  }>`SELECT b.sha256, r.key, r.state AS "recordState", ${revivable(sql)} AS revive,
      b.batch_id AS "batchId"
    FROM kin_bill_reads b LEFT JOIN kin_records r ON r.org_id = b.org_id
      AND r.record_id = b.record_id
    WHERE b.org_id = ${orgId} AND b.sha256 IN ${sql.in([...new Set(hashes)])} ORDER BY b.sha256`;
  return new Map(
    rows.map((row) => [
      row.sha256,
      {
        expense: row.key ?? undefined,
        dropped: row.recordState === "dropped",
        revive: row.revive === 1,
        batchId: row.batchId,
      },
    ]),
  );
});

type Prepared = {
  readonly accepted: ReadonlyArray<{
    readonly attachment: KinAttachment;
    readonly sha256: string;
    /** The id the person sent it under, before the claim renamed it. */
    readonly sentId?: string | undefined;
  }>;
  readonly refused: ReadonlyArray<{
    readonly name: string;
    readonly reason: string;
    /** The id the person sent it under, so a client can mark that chosen file refused. */
    readonly sentId?: string | undefined;
  }>;
};

/**
 * The batch itself: new bills stored, the rest told as already added; the card posted and the
 * first groups queued. Runs in the caller's transaction; `onMessage` says where files live.
 */
const startBatch = Effect.fn("KinBills.startBatch")(function* (input: {
  readonly orgId: KinOrgId;
  readonly batchId: string;
  readonly agentId: string;
  readonly cardChatId: KinChatId;
  readonly addedBy: string;
  readonly prepared: Prepared;
  readonly mail?: BillMail;
  readonly photos?: ReadonlyMap<string, ChatAttachment | undefined>;
  /** Files added from Money ride on the card's message; files from chat stay on theirs. */
  readonly source:
    | { readonly _tag: "card" }
    | { readonly _tag: "message"; readonly chatId: string; readonly messageId: string };
}) {
  const known = yield* alreadyAdded(
    input.orgId,
    input.prepared.accepted.map((file) => file.sha256),
  );
  const seen = new Set<string>();
  const fresh: Array<Prepared["accepted"][number]> = [];
  const already: Array<KinBillsAddResult["already"][number]> = [];
  for (const file of input.prepared.accepted) {
    const prior = known.get(file.sha256);
    if ((prior !== undefined && !prior.revive) || seen.has(file.sha256)) {
      already.push({
        name: answerName(file.attachment.name),
        sha256: file.sha256,
        ...(prior?.expense === undefined ? {} : { expense: prior.expense }),
        ...(prior?.dropped === true ? { dropped: true } : {}),
        ...(file.sentId === undefined ? {} : { attachmentId: file.sentId }),
        batchId: prior?.batchId ?? input.batchId,
      });
      continue;
    }
    seen.add(file.sha256);
    fresh.push(file);
  }
  const sourceSlots = input.prepared.accepted.map(({ attachment }) => sourceSlot(attachment));
  const base = {
    batchId: input.batchId,
    sourceSlots,
    keepable: keepableSummary(new Map()),
    totals: [],
    needs: [],
    needsMore: 0,
    status: "reading" as const,
    total: fresh.length + already.length,
    done: already.length,
    counts: { read: 0, duplicate: 0, unreadable: 0, check: 0, already: already.length },
    ...(input.prepared.refused.length === 0 ? {} : { refused: input.prepared.refused.length }),
    addedBy: KinPersonId.make(input.addedBy),
    ...(input.mail === undefined ? {} : { from: "mail" as const }),
  };
  // Nothing new to read is no decision: no card, only the answer.
  const posted =
    fresh.length === 0
      ? undefined
      : yield* postCard({
          orgId: input.orgId,
          chatId: input.cardChatId,
          batchId: input.batchId,
          card: { ...base, text: cardText(base, sourceSlots, 0, 0) },
          attachments: input.source._tag === "card" ? fresh.map((file) => file.attachment) : [],
        });
  const where =
    input.source._tag === "card"
      ? { chatId: input.cardChatId, messageId: `bills:${input.batchId}` }
      : { chatId: input.source.chatId, messageId: input.source.messageId };
  const added = yield* insertBills({
    orgId: input.orgId,
    batchId: input.batchId,
    agentId: input.agentId,
    cardChatId: input.cardChatId,
    addedBy: input.addedBy,
    files: fresh.map((file) => ({ ...file, ...where })),
    ...(input.mail === undefined ? {} : { mail: input.mail }),
  });
  yield* queueWaiting(input.orgId, input.batchId, input.photos);
  if (posted !== undefined) yield* refreshCard(input.orgId, input.batchId);
  // A bill brought back left its old batch: that card counts it no more.
  for (const batchId of new Set(
    added.flatMap((hash) => {
      const prior = known.get(hash);
      return prior === undefined || prior.batchId === input.batchId ? [] : [prior.batchId];
    }),
  ))
    yield* refreshCard(input.orgId, batchId);
  return {
    batchId: input.batchId,
    ...(posted === undefined ? {} : posted),
    added: fresh
      .filter((file) => added.includes(file.sha256))
      .map((file) => ({ name: answerName(file.attachment.name), sha256: file.sha256 })),
    already,
    refused: input.prepared.refused.map((file) => ({
      name: answerName(file.name),
      reason: file.reason,
      ...(file.sentId === undefined ? {} : { attachmentId: file.sentId }),
    })),
  } satisfies KinBillsAddResult;
});

/** Whether `addMailBills` would add for `adder` now: a reader and its direct chat with them. */
export const mailBillsReady = Effect.fn("KinBills.mailBillsReady")(function* (
  orgId: KinOrgId,
  adder: KinPersonId,
) {
  const reader = yield* billReader(orgId);
  return reader !== undefined && (yield* cardChat(orgId, adder, reader.agentId)) !== undefined;
});

/** Adds the verified parts of one mail in the caller's transaction. */
export const addMailBills = Effect.fn("KinBills.addMailBills")(function* (input: {
  readonly orgId: KinOrgId;
  readonly adder: KinPersonId;
  readonly files: readonly [Prepared["accepted"][number], ...Prepared["accepted"]];
  readonly mail: BillMail;
}) {
  const { orgId, adder, files, mail } = input;
  const reader = yield* billReader(orgId);
  if (reader === undefined) return { _tag: "wait" } as const;
  const chatId = yield* cardChat(orgId, adder, reader.agentId);
  if (chatId === undefined) return { _tag: "wait" } as const;

  const sql = yield* SqlClient.SqlClient;
  const zone = yield* ownerZone(orgId);
  const day = dayIn(yield* Clock.currentTimeMillis, zone);
  let key = `${orgId}:mail:${adder}:${day}`;
  let batchId = batchIdFor(key);
  const message = (id: string) =>
    sql<{ status: string; chatId: string }>`SELECT status, chat_id AS "chatId" FROM kin_messages
      WHERE org_id = ${orgId} AND message_id = ${`bills:${id}`}`;
  let [posted] = yield* message(batchId);
  while (posted !== undefined && (posted.status !== "posted" || posted.chatId !== chatId)) {
    key += `:${files[0].sha256}`;
    batchId = batchIdFor(key);
    [posted] = yield* message(batchId);
  }

  const batch = {
    orgId,
    batchId,
    agentId: reader.agentId,
    cardChatId: chatId,
    addedBy: adder,
    mail,
  };
  const added = yield* posted === undefined
    ? startBatch({
        ...batch,
        prepared: { accepted: files, refused: [] },
        source: { _tag: "card" },
      }).pipe(Effect.map((result) => result.added.map((file) => file.sha256)))
    : appendMailBills(batch, files);

  return {
    _tag: "added",
    batchId,
    keptFiles: files
      .filter(
        (file, i) =>
          added.includes(file.sha256) &&
          files.findIndex((part) => part.sha256 === file.sha256) === i,
      )
      .map((file) => file.attachment.id),
  } as const;
});

const appendMailBills = Effect.fn("KinBills.appendMailBills")(function* (
  batch: Pick<
    Parameters<typeof insertBills>[0],
    "orgId" | "batchId" | "agentId" | "cardChatId" | "addedBy" | "mail"
  >,
  files: Prepared["accepted"],
) {
  const { orgId, batchId, cardChatId: chatId } = batch;
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const known = yield* alreadyAdded(
    orgId,
    files.map((file) => file.sha256),
  );
  const unique = new Map<string, Prepared["accepted"][number]>();
  for (const file of files) {
    const prior = known.get(file.sha256);
    if (!unique.has(file.sha256) && (prior === undefined || prior.revive))
      unique.set(file.sha256, file);
  }
  const messageId = KinMessageId.make(`bills:${batchId}`);
  const [last] = yield* sql<{ position: number }>`SELECT COALESCE(MAX(position), -1) AS position
    FROM kin_bill_reads WHERE org_id = ${orgId} AND batch_id = ${batchId}`;
  const added = yield* insertBills({
    ...batch,
    startPosition: (last?.position ?? -1) + 1,
    files: [...unique.values()].map((file) => ({ ...file, chatId, messageId })),
  });
  for (const hash of added)
    yield* repo.attachCardFile({
      orgId,
      chatId,
      messageId,
      attachmentId: unique.get(hash)!.attachment.id,
    });
  yield* queueWaiting(orgId, batchId, undefined);
  yield* refreshCard(orgId, batchId, {
    newlyAlready: files.length - added.length,
    appended: files.map(({ attachment }) => sourceSlot(attachment)),
  });
  for (const oldBatch of new Set(added.map((hash) => known.get(hash)?.batchId)))
    if (oldBatch !== undefined && oldBatch !== batchId) yield* refreshCard(orgId, oldBatch);
  return added;
});

const prepareFiles = Effect.fn("KinBills.prepareFiles")(function* (
  files: ReadonlyArray<KinAttachment>,
  uploads?: ReadonlyArray<KinAttachment>,
) {
  const accepted: Array<Prepared["accepted"][number]> = [];
  const refused: Array<Prepared["refused"][number]> = [];
  for (const [index, attachment] of files.entries()) {
    const bytes = yield* fileBytes(attachment);
    const sentId = uploads?.[index]?.id;
    const dimensions = isPdf(attachment)
      ? null
      : readImageDimensions(bytes.subarray(0, IMAGE_DIMENSIONS_HEADER_BYTES));
    if (dimensions !== null && dimensions.width * dimensions.height > BILL_PHOTO_MAX_PIXELS) {
      refused.push({
        name: attachment.name,
        reason: refuseBillPage("photo_pixels").problem,
        ...(sentId === undefined ? {} : { sentId }),
      });
    } else {
      accepted.push({ attachment, sha256: sha256(bytes), sentId });
    }
  }
  return { accepted, refused };
});

/** `kin.bills.add`: files uploaded from Money's Add bills, kept on the batch's card. */
export const add = Effect.fn("KinBills.add")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: {
    readonly orgId: KinOrgId;
    readonly attachments: ReadonlyArray<KinAttachment>;
    readonly clientRequestId: string;
  },
  uploader: PendingUploadOwner,
) {
  const person = yield* theOwner(people, input.orgId);
  const inputHash = sha256(
    input.attachments
      .map((file) => file.id)
      .toSorted()
      .join("\n"),
  );
  const stored = yield* storedAnswer(
    input.orgId,
    person.personId,
    "add",
    input.clientRequestId,
    inputHash,
  );
  if (stored !== undefined) return yield* decodeAdded(stored);
  yield* countryFirst(input.orgId);
  const reader = yield* billReader(input.orgId);
  if (reader === undefined) return yield* invalid("This company has no agent to read bills yet.");
  const chatId = yield* cardChat(input.orgId, person.personId, reader.agentId);
  if (chatId === undefined)
    return yield* invalid(`Open your chat with ${reader.name} first: its card goes there.`);
  const refused = input.attachments
    .filter((file) => !isBillFile(file))
    .map((file) => ({ name: file.name, reason: NOT_A_BILL, sentId: file.id }));
  const wanted = input.attachments.filter(isBillFile);
  const store = yield* Effect.serviceOption(KinAttachmentStore);
  if (wanted.length > 0 && Option.isNone(store)) return yield* invalid("Files are unavailable.");
  const claimed =
    wanted.length === 0 || Option.isNone(store)
      ? undefined
      : yield* store.value.claim(wanted, uploader);
  const sql = yield* SqlClient.SqlClient;
  const batchId = batchIdFor(`${input.orgId}:${person.personId}:${input.clientRequestId}`);
  const prepared = yield* prepareFiles(claimed?.attachments ?? [], wanted).pipe(
    Effect.onError(() =>
      claimed === undefined || Option.isNone(store) ? Effect.void : store.value.release(claimed),
    ),
  );
  const { result, created } = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const again = yield* storedAnswer(
          input.orgId,
          person.personId,
          "add",
          input.clientRequestId,
          inputHash,
        );
        if (again !== undefined) return { result: yield* decodeAdded(again), created: false };
        const made = yield* startBatch({
          orgId: input.orgId,
          batchId,
          agentId: reader.agentId,
          cardChatId: chatId,
          addedBy: person.personId,
          prepared: { accepted: prepared.accepted, refused: [...refused, ...prepared.refused] },
          source: { _tag: "card" },
        });
        yield* keepAnswer(
          input.orgId,
          person.personId,
          "add",
          input.clientRequestId,
          inputHash,
          made,
        );
        return { result: made, created: true };
      }),
    )
    .pipe(
      Effect.onError(() =>
        claimed === undefined || Option.isNone(store) ? Effect.void : store.value.release(claimed),
      ),
    );
  if (claimed !== undefined && Option.isSome(store)) {
    // Files whose bytes were already a bill, or twice in this add, are on no message: they go.
    const kept = new Set(created ? result.added.map((file) => file.sha256) : []);
    const onCard = new Map<string, string>();
    for (const file of prepared.accepted)
      if (kept.has(file.sha256) && !onCard.has(file.sha256))
        onCard.set(file.sha256, file.attachment.id);
    const ids = new Set(onCard.values());
    yield* store.value.remove(
      (claimed?.attachments ?? []).filter((file) => !ids.has(file.id)).map((file) => file.id),
    );
    yield* store.value.discardPending(wanted);
  }
  if (created && result.added.length > 0)
    yield* (yield* KinBillPreviews).start(input.orgId, batchId);
  return result;
}, workFailure);

/**
 * `bills_add`: the bills on a person's message in a chat with this agent, read in the background
 * by this agent. Only an owner-level person's own message, by its event in this turn.
 */
export const addFromMessage = Effect.fn("KinBills.addFromMessage")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly eventId: string;
  readonly chatId: string;
  readonly messageId: string;
}) {
  const repo = yield* KinChatRepository;
  const sql = yield* SqlClient.SqlClient;
  const found = yield* repo.getMessage({
    orgId: input.orgId,
    messageId: KinMessageId.make(input.messageId),
  });
  if (
    Option.isNone(found) ||
    found.value.chatId !== input.chatId ||
    found.value.status !== "posted" ||
    found.value.author._tag !== "human"
  )
    return yield* invalid("That message has no bills from a person.");
  const personId = found.value.author.personId;
  const [level] = yield* sql<{ ok: number }>`SELECT 1 AS ok FROM kin_people p
    WHERE p.org_id = ${input.orgId} AND p.person_id = ${personId} AND p.removed_at IS NULL
      AND ${sql.literal(ownerLevelSql("p.org_id", "p.person_id"))}`;
  if (level === undefined)
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the owner or a co-owner adds bills to Expenses.",
    });
  const files = found.value.attachments ?? [];
  const refused = files
    .filter((file) => !isBillFile(file))
    .map((file) => ({ name: file.name, reason: NOT_A_BILL }));
  const wanted = files.filter(isBillFile);
  if (wanted.length === 0) return yield* invalid("That message has no photo or PDF.");
  const requestId = `event:${input.eventId}`;
  const stored = yield* storedAnswer(input.orgId, personId, "add", requestId, input.messageId);
  if (stored !== undefined) return yield* decodeAdded(stored);
  yield* countryFirst(input.orgId);
  const cardChatId =
    (yield* cardChat(input.orgId, personId, input.agentId)) ?? KinChatId.make(input.chatId);
  const prepared = yield* prepareFiles(wanted);
  const photos = yield* preparePhotos(prepared.accepted.map(({ attachment }) => attachment));
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const again = yield* storedAnswer(input.orgId, personId, "add", requestId, input.messageId);
      if (again !== undefined) return yield* decodeAdded(again);
      const current = yield* repo.getMessage({
        orgId: input.orgId,
        messageId: found.value.messageId,
      });
      if (Option.isNone(current) || current.value.status !== "posted")
        return yield* invalid("That message has no bills from a person.");
      const made = yield* startBatch({
        orgId: input.orgId,
        batchId: batchIdFor(`${input.orgId}:${requestId}`),
        agentId: input.agentId,
        cardChatId,
        addedBy: personId,
        prepared: { accepted: prepared.accepted, refused: [...refused, ...prepared.refused] },
        photos,
        source: { _tag: "message", chatId: input.chatId, messageId: input.messageId },
      });
      yield* keepAnswer(input.orgId, personId, "add", requestId, input.messageId, made);
      return made;
    }),
  );
}, workFailure);

type BillTurn = { readonly orgId: KinOrgId; readonly agentId: string; readonly wakeupId: string };

/** A turn's bills, each by the short id the turn names it with: B1, B2… in the event's order. */
const turnBills = Effect.fn("KinBills.turnBills")(function* (
  orgId: KinOrgId,
  agentId: string,
  wakeupId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const hashes = yield* sql<{
    hash: string;
    eventId: string;
  }>`SELECT j.value AS hash, e.event_id AS "eventId"
    FROM kin_events e, json_each(e.json, '$.bills') j
    WHERE e.org_id = ${orgId} AND e.agent_id = ${agentId} AND e.wakeup_id = ${wakeupId}
      AND e.tag = 'bills.read' AND e.state = 'claimed'
    ORDER BY e.priority, e.received_at, e.event_id, j.key`;
  return new Map(hashes.map((row, index) => [`B${index + 1}`, row]));
});

const normalizeMark = (mark: string) => mark.trim().toLowerCase();
const currenciesByMark = new Map<string, Set<string>>();
const displayNames = new Intl.DisplayNames(KIN_TEXT_LOCALE, { type: "currency" });
for (const currency of KIN_CURRENCY_CODES) {
  const add = (mark: string | undefined) => {
    if (mark === undefined || mark.length > 8 || mark === currency) return;
    const key = normalizeMark(mark);
    const codes = currenciesByMark.get(key) ?? new Set<string>();
    codes.add(currency);
    currenciesByMark.set(key, codes);
  };
  add(displayNames.of(currency));
  for (const currencyDisplay of ["symbol", "narrowSymbol", "name"] as const) {
    const format = new Intl.NumberFormat(KIN_TEXT_LOCALE, {
      style: "currency",
      currency,
      currencyDisplay,
    });
    for (const amount of [1, 2])
      add(format.formatToParts(amount).find(({ type }) => type === "currency")?.value);
  }
}

const currencyOfMark = (mark: string, home: string) => {
  const codes = currenciesByMark.get(normalizeMark(mark));
  return codes?.has(home) ? home : codes?.size === 1 ? codes.values().next().value : undefined;
};

/** One bill's answer, by plain rules: a clean read becomes one suggested expense or a duplicate. */
const settleRead = Effect.fn("KinBills.settleRead")(function* (
  orgId: KinOrgId,
  row: Row,
  answer: {
    readonly readable: boolean;
    readonly read: KinBillRead;
    readonly cannotRead?: string | undefined;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const { currencyAssumed: _untrusted, ...printed } = answer.read;
  const home = yield* homeCurrency(orgId);
  const assumed = printed.currency === undefined && printed.currencyMark === undefined;
  const currency =
    printed.currency ??
    (printed.currencyMark === undefined ? home : currencyOfMark(printed.currencyMark, home));
  const read = {
    ...printed,
    ...(currency === undefined ? {} : { currency }),
    ...(assumed ? { currencyAssumed: true as const } : {}),
  };
  const json = yield* encodeRead(read).pipe(Effect.orDie);
  const unreadable = (problem: string) =>
    sql`UPDATE kin_bill_reads SET state = 'unreadable', read_json = ${json}, problem = ${problem},
        read_at = ${now}
      WHERE org_id = ${orgId} AND sha256 = ${row.sha256}`.pipe(Effect.as("unreadable" as const));
  if (currency === undefined) return yield* unreadable(UNCLEAR_CURRENCY);
  const missing: Array<string> = [];
  const amount = plainNumber(read.amount, currency);
  if (read.vendor === undefined || notAVendor(read.vendor)) missing.push("who was paid");
  if (read.date === undefined) missing.push("date");
  if (amount === undefined) missing.push("amount");
  if (read.tax !== undefined && plainNumber(read.tax, currency) === undefined) missing.push("tax");
  const parsed = amount === undefined ? undefined : parseKinMoney(amount, currency);
  if (parsed !== undefined && "error" in parsed) missing.push("amount");
  const money = parsed !== undefined && "money" in parsed ? parsed.money : undefined;
  // The agent's own words about the bill, said as its own and on one line.
  const words = answer.cannotRead?.replace(/\s+/gu, " ").trim();
  const theirs =
    words === undefined || words === ""
      ? undefined
      : `${yield* agentName(orgId, row.agentId)}: ${words}`;
  if (!answer.readable) return yield* unreadable((theirs ?? COULD_NOT_READ).slice(0, 300));
  if (missing.length > 0)
    return yield* unreadable(
      `Couldn't read: ${[...new Set(missing)].join(", ")}${theirs === undefined ? "" : `. ${theirs}`}`.slice(
        0,
        300,
      ),
    );
  if (money === undefined || read.vendor === undefined || read.date === undefined)
    return yield* unreadable(COULD_NOT_READ);
  if (money.minor === 0) return yield* unreadable("It is for 0");
  // What an agent's record_create or a person's form would question is the owner's to check.
  const largest = yield* largestIn(orgId, "expenses", money.currency);
  if (farAbove("Expenses", money, largest, home) !== undefined)
    return yield* unreadable(CHECK_IT.farAbove);
  const zone = yield* ownerZone(orgId);
  const today = dayIn(now, zone);
  if (read.date > today) return yield* unreadable(CHECK_IT.ahead);
  if (read.date < `${Number(today.slice(0, 4)) - 10}${today.slice(4)}`)
    return yield* unreadable(CHECK_IT.old);
  const twin = yield* sameExpense(orgId, row.sha256, read.vendor, read.date, money, zone);
  if (twin !== undefined) {
    yield* sql`UPDATE kin_bill_reads SET state = 'duplicate', read_json = ${json},
        duplicate_of = ${twin}, problem = NULL, read_at = ${now}
      WHERE org_id = ${orgId} AND sha256 = ${row.sha256}`;
    return "duplicate" as const;
  }
  const made = yield* makeExpense(orgId, row, read, money, zone, "auto");
  yield* sql`UPDATE kin_bill_reads SET state = 'read', read_json = ${json}, record_id = ${made},
      problem = NULL, duplicate_of = NULL, read_at = ${now}
    WHERE org_id = ${orgId} AND sha256 = ${row.sha256}`;
  return "read" as const;
});

/** An expense already there for the same payee, day, amount and currency, not dropped. */
const sameExpense = Effect.fn("KinBills.sameExpense")(function* (
  orgId: KinOrgId,
  hash: string,
  vendor: string,
  day: string,
  money: { readonly minor: number; readonly currency: string },
  zone: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const at = endOfDay(day, zone);
  const rows = yield* sql<{
    recordId: string;
    title: string;
    vendor: unknown;
    dateAt: number | null;
    printed: string | null;
  }>`SELECT r.record_id AS "recordId", r.title, json_extract(r.fields_json, '$.vendor') AS vendor,
      r.date_at AS "dateAt", b.printed
    FROM kin_records r
    LEFT JOIN (SELECT org_id, sha256, json_extract(read_json, '$.date') AS printed
      FROM kin_bill_reads) b ON b.org_id = r.org_id AND b.sha256 = substr(r.origin_key, 6)
        AND r.origin_key = 'bill:' || b.sha256
    WHERE r.org_id = ${orgId} AND r.register_id = 'expenses' AND r.state != 'dropped'
      AND r.amount_minor = ${money.minor} AND r.currency = ${money.currency}
      AND (r.date_at BETWEEN ${at - 2 * 86_400_000} AND ${at + 2 * 86_400_000}
        OR b.printed = ${day})
      AND r.origin_key != ${`bill:${hash}`}
    ORDER BY r.created_at, r.record_id`;
  const payee = fold(vendor);
  // A mailed bill is dated only once paid, on that day: its own read keeps the printed day.
  return rows.find(
    (one) =>
      (one.printed === day || (one.dateAt !== null && dayIn(one.dateAt, zone) === day)) &&
      payee !== "" &&
      (typeof one.vendor === "string" ? fold(one.vendor) === payee : fold(one.title) === payee),
  )?.recordId;
});

const titleOf = (vendor: string, day: string) => {
  const month = MONTHS[Number(day.slice(5, 7)) - 1] ?? "";
  return `${vendor.trim().slice(0, 240)}, ${month} ${day.slice(0, 4)}`;
};

/**
 * The bill's one suggested expense. Kin writes it for the person who added the bill.
 * A retry finds it by its key.
 */
const makeExpense = Effect.fn("KinBills.makeExpense")(function* (
  orgId: KinOrgId,
  row: Row,
  read: KinBillRead,
  money: { readonly minor: number; readonly currency: string },
  zone: string,
  how: "auto" | { readonly requestHash: string },
) {
  const records = yield* KinRecords;
  const sql = yield* SqlClient.SqlClient;
  const def = yield* presetList(orgId, "expenses", yield* Clock.currentTimeMillis);
  if (def === undefined) return yield* invalid("Kin couldn't make the Expenses list.");
  const category =
    read.category === undefined
      ? undefined
      : def.categories.find((one) => one.toLowerCase() === read.category!.toLowerCase());
  const printedTax = plainNumber(read.tax, money.currency);
  const tax = printedTax === undefined ? undefined : parseKinMoney(printedTax, money.currency);
  const [adder] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${row.addedBy}`;
  const writer: Writer = {
    actor: { _tag: "system" },
    via: "owner",
    chatId: KinChatId.make(row.cardChatId),
    askedBy: KinPersonId.make(row.addedBy),
  };
  const fromMail = row.mailFrom !== null && row.mailAt !== null;
  const { row: made } = yield* records.create(orgId, writer, {
    list: "expenses",
    originKey: `bill:${row.sha256}`,
    ...(how === "auto" ? {} : { requestHash: how.requestHash }),
    title: titleOf(read.vendor ?? "", read.date ?? ""),
    owner: { _tag: "person", personId: KinPersonId.make(row.addedBy) },
    state: fromMail ? "open" : "done",
    amount: money,
    ...(fromMail ? {} : { dateAt: endOfDay(read.date ?? "", zone), dateAllDay: true }),
    ...(category === undefined ? {} : { category }),
    fields: {
      vendor: read.vendor ?? "",
      receipt: [row.attachmentId],
      ...(tax !== undefined && "money" in tax && tax.money.minor !== 0 ? { tax: tax.money } : {}),
    },
    notes: fromMail
      ? `Read by Kin from a mail from ${row.mailFrom}, received ${formatKinWhen(row.mailAt, "date", { zone, locale: KIN_TEXT_LOCALE })}.`
      : `Read by Kin from a photo ${adder?.name ?? "someone"} added.`,
    sensitive: true,
    confirmed: false,
    source: { chatId: KinChatId.make(row.chatId), messageId: KinMessageId.make(row.messageId) },
  });
  return made.recordId;
});

/** `bill_read`'s answer: one short line on what Kin made of the bill. */
export const readAnswer = (
  bill: string,
  outcome: "read" | "duplicate" | "unreadable" | "answered",
) => ({
  bill,
  result:
    outcome === "read"
      ? `${bill} saved; the owner keeps it.`
      : outcome === "duplicate"
        ? `${bill} looks like an expense already recorded.`
        : outcome === "unreadable"
          ? `${bill} saved as not read cleanly.`
          : `${bill} is already answered.`,
});

type ReadInput = {
  readonly bill: string;
  readonly readable: boolean;
  readonly read: KinBillRead;
  readonly cannotRead?: string | undefined;
};

export const answerMany = Effect.fn("KinBills.answerMany")(function* (
  turn: BillTurn,
  entries: ReadonlyArray<ReadInput>,
) {
  const { orgId } = turn;
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const bills = yield* turnBills(orgId, turn.agentId, turn.wakeupId);
      if (bills.size === 0)
        return yield* new KinChatError({
          reason: "not_allowed",
          message: "bill_read answers only the bills Kin handed you in this turn.",
        });
      const touched = new Set<string>();
      const results = yield* Effect.forEach(entries, (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              const id = input.bill.trim().toUpperCase();
              const file = bills.get(id);
              if (file === undefined)
                return yield* new KinChatError({
                  reason: "not_found",
                  message: `No bill ${id.slice(0, 8)} in this turn: ${[...bills.keys()].join(", ")}.`,
                });
              const row = yield* billRow(orgId, file.hash);
              if (row === undefined || row.state !== "reading" || row.eventId !== file.eventId)
                return readAnswer(id, "answered");
              const outcome = yield* settleRead(orgId, row, input);
              touched.add(row.batchId);
              return readAnswer(id, outcome);
            }),
          )
          .pipe(workFailure, Effect.result),
      );
      // The turn's end still decides when the card rings.
      for (const batchId of touched) yield* refreshCard(orgId, batchId, { progressOnly: true });
      return results;
    }),
  );
}, workFailure);

export const answer = Effect.fn("KinBills.answer")(function* (turn: BillTurn, input: ReadInput) {
  const [result] = yield* answerMany(turn, [input]);
  return yield* Effect.fromResult(result!);
});

type CutInput = {
  readonly bill: string;
  readonly page?: number | undefined;
  readonly boxes: ReadonlyArray<BillBox>;
};

const cutRefusal = (message: string, reason: KinChatError["reason"] = "invalid_state") =>
  new KinChatError({
    reason,
    message: `${message.endsWith(".") ? message : `${message}.`} Nothing was cut.`,
  });

const cutTarget = Effect.fn("KinBills.cutTarget")(function* (
  turn: BillTurn,
  id: string,
  requestedPage: number | undefined,
) {
  const bills = yield* turnBills(turn.orgId, turn.agentId, turn.wakeupId);
  if (bills.size === 0 || !(yield* billsOnly(turn)))
    return yield* cutRefusal(
      "bill_cut answers only the bills Kin handed this turn.",
      "not_allowed",
    );
  const file = bills.get(id);
  if (file === undefined)
    return yield* cutRefusal(
      `No bill ${id.slice(0, 8)} in this turn: ${[...bills.keys()].join(", ")}.`,
      "not_found",
    );
  const row = yield* billRow(turn.orgId, file.hash);
  if (row === undefined || row.eventId !== file.eventId)
    return yield* cutRefusal(`${id} is already answered.`);
  const pdf = isPdf(row);
  const pages = Option.getOrUndefined(decodeCutPages(row.readJson));
  if (row.state !== "reading" && !(pdf && row.state === "read" && pages !== undefined))
    return yield* cutRefusal(`${id} is already answered.`);
  if (isText(row)) return yield* cutRefusal("Only photos and PDF pages can be cut.");
  if (!pdf && requestedPage !== undefined)
    return yield* cutRefusal("Only PDFs take a page number.");
  const page = requestedPage ?? 1;
  if (pages?.includes(page) === true) return yield* cutRefusal(`Page ${page} was already cut.`);
  const parent =
    row.parentSha256 === null ? undefined : yield* billRow(turn.orgId, row.parentSha256);
  if (parent?.parentSha256 != null)
    return yield* cutRefusal(
      "A crop of a crop can't be cut again. Use bill_read and leave unreadable fields blank.",
    );
  return { row, pdf, page, pages: pages ?? [], eventId: file.eventId };
});

const encodeBox = Schema.encodeEffect(
  Schema.fromJsonString(Schema.Tuple([Schema.Int, Schema.Int, Schema.Int, Schema.Int])),
);

const prepareCut = Effect.fn("KinBills.prepareCut")(function* (
  turn: BillTurn,
  input: CutInput,
  staged: Set<string>,
) {
  const id = input.bill.trim().toUpperCase();
  const target = yield* cutTarget(turn, id, input.page);
  if (input.boxes.length === 0 || input.boxes.length > MAX_BILL_BOXES)
    return yield* cutRefusal(refuseBillPage("box").problem);
  const bytes = yield* fileBytes({
    ...target.row,
    id: target.row.attachmentId,
    type: target.row.fileType,
  }).pipe(Effect.mapError((error) => cutRefusal(error.message)));
  const result = yield* cutBillPage(
    target.pdf
      ? { kind: "pdf", page: target.page, bytes, boxes: input.boxes }
      : { kind: "photo", bytes, boxes: input.boxes },
  );
  if (result.outcome._tag === "refused") return yield* cutRefusal(result.outcome.problem);
  const store = yield* KinAttachmentStore;
  const crops = yield* Effect.forEach(result.outcome.crops, (bytes, index) =>
    Effect.gen(function* () {
      const attachmentId = yield* store
        .storeImage(bytes, "jpg")
        .pipe(Effect.mapError((error) => cutRefusal(error.message)));
      staged.add(attachmentId);
      return {
        attachmentId,
        sizeBytes: bytes.byteLength,
        index,
        hash: sha256(bytes),
        boxJson: yield* encodeBox(input.boxes[index]!).pipe(Effect.orDie),
      };
    }).pipe(Effect.uninterruptible),
  );
  return { id, input, target, crops };
}, workFailure);

const applyCut = Effect.fn("KinBills.applyCut")(function* (
  turn: BillTurn,
  { id, input, target, crops }: Effect.Success<ReturnType<typeof prepareCut>>,
) {
  const { orgId } = turn;
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* KinChatRepository;
  const { row, pdf, page, pages, eventId } = yield* cutTarget(turn, id, input.page);
  if (row.attachmentId !== target.row.attachmentId || eventId !== target.eventId)
    return yield* cutRefusal(`${id} is already answered.`);
  const chatId = KinChatId.make(row.cardChatId);
  const messageId = KinMessageId.make(`bills:${row.batchId}`);
  const card = yield* repo.getMessage({ orgId, messageId });
  if (Option.isNone(card) || card.value.status !== "posted")
    return yield* cutRefusal("The bill's card is no longer available.");

  const known = yield* alreadyAdded(
    orgId,
    crops.map((crop) => crop.hash),
  );
  const seen = new Set([row.sha256, ...(row.parentSha256 === null ? [] : [row.parentSha256])]);
  const fresh = crops.filter(({ hash }) => {
    const prior = known.get(hash);
    if (seen.has(hash) || (prior !== undefined && !prior.revive)) return false;
    seen.add(hash);
    return true;
  });
  const widget = yield* repo.getWidget({ orgId, widgetId: billWidgetId(row.batchId) });
  const sourceSlots = Option.flatMap(widget, (found) => CardJson(found.state)).pipe(
    Option.getOrUndefined,
  )?.sourceSlots;
  const names = billNames(yield* batchRows(orgId, row.batchId, { includeCut: true }), sourceSlots);
  const name = names.nameFor(row) + (pdf ? ` · page ${page}` : "");
  const files = fresh.map(({ attachmentId, sizeBytes, index, hash, boxJson }) => ({
    attachment: {
      type: "image" as const,
      id: attachmentId,
      name: `${name} · bill ${index + 1} of ${crops.length}`,
      mimeType: "image/jpeg",
      sizeBytes,
    },
    chatId,
    messageId,
    sha256: hash,
    boxJson,
  }));
  if (files.length > 0) {
    const [last] = yield* sql<{
      position: number;
    }>`SELECT COALESCE(MAX(position), ${row.position}) AS position
  FROM kin_bill_reads WHERE org_id = ${orgId} AND batch_id = ${row.batchId}
    AND parent_sha256 = ${row.sha256} AND cut_page < ${page}`;
    const after = last!.position;
    yield* sql`UPDATE kin_bill_reads SET position = position + ${files.length}
  WHERE org_id = ${orgId} AND batch_id = ${row.batchId} AND position > ${after}`;
    yield* insertBills({
      orgId,
      batchId: row.batchId,
      agentId: row.agentId,
      cardChatId: chatId,
      addedBy: row.addedBy,
      startPosition: after + 1,
      source: { sha256: row.sha256, page, eventId },
      files,
    });
    for (const file of files)
      yield* repo.attachCardFile({
        orgId,
        chatId,
        messageId,
        attachmentId: file.attachment.id,
      });
  }
  const json = yield* encodeCutPages([...pages, page]).pipe(Effect.orDie);
  yield* sql`UPDATE kin_bill_reads SET state = 'read', read_json = ${json},
  read_at = ${yield* Clock.currentTimeMillis}
WHERE org_id = ${orgId} AND sha256 = ${row.sha256}`;
  const already = crops.length - fresh.length;
  const touched = fresh.flatMap(({ hash }) => {
    const prior = known.get(hash);
    return prior === undefined || prior.batchId === row.batchId ? [] : [prior.batchId];
  });
  const pieces = `Cut ${crops.length} piece${crops.length === 1 ? "" : "s"}`;
  const whatNext =
    already > 0
      ? fresh.length > 0
        ? `${already} already added, and the rest come back as their own bills.`
        : "all were already added."
      : crops.length === 1
        ? "it comes back as its own bill."
        : "each comes back as its own bill.";
  return {
    bill: id,
    result: `${pieces}; ${whatNext}`,
    used: files.map(({ attachment }) => attachment.id),
    batchId: row.batchId,
    already,
    touched,
  };
});

export const cutMany = Effect.fn("KinBills.cutMany")(function* (
  turn: BillTurn,
  entries: ReadonlyArray<CutInput>,
) {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* KinAttachmentStore;
  const staged = new Set<string>();
  // The cutter and file writes run before the batch's transaction. Savepoints isolate individual cuts.
  return yield* Effect.gen(function* () {
    const prepared = yield* Effect.forEach(entries, (entry) =>
      prepareCut(turn, entry, staged).pipe(Effect.result),
    );
    return yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const results = yield* sql.withTransaction(
          Effect.gen(function* () {
            const batches = new Map<string, number>();
            const outcomes = yield* Effect.forEach(prepared, (entry) =>
              Effect.gen(function* () {
                if (Result.isFailure(entry)) return Result.fail(entry.failure);
                const applied = yield* sql
                  .withTransaction(applyCut(turn, entry.success))
                  .pipe(workFailure, Effect.result);
                if (Result.isSuccess(applied)) {
                  const { batchId, already, touched } = applied.success;
                  batches.set(batchId, (batches.get(batchId) ?? 0) + already);
                  for (const prior of touched) if (!batches.has(prior)) batches.set(prior, 0);
                }
                return applied;
              }),
            );
            for (const [batchId, newlyAlready] of batches)
              yield* refreshCard(turn.orgId, batchId, { newlyAlready });
            return outcomes;
          }),
        );
        return results.map((entry) =>
          Result.map(entry, ({ used, bill, result }) => {
            for (const id of used) staged.delete(id);
            return { bill, result };
          }),
        );
      }),
    );
  }).pipe(Effect.ensuring(Effect.suspend(() => store.remove([...staged]))));
}, workFailure);

export const cut = Effect.fn("KinBills.cut")(function* (turn: BillTurn, input: CutInput) {
  const [result] = yield* cutMany(turn, [input]);
  return yield* Effect.fromResult(result!);
});

/**
 * After a bills turn: a bill its turn left unanswered is unreadable once that turn's event is over
 * (a retry of a turn that showed nothing keeps it), and each batch's card is redrawn.
 */
export const turnEnded = Effect.fn("KinBills.turnEnded")(function* (
  orgId: KinOrgId,
  wakeupId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const touched = yield* sql<{ batchId: string }>`SELECT DISTINCT b.batch_id AS "batchId"
    FROM kin_bill_reads b JOIN kin_events e ON e.org_id = b.org_id AND e.event_id = b.event_id
    WHERE e.org_id = ${orgId} AND e.wakeup_id = ${wakeupId} AND e.tag = 'bills.read'
    ORDER BY b.batch_id`;
  if (touched.length === 0) return;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`UPDATE kin_bill_reads SET state = 'unreadable', problem = ${COULD_NOT_READ},
      read_at = ${now}
    WHERE org_id = ${orgId} AND state = 'reading' AND event_id IN (SELECT event_id
      FROM kin_events WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId}
        AND tag = 'bills.read' AND state IN ('done', 'failed', 'expired'))`;
  const waiting = yield* Effect.forEach(touched, ({ batchId }) => waitingRows(orgId, batchId));
  const photos = yield* preparePhotos(waiting.flat().map(rowAttachment));
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const { batchId } of touched) {
        yield* queueWaiting(orgId, batchId, photos);
        yield* refreshCard(orgId, batchId);
      }
    }),
  );
});

/** Finalize the readable files before the prompt and bill tools number them. */
export const prepareClaimedPhotos = Effect.fn("KinBills.prepareClaimedPhotos")(function* <
  Event extends Extract<KinEvent, { readonly _tag: "bills.read" }>,
>(event: Event, wakeupId: KinWakeupId) {
  if (event.photosPrepared) return event;
  const { orgId, eventId } = event;
  const sql = yield* SqlClient.SqlClient;
  const reading = sql<Row>`SELECT ${sql.literal(COLUMNS)} FROM kin_bill_reads b
    WHERE org_id = ${orgId} AND event_id = ${eventId} AND state = 'reading'
    ORDER BY position, sha256`;
  const photos = yield* preparePhotos((yield* reading).map(rowAttachment));
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [claimed] = yield* sql`SELECT 1 FROM kin_events WHERE org_id = ${orgId}
        AND event_id = ${eventId} AND wakeup_id = ${wakeupId} AND state = 'claimed'`;
      if (claimed === undefined) return undefined;
      const ready: Array<Row> = [];
      const failed: Array<string> = [];
      let shown = false;
      for (const row of yield* reading) {
        const photo = photos.get(row.attachmentId);
        if (photos.has(row.attachmentId) && photo === undefined) {
          failed.push(row.sha256);
        } else {
          ready.push(row);
          shown = (yield* indexPreview(orgId, row, photo)) || shown;
        }
      }
      if (shown) yield* touchBills(orgId);
      if (failed.length > 0) {
        const now = yield* Clock.currentTimeMillis;
        yield* sql`UPDATE kin_bill_reads SET state = 'unreadable', problem = ${COULD_NOT_READ},
            read_at = ${now}
          WHERE org_id = ${orgId} AND sha256 IN ${sql.in(failed)}`;
        yield* refreshCard(orgId, event.batchId);
      }
      // Money uploads and mail can queue before their pictures are prepared.
      const [first = [], ...rest] = billGroups(ready, photos);
      const overflow = rest.flat().map(({ sha256 }) => sha256);
      if (overflow.length > 0) {
        yield* sql`UPDATE kin_bill_reads SET state = 'waiting', event_id = NULL, reads = reads - 1
          WHERE org_id = ${orgId} AND event_id = ${eventId} AND sha256 IN ${sql.in(overflow)}`;
      }
      const keep = new Set(first.map(({ sha256 }) => sha256));
      const bills = event.bills.filter((hash) => keep.has(hash));
      if (bills.length === 0) return undefined;
      if (bills.length !== event.bills.length)
        yield* sql`UPDATE kin_events SET json = json_set(json, '$.bills', json_array(${sql.join(",", false)(bills.map((hash) => sql`${hash}`))}))
          WHERE org_id = ${orgId} AND event_id = ${eventId}`;
      return { ...event, bills, photosPrepared: true } as const;
    }),
  );
});

/** Whether a bills event still has a bill to read; one with none starts no turn. */
export const stillToRead = Effect.fn("KinBills.stillToRead")(function* (
  orgId: KinOrgId,
  bills: ReadonlyArray<string>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM kin_bill_reads WHERE org_id = ${orgId}
    AND sha256 IN ${sql.in([...bills])} AND state = 'reading' LIMIT 1`;
  return rows.length > 0;
});

/**
 * At start and after: a bill left reading whose event is over or gone (the host stopped between
 * its turn and its settling) waits again and is queued again, at most `AUTO_READS` times in all.
 */
export const sweep = Effect.fn("KinBills.sweep")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orphans = yield* sql<
    RowAttachment &
      Pick<Row, "sha256" | "batchId" | "reads" | "state" | "eventId"> & { orgId: KinOrgId }
  >`SELECT b.org_id AS "orgId", sha256, batch_id AS "batchId", reads, state, event_id AS "eventId",
      attachment_id AS "attachmentId", file_type AS "fileType", name, mime_type AS "mimeType",
      size_bytes AS "sizeBytes" FROM kin_bill_reads b
    WHERE b.state IN ('waiting', 'reading') AND NOT EXISTS (SELECT 1 FROM kin_events e
      WHERE e.org_id = b.org_id AND e.event_id = b.event_id AND e.state IN ('queued', 'claimed'))
    ORDER BY b.org_id, b.batch_id, b.position`;
  if (orphans.length === 0) return 0;
  const photos = yield* preparePhotos(
    orphans.filter((row) => row.state === "waiting" || row.reads < AUTO_READS).map(rowAttachment),
  );
  const now = yield* Clock.currentTimeMillis;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const row of orphans)
        yield* row.reads < AUTO_READS
          ? sql`UPDATE kin_bill_reads SET state = 'waiting'
              WHERE org_id = ${row.orgId} AND sha256 = ${row.sha256} AND reads = ${row.reads}
                AND event_id IS ${row.eventId} AND state = 'reading'`
          : sql`UPDATE kin_bill_reads SET state = 'unreadable', problem = ${COULD_NOT_READ},
              read_at = ${now}
              WHERE org_id = ${row.orgId} AND sha256 = ${row.sha256} AND reads = ${row.reads}
                AND event_id IS ${row.eventId} AND state = 'reading'`;
      const batches = new Map(orphans.map((row) => [`${row.orgId}\u0000${row.batchId}`, row]));
      for (const row of batches.values()) {
        const orgId = row.orgId;
        yield* queueWaiting(orgId, row.batchId, photos);
        yield* refreshCard(orgId, row.batchId);
      }
    }),
  );
  return orphans.length;
});

const decodeTax = Schema.decodeUnknownOption(Schema.fromJsonString(KinSignedMoney));
/** The expense as it stands: what a kept or dropped bill shows in place of its read. */
const expenseView = (record: RecordBrief, zone: string) => {
  const tax = typeof record.taxJson === "string" ? decodeTax(record.taxJson) : Option.none();
  return {
    key: record.key,
    rev: record.rev,
    title: record.title,
    state: record.state,
    ...(typeof record.vendor === "string" && record.vendor.trim() !== ""
      ? { vendor: record.vendor.trim().slice(0, 200) }
      : {}),
    ...(record.dateAt === null ? {} : { date: dayIn(record.dateAt, zone) }),
    ...(record.minor === null || record.currency === null
      ? {}
      : { amount: { minor: record.minor, currency: record.currency } }),
    ...(Option.isSome(tax) ? { tax: tax.value } : {}),
    ...(record.category === null ? {} : { category: record.category.slice(0, 200) }),
  };
};

const rowView = Effect.fn("KinBills.rowView")(function* (
  row: Row,
  records: ReadonlyMap<string, RecordBrief>,
  zone: string,
  attachmentsDir: string,
  name: string | undefined,
) {
  const record = row.recordId === null ? undefined : records.get(row.recordId);
  const twin = row.duplicateOf === null ? undefined : records.get(row.duplicateOf);
  const read = Option.getOrElse(decodeRead(row.readJson ?? "{}"), () => ({}));
  const attachment = rowAttachment(row);
  const photo = photoNeedsPreparation(attachment)
    ? yield* billPhotoForModel(attachmentsDir, attachment, { cachedOnly: true })
    : undefined;
  const file = {
    attachmentId: row.attachmentId,
    name: row.name,
    mimeType: row.mimeType,
    chatId: KinChatId.make(row.chatId),
    messageId: KinMessageId.make(row.messageId),
  };
  return {
    sha256: row.sha256,
    batchId: row.batchId,
    ...(name === undefined ? {} : { name }),
    file,
    ...(photo === undefined ||
    (photo.id !== row.attachmentId &&
      (photo.id !== row.previewId || photo.sizeBytes >= row.sizeBytes))
      ? {}
      : { preview: { ...file, attachmentId: photo.id, mimeType: photo.mimeType } }),
    state: shownState(row, record),
    read: read as KinBillRead,
    ...(row.problem === null ? {} : { problem: row.problem }),
    ...(row.state === "unreadable" ? checkOf(row.problem) : {}),
    ...(row.state === "unreadable" && row.problem === UNSHOWN_PHOTO ? { wrongKind: true } : {}),
    ...(record === undefined ? {} : { expense: expenseView(record, zone) }),
    ...(twin === undefined ? {} : { duplicateOf: { key: twin.key, title: twin.title } }),
    ...(row.mailFrom === null || row.mailAt === null
      ? {}
      : { mail: { from: row.mailFrom, receivedAt: iso(row.mailAt) } }),
    addedAt: iso(row.addedAt),
  } satisfies KinBillRow;
});

const PAGE = 50;
/** `kin.bills.list`: the batches, newest first, or one batch's bills in the order added. */
export const list = Effect.fn("KinBills.list")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinBillsListInput,
) {
  yield* theOwner(people, input.orgId);
  const sql = yield* SqlClient.SqlClient;
  const offset = input.cursor ?? 0;
  if (input.batchId !== undefined) {
    const all = (yield* batchRows(input.orgId, input.batchId)).filter(
      (row) => row.dismissedAt === null,
    );
    if (all.length === 0 && offset === 0) {
      const any = yield* batchRows(input.orgId, input.batchId, { includeCut: true });
      if (any.length === 0) return yield* notFound;
    }
    const nameFor = yield* sql.withTransaction(refreshCard(input.orgId, input.batchId));
    const shown = all.slice(offset, offset + PAGE);
    const zone = yield* ownerZone(input.orgId);
    const records = yield* recordsById(
      input.orgId,
      shown.flatMap((row) =>
        [row.recordId, row.duplicateOf].filter((id): id is string => id !== null),
      ),
    );
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    return {
      batches: [],
      bills: yield* Effect.forEach(
        shown,
        (row) => rowView(row, records, zone, attachmentsDir, nameFor?.(row)),
        {
          concurrency: 4,
        },
      ),
      ...(offset + PAGE < all.length ? { next: offset + PAGE } : {}),
    };
  }
  const batches = yield* sql<{
    batchId: string;
    addedBy: string;
    addedAt: number;
    chatId: string;
    widgetId: string;
  }>`SELECT batch_id AS "batchId", MIN(added_by_person_id) AS "addedBy",
      MIN(added_at) AS "addedAt", MIN(card_chat_id) AS "chatId", MIN(widget_id) AS "widgetId"
    FROM kin_bill_reads WHERE org_id = ${input.orgId}
    GROUP BY batch_id ORDER BY MIN(added_at) DESC, batch_id DESC
    LIMIT ${PAGE + 1} OFFSET ${offset}`;
  const shown = batches.slice(0, PAGE);
  const rows =
    shown.length === 0
      ? []
      : yield* sql<Row>`SELECT ${sql.literal(COLUMNS)} FROM kin_bill_reads b
          WHERE org_id = ${input.orgId} AND batch_id IN ${sql.in(shown.map((one) => one.batchId))}
            AND dismissed_at IS NULL AND ${sql.literal(NOT_CUT)}
          ORDER BY batch_id, position`;
  const records = yield* recordsById(
    input.orgId,
    rows.flatMap((row) => (row.recordId === null ? [] : [row.recordId])),
  );
  return {
    batches: shown.map((batch) => {
      const mine = rows.filter((row) => row.batchId === batch.batchId);
      const count = (state: KinBillState) =>
        mine.filter((row) => shownState(row, records.get(row.recordId ?? "")) === state).length;
      return {
        batchId: batch.batchId,
        addedBy: KinPersonId.make(batch.addedBy),
        addedAt: iso(batch.addedAt),
        chatId: KinChatId.make(batch.chatId),
        widgetId: KinWidgetId.make(batch.widgetId),
        bills: mine.length,
        states: {
          reading: count("reading"),
          read: count("read"),
          kept: count("kept"),
          dropped: count("dropped"),
          duplicate: count("duplicate"),
          unreadable: count("unreadable"),
          check: mine.filter(
            (row) =>
              shownState(row, records.get(row.recordId ?? "")) === "unreadable" &&
              READ_CLEAN.has(row.problem ?? ""),
          ).length,
        },
      };
    }),
    bills: [],
    ...(batches.length > PAGE ? { next: offset + PAGE } : {}),
  };
}, workFailure);

/**
 * `kin.bills.keepRead`: keeps, as `kin.work.confirm` does, every expense of the batch still a
 * suggestion whose bill was read cleanly; the rest are skipped with why. One transaction.
 */
export const keepRead = Effect.fn("KinBills.keepRead")(
  function* (people: ReadonlyArray<PersonIdentity>, input: KinBillsKeepReadInput) {
    const person = yield* theOwner(people, input.orgId);
    const inputHash =
      input.expect === undefined
        ? input.batchId
        : sha256(yield* encodeStored([input.batchId, input.expect.count, input.expect.revision]));
    const stored = yield* storedAnswer(
      input.orgId,
      person.personId,
      "keepRead",
      input.clientRequestId,
      inputHash,
    );
    if (stored !== undefined) return yield* decodeKept(stored);
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const again = yield* storedAnswer(
          input.orgId,
          person.personId,
          "keepRead",
          input.clientRequestId,
          inputHash,
        );
        if (again !== undefined) return yield* decodeKept(again);
        const rows = (yield* batchRows(input.orgId, input.batchId)).filter(
          (row) => row.dismissedAt === null,
        );
        const records = yield* recordsById(
          input.orgId,
          rows.flatMap((row) => (row.recordId === null ? [] : [row.recordId])),
        );
        const eligible = keepableRecords(rows, records);
        if (input.expect !== undefined) {
          const current = keepableSummary(eligible);
          if (input.expect.count !== current.count || input.expect.revision !== current.revision)
            return yield* new KinBillsKeepReadChanged({
              message: "These bills changed since this card was drawn: look again.",
            });
        }
        if (rows.length === 0) return yield* notFound;
        const kept: Array<string> = [];
        const skipped: Array<KinBillsKeepReadResult["skipped"][number]> = [];
        for (const row of rows) {
          const record = row.recordId === null ? undefined : records.get(row.recordId);
          const shown = shownState(row, record);
          if (shown === "kept" || shown === "dropped") continue;
          const ready = eligible.get(row.sha256);
          if (ready !== undefined) {
            yield* confirm(people, { orgId: input.orgId, key: ready.key, rev: ready.rev }).pipe(
              Effect.provideService(DeferCardRefresh, true),
            );
            kept.push(ready.key);
            continue;
          }
          const why =
            row.state !== "read" || record === undefined
              ? shown === "reading"
                ? "Still being read."
                : shown === "duplicate"
                  ? "It looks like an expense already recorded."
                  : shown === "unreadable"
                    ? READ_CLEAN.get(row.problem ?? "") === "amount"
                      ? "Its amount needs a check."
                      : READ_CLEAN.has(row.problem ?? "")
                        ? "Its date needs a check."
                        : "It wasn't read cleanly."
                    : "It has no expense of its own."
              : "Its state was changed.";
          skipped.push({
            sha256: row.sha256,
            ...(record === undefined ? {} : { key: record.key }),
            ...(shown === "unreadable" && READ_CLEAN.has(row.problem ?? "") ? { check: true } : {}),
            why,
          });
        }
        const result = { kept, skipped } satisfies KinBillsKeepReadResult;
        yield* keepAnswer(
          input.orgId,
          person.personId,
          "keepRead",
          input.clientRequestId,
          inputHash,
          result,
        );
        yield* refreshCard(input.orgId, input.batchId);
        return result;
      }),
    );
  },
  Effect.catchIf(
    (error) => error._tag !== "KinBillsKeepReadChanged",
    (error) => workFailure(Effect.fail(error)),
  ),
);

/** `kin.bills.addAnyway`: a duplicate's own suggested expense, as a clean read would have made. */
export const addAnyway = Effect.fn("KinBills.addAnyway")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinBillsAddAnywayInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const requestHash = sha256(`${person.personId}:${input.clientRequestId}`);
  const stored = yield* storedAnswer(
    input.orgId,
    person.personId,
    "addAnyway",
    input.clientRequestId,
    input.sha256,
  );
  if (stored !== undefined) return yield* decodeAnyway(stored);
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const row = yield* billRow(input.orgId, input.sha256);
      if (row === undefined) return yield* notFound;
      if (row.state !== "duplicate" || row.recordId !== null)
        return yield* invalid("Only a bill that looks like a duplicate is added anyway.");
      const read = Option.getOrElse(decodeRead(row.readJson ?? "{}"), () => ({})) as KinBillRead;
      const amount = plainNumber(read.amount, read.currency);
      const money =
        amount === undefined || read.currency === undefined
          ? undefined
          : parseKinMoney(amount, read.currency);
      if (money === undefined || "error" in money) return yield* invalid("Its amount is unread.");
      const zone = yield* ownerZone(input.orgId);
      const made = yield* makeExpense(input.orgId, row, read, money.money, zone, { requestHash });
      yield* sql`UPDATE kin_bill_reads SET state = 'read', record_id = ${made}
        WHERE org_id = ${input.orgId} AND sha256 = ${row.sha256}`;
      const [record] = yield* sql<{ key: string }>`SELECT key FROM kin_records
        WHERE org_id = ${input.orgId} AND record_id = ${made}`;
      const result = { expense: record!.key };
      yield* keepAnswer(
        input.orgId,
        person.personId,
        "addAnyway",
        input.clientRequestId,
        input.sha256,
        result,
      );
      yield* refreshCard(input.orgId, row.batchId);
      return result;
    }),
  );
}, workFailure);

/** `kin.bills.dismiss`: a duplicate or unreadable bill with no expense leaves the list; the file stays. */
export const dismiss = Effect.fn("KinBills.dismiss")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinBillsDismissInput,
) {
  yield* theOwner(people, input.orgId);
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const row = yield* billRow(input.orgId, input.sha256);
      if (row === undefined) return yield* notFound;
      if (row.dismissedAt !== null) return { dismissed: true };
      if ((row.state !== "duplicate" && row.state !== "unreadable") || row.recordId !== null)
        return yield* invalid("Only a duplicate or an unread bill is dismissed; drop its expense.");
      yield* sql`UPDATE kin_bill_reads SET dismissed_at = ${yield* Clock.currentTimeMillis}
        WHERE org_id = ${input.orgId} AND sha256 = ${row.sha256}`;
      yield* refreshCard(input.orgId, row.batchId);
      return { dismissed: true };
    }),
  );
}, workFailure);

const legacyCurrencyRead = (row: Row) => {
  if (!/^Couldn't read: currency(?:\. |$)/u.test(row.problem ?? "")) return undefined;
  const read = Option.getOrUndefined(decodeRead(row.readJson ?? "{}"));
  return read?.vendor !== undefined &&
    read.date !== undefined &&
    read.amount !== undefined &&
    read.currency === undefined
    ? read
    : undefined;
};

/** `kin.bills.readAgain`: settle old currency-only failures; queue other unreadable bills again. */
export const readAgain = Effect.fn("KinBills.readAgain")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinBillsReadAgainInput,
) {
  yield* theOwner(people, input.orgId);
  if ((input.sha256 === undefined) === (input.batchId === undefined))
    return yield* invalid("Name one bill or one batch.");
  const sql = yield* SqlClient.SqlClient;
  const selected =
    input.sha256 !== undefined
      ? billRow(input.orgId, input.sha256).pipe(
          Effect.map((row) => (row === undefined ? [] : [row])),
        )
      : batchRows(input.orgId, input.batchId!);
  const canReadAgain = (row: Row) =>
    row.state === "unreadable" && row.recordId === null && row.dismissedAt === null;
  const candidates = (yield* selected).filter(canReadAgain);
  const photos = yield* preparePhotos(
    candidates.filter((row) => legacyCurrencyRead(row) === undefined).map(rowAttachment),
  );
  const readsByAttachment = new Map(candidates.map((row) => [row.attachmentId, row.reads]));
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* selected;
      if (rows.length === 0) return yield* notFound;
      const again = rows.filter(
        (row) => readsByAttachment.get(row.attachmentId) === row.reads && canReadAgain(row),
      );
      const waiting: Array<Row> = [];
      for (const row of again) {
        const read = legacyCurrencyRead(row);
        if (read === undefined) waiting.push(row);
        else yield* settleRead(input.orgId, row, { readable: true, read });
      }
      if (waiting.length > 0) {
        yield* sql`UPDATE kin_bill_reads SET state = 'waiting', problem = NULL
          WHERE org_id = ${input.orgId} AND sha256 IN ${sql.in(waiting.map((row) => row.sha256))}
            AND state = 'unreadable' AND record_id IS NULL`;
        for (const batchId of new Set(waiting.map((row) => row.batchId)))
          yield* queueWaiting(input.orgId, batchId, photos);
      }
      for (const batchId of new Set(again.map((row) => row.batchId)))
        yield* refreshCard(input.orgId, batchId);
      return { queued: waiting.length };
    }),
  );
}, workFailure);

/**
 * A new expense typed by hand with a bill's file as its receipt answers that bill: the list shows
 * it as that expense from then on. Run in the expense's own transaction.
 */
export const answeredByHand = Effect.fn("KinBills.answeredByHand")(function* (
  orgId: KinOrgId,
  recordId: string,
  attachmentIds: ReadonlyArray<string>,
) {
  if (attachmentIds.length === 0) return;
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* Effect.serviceOption(KinChatRepository);
  const hub = yield* Effect.serviceOption(KinChatHub);
  const rows = yield* sql<{ batchId: string }>`UPDATE kin_bill_reads SET record_id = ${recordId},
      state = 'read'
    WHERE org_id = ${orgId} AND attachment_id IN ${sql.in([...attachmentIds])}
      AND record_id IS NULL AND state IN ('duplicate', 'unreadable')
    RETURNING batch_id AS "batchId"`;
  if (Option.isNone(repo) || Option.isNone(hub)) return;
  for (const batchId of new Set(rows.map((row) => row.batchId)))
    yield* refreshCard(orgId, batchId).pipe(
      Effect.provideService(KinChatRepository, repo.value),
      Effect.provideService(KinChatHub, hub.value),
    );
});
