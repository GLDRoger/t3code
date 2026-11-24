// @effect-diagnostics nodeBuiltinImport:off -- a file's sha256 over bytes already read; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import {
  type ChatAttachment,
  KIN_BILL_BATCH_CARD,
  KinAgentId,
  type KinAttachment,
  KinBillBatchCard,
  type KinBillRead,
  type KinBillRow,
  type KinBillsAddAnywayInput,
  KinBillsAddAnywayResult,
  KinBillsAddResult,
  type KinBillsDismissInput,
  type KinBillsKeepReadInput,
  KinBillsKeepReadResult,
  type KinBillsListInput,
  type KinBillsReadAgainInput,
  type KinBillState,
  KinChatError,
  KinChatId,
  KinMessageId,
  type KinOrgId,
  KinPersonId,
  KinWidgetId,
  parseKinMoney,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { PendingUploadOwner } from "../../assets/AttachmentUpload.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import { KinAttachmentStore } from "../chat/KinAttachmentStore.ts";
import { KinChatHub } from "../chat/KinChatHub.ts";
import { KinChatRepository } from "../chat/KinChatRepository.ts";
import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { hashedEventId } from "../lead/eventIds.ts";
import { KinEventQueue } from "../lead/KinEventQueue.ts";
import { CHIEF_OF_STAFF_DOMAIN, liveLead } from "../lead/orgLeads.ts";
import { ownerLevelSql } from "../people/KinAccess.ts";
import { directChatWith } from "../triggers/deferralOrigin.ts";
import { countryFirst } from "./companyProfile.ts";
import { KinRecords, type Writer } from "./KinRecords.ts";
import { dayIn } from "./money.ts";
import { fold } from "./nameMatch.ts";
import { confirm, theOwner } from "./ownerWork.ts";
import { endOfDay, ownerZone, workFailure } from "./recordRows.ts";
import { presetList } from "./registers.ts";
import { notAVendor } from "./vendorName.ts";

/**
 * Bills in bulk. Kin keeps one row per file's bytes from the moment it is added; the reading
 * agent reads each once in quiet turns Kin queues (`bills.read`), and everything after a read is
 * this file's: the duplicate check, one suggested expense per bill read cleanly, the card.
 */

const FINANCE_DOMAIN = "finance";
/** Bills a quiet turn reads at most, within the turn's image budget (`TURN_FILES`). */
const BILLS_PER_TURN = 5;
const GROUP_IMAGE_BYTES = 20 * 1024 * 1024;
/** Kin queues a bill on its own at most this often; the owner's Read again is beside it. */
const AUTO_READS = 2;
const COULD_NOT_READ = "Kin could not read this one";
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

const extensionOf = (name: string) => name.split(".").at(-1)?.toLowerCase() ?? "";
const mimeOf = (file: Pick<ChatAttachment, "mimeType">) =>
  file.mimeType.toLowerCase().split(";", 1)[0]?.trim() ?? "";
const isPdf = (file: Pick<ChatAttachment, "mimeType" | "name">) =>
  mimeOf(file) === "application/pdf" || extensionOf(file.name) === "pdf";
/** A bill is a photo or a PDF; anything else is refused on its own. */
const isBillFile = (file: Pick<ChatAttachment, "type" | "mimeType" | "name">) =>
  file.type === "image" || mimeOf(file).startsWith("image/") || isPdf(file);
const NOT_A_BILL = "Only photos and PDFs are read as bills.";

const ReadJson = Schema.fromJsonString(
  Schema.Struct({
    vendor: Schema.optional(Schema.String),
    date: Schema.optional(Schema.String),
    amount: Schema.optional(Schema.String),
    currency: Schema.optional(Schema.String),
    tax: Schema.optional(Schema.String),
    category: Schema.optional(Schema.String),
    number: Schema.optional(Schema.String),
  }),
);
const encodeRead = Schema.encodeEffect(ReadJson);
const decodeRead = Schema.decodeUnknownOption(ReadJson);
const CardJson = Schema.decodeUnknownOption(KinBillBatchCard);
const Stored = Schema.fromJsonString(Schema.Unknown);
const decodeStored = Schema.decodeEffect(Stored);
const encodeStored = Schema.encodeEffect(Stored);
const decodeAdded = Schema.decodeUnknownEffect(KinBillsAddResult);
const decodeKept = Schema.decodeUnknownEffect(KinBillsKeepReadResult);
const decodeAnyway = Schema.decodeUnknownEffect(KinBillsAddAnywayResult);

type Row = {
  readonly sha256: string;
  readonly attachmentId: string;
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
};
const COLUMNS = `sha256, attachment_id AS "attachmentId", chat_id AS "chatId",
  message_id AS "messageId", name, file_type AS "fileType", mime_type AS "mimeType",
  size_bytes AS "sizeBytes",
  batch_id AS "batchId", position, agent_id AS "agentId", card_chat_id AS "cardChatId",
  widget_id AS "widgetId", added_by_person_id AS "addedBy", added_at AS "addedAt", state,
  event_id AS "eventId", reads, read_json AS "readJson", problem, duplicate_of AS "duplicateOf",
  record_id AS "recordId", dismissed_at AS "dismissedAt"`;

const batchRows = Effect.fn("KinBills.batchRows")(function* (orgId: KinOrgId, batchId: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<Row>`SELECT ${sql.literal(COLUMNS)} FROM kin_bill_reads
    WHERE org_id = ${orgId} AND batch_id = ${batchId} ORDER BY position, sha256`;
});
const billRow = Effect.fn("KinBills.billRow")(function* (orgId: KinOrgId, hash: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<Row>`SELECT ${sql.literal(COLUMNS)} FROM kin_bill_reads
    WHERE org_id = ${orgId} AND sha256 = ${hash}`;
  return row;
});

/** The company's live Finance agent, else its Chief of staff, else its first live agent. */
const readerOf = Effect.fn("KinBills.readerOf")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const finance = yield* liveLead(sql, orgId, { prefer: FINANCE_DOMAIN });
  if (finance === undefined || finance.domain === FINANCE_DOMAIN) return finance;
  return yield* liveLead(sql, orgId, { prefer: CHIEF_OF_STAFF_DOMAIN });
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

/** The sha256 of a kept file's bytes, read from where Kin stored it: never a client's word. */
const fileHash = Effect.fn("KinBills.fileHash")(function* (attachment: ChatAttachment) {
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = resolveAttachmentPath({ attachmentsDir, attachment });
  if (path === null) return yield* invalid(`${attachment.name.slice(0, 80)} couldn't be read.`);
  const bytes = yield* fs
    .readFile(path)
    .pipe(Effect.mapError(() => invalid(`${attachment.name.slice(0, 80)} couldn't be read.`)));
  return sha256(bytes);
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

const countText = (count: number) => `${count} bill${count === 1 ? "" : "s"}`;
/** The card's words, the whole truth for a client that draws no card. */
const cardText = (card: Omit<KinBillBatchCard, "text">) => {
  if (card.status === "reading") return `Reading ${countText(card.total)}: ${card.done} done.`;
  const parts = [
    card.counts.read > 0 ? `${card.counts.read} read` : undefined,
    card.counts.duplicate > 0
      ? `${card.counts.duplicate} ${card.counts.duplicate === 1 ? "looks like a duplicate" : "look like duplicates"}`
      : undefined,
    card.counts.unreadable > 0 ? `${card.counts.unreadable} couldn't be read` : undefined,
    card.counts.already > 0
      ? `${card.counts.already} ${card.counts.already === 1 ? "was" : "were"} already added`
      : undefined,
    (card.refused ?? 0) > 0
      ? `${card.refused} ${card.refused === 1 ? "isn't a photo or PDF" : "aren't photos or PDFs"}`
      : undefined,
  ].filter((part) => part !== undefined);
  return `${countText(card.total)}: ${parts.length === 0 ? "none to read" : parts.join(", ")}.`;
};

/**
 * Posts the batch's card, Kin's own, for the adder alone, silent while Kin reads; the bills' files
 * ride on it when they were added from Money, so every rule for a chat's files holds for them.
 */
const postCard = Effect.fn("KinBills.postCard")(function* (input: {
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId;
  readonly batchId: string;
  readonly card: KinBillBatchCard;
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

/** Queues a batch's waiting bills to its reader, a few a quiet turn, below anyone's message. */
const queueWaiting = Effect.fn("KinBills.queueWaiting")(function* (
  orgId: KinOrgId,
  batchId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const queue = yield* KinEventQueue;
  const waiting = (yield* batchRows(orgId, batchId)).filter((row) => row.state === "waiting");
  const groups: Array<Array<Row>> = [];
  let bytes = 0;
  for (const row of waiting) {
    const last = groups.at(-1);
    const image = !isPdf(row);
    if (
      last === undefined ||
      last.length >= BILLS_PER_TURN ||
      (image && bytes + row.sizeBytes > GROUP_IMAGE_BYTES)
    ) {
      groups.push([row]);
      bytes = image ? row.sizeBytes : 0;
    } else {
      last.push(row);
      if (image) bytes += row.sizeBytes;
    }
  }
  const now = yield* Clock.currentTimeMillis;
  for (const group of groups) {
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
      const next = yield* readerOf(orgId);
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
  return waiting.length;
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
  readonly state: string;
  readonly confirmed: number;
};
const recordsById = Effect.fn("KinBills.recordsById")(function* (
  orgId: KinOrgId,
  ids: ReadonlyArray<string>,
) {
  if (ids.length === 0) return new Map<string, RecordBrief>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<RecordBrief>`SELECT record_id AS "recordId", key, rev, title, state,
      confirmed FROM kin_records
    WHERE org_id = ${orgId} AND record_id IN ${sql.in([...new Set(ids)])} ORDER BY record_id`;
  return new Map(rows.map((row) => [row.recordId, row]));
});

/**
 * Redraws a batch's card from its rows: progress while Kin reads, the counts when done. Once done
 * it waits on the adder while a bill still needs them, which rings them once; else it closes.
 */
const refreshCard = Effect.fn("KinBills.refreshCard")(function* (orgId: KinOrgId, batchId: string) {
  const repo = yield* KinChatRepository;
  const hub = yield* KinChatHub;
  const sql = yield* SqlClient.SqlClient;
  const found = yield* repo.getWidget({ orgId, widgetId: billWidgetId(batchId) });
  if (Option.isNone(found)) return;
  const stored = Option.getOrUndefined(CardJson(found.value.state));
  if (stored === undefined) return;
  const rows = yield* batchRows(orgId, batchId);
  const records = yield* recordsById(
    orgId,
    rows.flatMap((row) => (row.recordId === null ? [] : [row.recordId])),
  );
  const pending = rows.filter((row) => row.state === "waiting" || row.state === "reading").length;
  const counts = {
    read: rows.filter((row) => row.state === "read").length,
    duplicate: rows.filter((row) => row.state === "duplicate").length,
    unreadable: rows.filter((row) => row.state === "unreadable").length,
    already: stored.counts.already,
  };
  const total = rows.length + counts.already;
  const status = pending === 0 ? ("done" as const) : ("reading" as const);
  const base = { ...stored, status, total, done: total - pending, counts };
  const card: KinBillBatchCard = { ...base, text: cardText(base) };
  const open = rows.some((row) => {
    if (row.dismissedAt !== null) return false;
    const shown = shownState(row, records.get(row.recordId ?? ""));
    return shown === "read" || shown === "duplicate" || shown === "unreadable";
  });
  const awaiting = status === "done" && open ? [KinPersonId.make(stored.addedBy)] : [];
  const closed = status === "done" && !open;
  if (
    stored.text === card.text &&
    stored.status === card.status &&
    stored.done === card.done &&
    stored.counts.read === card.counts.read &&
    stored.counts.duplicate === card.counts.duplicate &&
    stored.counts.unreadable === card.counts.unreadable &&
    found.value.awaiting.length === awaiting.length &&
    (found.value.closedAt !== null) === closed
  )
    return;
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
});

/** Bills stored and waiting to be queued, in one transaction with their card. */
const insertBills = Effect.fn("KinBills.insertBills")(function* (input: {
  readonly orgId: KinOrgId;
  readonly batchId: string;
  readonly agentId: string;
  readonly cardChatId: KinChatId;
  readonly addedBy: string;
  readonly files: ReadonlyArray<{
    readonly attachment: KinAttachment;
    readonly sha256: string;
    readonly chatId: string;
    readonly messageId: string;
  }>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  const added: Array<string> = [];
  for (const [position, file] of input.files.entries()) {
    const inserted = yield* sql`INSERT INTO kin_bill_reads (org_id, sha256, attachment_id, chat_id,
        message_id, name, file_type, mime_type, size_bytes, batch_id, position, agent_id,
        card_chat_id, widget_id, added_by_person_id, added_at, state)
      VALUES (${input.orgId}, ${file.sha256}, ${file.attachment.id}, ${file.chatId},
        ${file.messageId}, ${file.attachment.name}, ${file.attachment.type},
        ${file.attachment.mimeType},
        ${file.attachment.sizeBytes}, ${input.batchId}, ${position}, ${input.agentId},
        ${input.cardChatId}, ${billWidgetId(input.batchId)}, ${input.addedBy}, ${now}, 'waiting')
      ON CONFLICT DO NOTHING RETURNING sha256`;
    if (inserted.length > 0) added.push(file.sha256);
  }
  return added;
});

/** The files already a bill in this company, with the expense made for each, if any. */
const alreadyAdded = Effect.fn("KinBills.alreadyAdded")(function* (
  orgId: KinOrgId,
  hashes: ReadonlyArray<string>,
) {
  if (hashes.length === 0) return new Map<string, string | undefined>();
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ sha256: string; key: string | null }>`SELECT b.sha256, r.key
    FROM kin_bill_reads b LEFT JOIN kin_records r ON r.org_id = b.org_id
      AND r.record_id = b.record_id
    WHERE b.org_id = ${orgId} AND b.sha256 IN ${sql.in([...new Set(hashes)])} ORDER BY b.sha256`;
  return new Map(rows.map((row) => [row.sha256, row.key ?? undefined]));
});

type Prepared = {
  readonly accepted: ReadonlyArray<{ readonly attachment: KinAttachment; readonly sha256: string }>;
  readonly refused: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
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
  const already: Array<{ name: string; sha256: string; expense?: string }> = [];
  for (const file of input.prepared.accepted) {
    if (known.has(file.sha256) || seen.has(file.sha256)) {
      const expense = known.get(file.sha256);
      already.push({
        name: file.attachment.name,
        sha256: file.sha256,
        ...(expense === undefined ? {} : { expense }),
      });
      continue;
    }
    seen.add(file.sha256);
    fresh.push(file);
  }
  const base = {
    batchId: input.batchId,
    status: "reading" as const,
    total: fresh.length + already.length,
    done: already.length,
    counts: { read: 0, duplicate: 0, unreadable: 0, already: already.length },
    ...(input.prepared.refused.length === 0 ? {} : { refused: input.prepared.refused.length }),
    addedBy: KinPersonId.make(input.addedBy),
  };
  // Nothing new to read is no decision: no card, only the answer.
  const posted =
    fresh.length === 0
      ? undefined
      : yield* postCard({
          orgId: input.orgId,
          chatId: input.cardChatId,
          batchId: input.batchId,
          card: { ...base, text: cardText(base) },
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
  });
  yield* queueWaiting(input.orgId, input.batchId);
  return {
    batchId: input.batchId,
    ...(posted === undefined ? {} : posted),
    added: fresh
      .filter((file) => added.includes(file.sha256))
      .map((file) => ({ name: file.attachment.name, sha256: file.sha256 })),
    already,
    refused: input.prepared.refused,
  } satisfies KinBillsAddResult;
});

const prepareFiles = Effect.fn("KinBills.prepareFiles")(function* (
  files: ReadonlyArray<KinAttachment>,
) {
  const accepted: Array<Prepared["accepted"][number]> = [];
  for (const attachment of files)
    accepted.push({ attachment, sha256: yield* fileHash(attachment) });
  return accepted;
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
  const reader = yield* readerOf(input.orgId);
  if (reader === undefined) return yield* invalid("This company has no agent to read bills yet.");
  const chatId = yield* cardChat(input.orgId, person.personId, reader.agentId);
  if (chatId === undefined)
    return yield* invalid(`Open your chat with ${reader.name} first: its card goes there.`);
  const refused = input.attachments
    .filter((file) => !isBillFile(file))
    .map((file) => ({ name: file.name, reason: NOT_A_BILL }));
  const wanted = input.attachments.filter(isBillFile);
  const store = yield* Effect.serviceOption(KinAttachmentStore);
  if (wanted.length > 0 && Option.isNone(store)) return yield* invalid("Files are unavailable.");
  const claimed =
    wanted.length === 0 || Option.isNone(store)
      ? undefined
      : yield* store.value.claim(wanted, uploader);
  const sql = yield* SqlClient.SqlClient;
  const batchId = batchIdFor(`${input.orgId}:${person.personId}:${input.clientRequestId}`);
  const accepted = yield* prepareFiles(claimed?.attachments ?? []).pipe(
    Effect.onError(() =>
      claimed === undefined || Option.isNone(store) ? Effect.void : store.value.release(claimed),
    ),
  );
  const result = yield* sql
    .withTransaction(
      Effect.gen(function* () {
        const again = yield* storedAnswer(
          input.orgId,
          person.personId,
          "add",
          input.clientRequestId,
          inputHash,
        );
        if (again !== undefined) return yield* decodeAdded(again);
        const made = yield* startBatch({
          orgId: input.orgId,
          batchId,
          agentId: reader.agentId,
          cardChatId: chatId,
          addedBy: person.personId,
          prepared: { accepted, refused },
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
        return made;
      }),
    )
    .pipe(
      Effect.onError(() =>
        claimed === undefined || Option.isNone(store) ? Effect.void : store.value.release(claimed),
      ),
    );
  if (claimed !== undefined && Option.isSome(store)) {
    // Files whose bytes were already a bill, or twice in this add, are on no message: they go.
    const kept = new Set(result.added.map((file) => file.sha256));
    const onCard = new Map<string, string>();
    for (const file of accepted)
      if (kept.has(file.sha256) && !onCard.has(file.sha256))
        onCard.set(file.sha256, file.attachment.id);
    const ids = new Set(onCard.values());
    yield* store.value.remove(
      accepted.filter((file) => !ids.has(file.attachment.id)).map((file) => file.attachment.id),
    );
    yield* store.value.discardPending(wanted);
  }
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
  const accepted = yield* prepareFiles(wanted);
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const again = yield* storedAnswer(input.orgId, personId, "add", requestId, input.messageId);
      if (again !== undefined) return yield* decodeAdded(again);
      const made = yield* startBatch({
        orgId: input.orgId,
        batchId: batchIdFor(`${input.orgId}:${requestId}`),
        agentId: input.agentId,
        cardChatId,
        addedBy: personId,
        prepared: { accepted, refused },
        source: { _tag: "message", chatId: input.chatId, messageId: input.messageId },
      });
      yield* keepAnswer(input.orgId, personId, "add", requestId, input.messageId, made);
      return made;
    }),
  );
}, workFailure);

/** A turn's bills, each by the short id the turn names it with: B1, B2… in the event's order. */
const turnBills = Effect.fn("KinBills.turnBills")(function* (
  orgId: KinOrgId,
  agentId: string,
  wakeupId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const hashes = yield* sql<{ hash: string }>`SELECT j.value AS hash
    FROM kin_events e, json_each(e.json, '$.bills') j
    WHERE e.org_id = ${orgId} AND e.agent_id = ${agentId} AND e.wakeup_id = ${wakeupId}
      AND e.tag = 'bills.read' AND e.state = 'claimed'
    ORDER BY e.priority, e.received_at, e.event_id, j.key`;
  const byId = new Map<string, string>();
  hashes.forEach((row, index) => byId.set(`B${index + 1}`, row.hash));
  return byId;
});

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
  const read = answer.read;
  const json = yield* encodeRead(read).pipe(Effect.orDie);
  const missing: Array<string> = [];
  if (read.vendor === undefined || notAVendor(read.vendor)) missing.push("who was paid");
  if (read.date === undefined) missing.push("date");
  if (read.amount === undefined) missing.push("amount");
  if (read.currency === undefined) missing.push("currency");
  const parsed =
    read.amount === undefined || read.currency === undefined
      ? undefined
      : parseKinMoney(read.amount, read.currency);
  if (parsed !== undefined && "error" in parsed) missing.push("amount");
  else if (parsed !== undefined && parsed.money.currency !== read.currency)
    missing.push("currency");
  const money = parsed !== undefined && "money" in parsed ? parsed.money : undefined;
  const unreadable = (problem: string) =>
    sql`UPDATE kin_bill_reads SET state = 'unreadable', read_json = ${json}, problem = ${problem},
        read_at = ${now}
      WHERE org_id = ${orgId} AND sha256 = ${row.sha256}`.pipe(Effect.as("unreadable" as const));
  if (!answer.readable) return yield* unreadable(answer.cannotRead?.trim() || COULD_NOT_READ);
  if (missing.length > 0)
    return yield* unreadable(
      `Couldn't read: ${[...new Set(missing)].join(", ")}${answer.cannotRead === undefined ? "" : `. ${answer.cannotRead.trim()}`}`.slice(
        0,
        300,
      ),
    );
  if (money === undefined || read.vendor === undefined || read.date === undefined)
    return yield* unreadable(COULD_NOT_READ);
  if (money.minor === 0) return yield* unreadable("It is for 0");
  const zone = yield* ownerZone(orgId);
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
    dateAt: number;
  }>`SELECT record_id AS "recordId", title, json_extract(fields_json, '$.vendor') AS vendor,
      date_at AS "dateAt"
    FROM kin_records
    WHERE org_id = ${orgId} AND register_id = 'expenses' AND state != 'dropped'
      AND amount_minor = ${money.minor} AND currency = ${money.currency}
      AND date_at BETWEEN ${at - 2 * 86_400_000} AND ${at + 2 * 86_400_000}
      AND origin_key != ${`bill:${hash}`}
    ORDER BY created_at, record_id`;
  const payee = fold(vendor);
  return rows.find(
    (one) =>
      dayIn(one.dateAt, zone) === day &&
      payee !== "" &&
      (typeof one.vendor === "string" ? fold(one.vendor) === payee : fold(one.title) === payee),
  )?.recordId;
});

const titleOf = (vendor: string, day: string) => {
  const month = MONTHS[Number(day.slice(5, 7)) - 1] ?? "";
  return `${vendor.trim().slice(0, 240)}, ${month} ${day.slice(0, 4)}`;
};

/**
 * The bill's one suggested expense: Paid, the file its receipt, funding and who paid unset. Kin
 * writes it for the person who added the bill; its notes say so. A retry finds it by its key.
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
  const tax =
    read.tax === undefined || read.currency === undefined
      ? undefined
      : parseKinMoney(read.tax, read.currency);
  const [adder] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${row.addedBy}`;
  const writer: Writer = {
    actor: { _tag: "system" },
    via: "owner",
    chatId: KinChatId.make(row.cardChatId),
    askedBy: KinPersonId.make(row.addedBy),
  };
  const { row: made } = yield* records.create(orgId, writer, {
    list: "expenses",
    originKey: `bill:${row.sha256}`,
    ...(how === "auto" ? {} : { requestHash: how.requestHash }),
    title: titleOf(read.vendor ?? "", read.date ?? ""),
    owner: { _tag: "person", personId: KinPersonId.make(row.addedBy) },
    state: "done",
    amount: money,
    dateAt: endOfDay(read.date ?? "", zone),
    dateAllDay: true,
    ...(category === undefined ? {} : { category }),
    fields: {
      vendor: read.vendor ?? "",
      receipt: [row.attachmentId],
      ...(tax !== undefined && "money" in tax && tax.money.minor !== 0 ? { tax: tax.money } : {}),
    },
    notes: `Read by Kin from a photo ${adder?.name ?? "someone"} added.`,
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

/** `bill_read`: one answer for a bill this turn was handed, settled at once by plain rules. */
export const answer = Effect.fn("KinBills.answer")(function* (
  turn: { readonly orgId: KinOrgId; readonly agentId: string; readonly wakeupId: string },
  input: {
    readonly bill: string;
    readonly readable: boolean;
    readonly read: KinBillRead;
    readonly cannotRead?: string | undefined;
  },
) {
  const bills = yield* turnBills(turn.orgId, turn.agentId, turn.wakeupId);
  if (bills.size === 0)
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "bill_read answers only the bills Kin handed you in this turn.",
    });
  const id = input.bill.trim().toUpperCase();
  const hash = bills.get(id);
  if (hash === undefined)
    return yield* new KinChatError({
      reason: "not_found",
      message: `No bill ${id.slice(0, 8)} in this turn: ${[...bills.keys()].join(", ")}.`,
    });
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const row = yield* billRow(turn.orgId, hash);
      if (row === undefined || row.state !== "reading") return readAnswer(id, "answered");
      return readAnswer(id, yield* settleRead(turn.orgId, row, input));
    }),
  );
}, workFailure);

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
  yield* sql.withTransaction(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* sql`UPDATE kin_bill_reads SET state = 'unreadable', problem = ${COULD_NOT_READ},
          read_at = ${now}
        WHERE org_id = ${orgId} AND state = 'reading' AND event_id IN (SELECT event_id
          FROM kin_events WHERE org_id = ${orgId} AND wakeup_id = ${wakeupId}
            AND tag = 'bills.read' AND state IN ('done', 'failed', 'expired'))`;
      for (const { batchId } of touched) yield* refreshCard(orgId, batchId);
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
  const orphans = yield* sql<{ orgId: string; sha256: string; batchId: string; reads: number }>`
    SELECT b.org_id AS "orgId", b.sha256, b.batch_id AS "batchId", b.reads FROM kin_bill_reads b
    WHERE b.state = 'reading' AND NOT EXISTS (SELECT 1 FROM kin_events e
      WHERE e.org_id = b.org_id AND e.event_id = b.event_id AND e.state IN ('queued', 'claimed'))
    ORDER BY b.org_id, b.batch_id, b.position`;
  if (orphans.length === 0) return 0;
  const now = yield* Clock.currentTimeMillis;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      for (const row of orphans)
        yield* row.reads < AUTO_READS
          ? sql`UPDATE kin_bill_reads SET state = 'waiting'
              WHERE org_id = ${row.orgId} AND sha256 = ${row.sha256} AND state = 'reading'`
          : sql`UPDATE kin_bill_reads SET state = 'unreadable', problem = ${COULD_NOT_READ},
              read_at = ${now}
              WHERE org_id = ${row.orgId} AND sha256 = ${row.sha256} AND state = 'reading'`;
      const batches = new Map(orphans.map((row) => [`${row.orgId}\u0000${row.batchId}`, row]));
      for (const row of batches.values()) {
        const orgId = row.orgId as KinOrgId;
        yield* queueWaiting(orgId, row.batchId);
        yield* refreshCard(orgId, row.batchId);
      }
    }),
  );
  return orphans.length;
});

const rowView = (row: Row, records: ReadonlyMap<string, RecordBrief>): KinBillRow => {
  const record = row.recordId === null ? undefined : records.get(row.recordId);
  const twin = row.duplicateOf === null ? undefined : records.get(row.duplicateOf);
  const read = Option.getOrElse(decodeRead(row.readJson ?? "{}"), () => ({}));
  return {
    sha256: row.sha256,
    batchId: row.batchId,
    file: {
      attachmentId: row.attachmentId,
      name: row.name,
      mimeType: row.mimeType,
      chatId: KinChatId.make(row.chatId),
      messageId: KinMessageId.make(row.messageId),
    },
    state: shownState(row, record),
    read: read as KinBillRead,
    ...(row.problem === null ? {} : { problem: row.problem }),
    ...(record === undefined
      ? {}
      : { expense: { key: record.key, rev: record.rev, title: record.title } }),
    ...(twin === undefined ? {} : { duplicateOf: { key: twin.key, title: twin.title } }),
    addedAt: iso(row.addedAt),
  };
};

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
      const any = yield* batchRows(input.orgId, input.batchId);
      if (any.length === 0) return yield* notFound;
    }
    yield* sql.withTransaction(refreshCard(input.orgId, input.batchId));
    const shown = all.slice(offset, offset + PAGE);
    const records = yield* recordsById(
      input.orgId,
      shown.flatMap((row) =>
        [row.recordId, row.duplicateOf].filter((id): id is string => id !== null),
      ),
    );
    return {
      batches: [],
      bills: shown.map((row) => rowView(row, records)),
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
      : yield* sql<Row>`SELECT ${sql.literal(COLUMNS)} FROM kin_bill_reads
          WHERE org_id = ${input.orgId} AND batch_id IN ${sql.in(shown.map((one) => one.batchId))}
            AND dismissed_at IS NULL
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
export const keepRead = Effect.fn("KinBills.keepRead")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinBillsKeepReadInput,
) {
  const person = yield* theOwner(people, input.orgId);
  const stored = yield* storedAnswer(
    input.orgId,
    person.personId,
    "keepRead",
    input.clientRequestId,
    input.batchId,
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
        input.batchId,
      );
      if (again !== undefined) return yield* decodeKept(again);
      const rows = (yield* batchRows(input.orgId, input.batchId)).filter(
        (row) => row.dismissedAt === null,
      );
      if (rows.length === 0) return yield* notFound;
      const records = yield* recordsById(
        input.orgId,
        rows.flatMap((row) => (row.recordId === null ? [] : [row.recordId])),
      );
      const kept: Array<string> = [];
      const skipped: Array<KinBillsKeepReadResult["skipped"][number]> = [];
      for (const row of rows) {
        const record = row.recordId === null ? undefined : records.get(row.recordId);
        const shown = shownState(row, record);
        const why =
          row.state !== "read" || record === undefined
            ? shown === "reading"
              ? "Still being read."
              : shown === "duplicate"
                ? "It looks like an expense already recorded."
                : shown === "unreadable"
                  ? "It wasn't read cleanly."
                  : "It has no expense of its own."
            : record.confirmed === 1
              ? "Already kept."
              : record.state === "dropped"
                ? "Dropped."
                : record.state !== "done"
                  ? "Its state was changed."
                  : undefined;
        if (why !== undefined || record === undefined) {
          skipped.push({
            sha256: row.sha256,
            ...(record === undefined ? {} : { key: record.key }),
            why: why ?? "It has no expense of its own.",
          });
          continue;
        }
        yield* confirm(people, { orgId: input.orgId, key: record.key, rev: record.rev });
        kept.push(record.key);
      }
      const result = { kept, skipped } satisfies KinBillsKeepReadResult;
      yield* keepAnswer(
        input.orgId,
        person.personId,
        "keepRead",
        input.clientRequestId,
        input.batchId,
        result,
      );
      yield* refreshCard(input.orgId, input.batchId);
      return result;
    }),
  );
}, workFailure);

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
      const money =
        read.amount === undefined || read.currency === undefined
          ? undefined
          : parseKinMoney(read.amount, read.currency);
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

/** `kin.bills.readAgain`: unreadable bills with no expense, one or a batch's, are queued again. */
export const readAgain = Effect.fn("KinBills.readAgain")(function* (
  people: ReadonlyArray<PersonIdentity>,
  input: KinBillsReadAgainInput,
) {
  yield* theOwner(people, input.orgId);
  if ((input.sha256 === undefined) === (input.batchId === undefined))
    return yield* invalid("Name one bill or one batch.");
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows =
        input.sha256 !== undefined
          ? [yield* billRow(input.orgId, input.sha256)].filter((row) => row !== undefined)
          : yield* batchRows(input.orgId, input.batchId!);
      if (rows.length === 0) return yield* notFound;
      const again = rows.filter(
        (row) => row.state === "unreadable" && row.recordId === null && row.dismissedAt === null,
      );
      if (again.length === 0) return { queued: 0 };
      yield* sql`UPDATE kin_bill_reads SET state = 'waiting', problem = NULL
        WHERE org_id = ${input.orgId} AND sha256 IN ${sql.in(again.map((row) => row.sha256))}
          AND state = 'unreadable' AND record_id IS NULL`;
      for (const batchId of new Set(again.map((row) => row.batchId))) {
        yield* queueWaiting(input.orgId, batchId);
        yield* refreshCard(input.orgId, batchId);
      }
      return { queued: again.length };
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
