// @effect-diagnostics nodeBuiltinImport:off -- hash the bytes already in hand, as Bills does.
import * as NodeCrypto from "node:crypto";

import {
  formatKinWhen,
  KIN_TEXT_LOCALE,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type KinOrgId,
  KinPersonId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { arrivalIdOf, mailKeyOf } from "../../arrivals/ArrivalStore.ts";
import { KinAttachmentStore } from "../../chat/KinAttachmentStore.ts";
import { connectionById, ownUntil } from "../../connections/ConnectionRows.ts";
import { KinConnections } from "../../connections/ConnectionsService.ts";
import {
  type MailArrival,
  type MailMessage,
  receivedAfter,
} from "../../connections/MailProvider.ts";
import { verifiedBillingAddress } from "../../connections/MailSignals.ts";
import { httpsLink, mailFileType } from "../../connections/MailTools.ts";
import { HOUR_MS, MINUTE_MS } from "../../durations.ts";
import { ownerLevelSql } from "../../people/KinAccess.ts";
import { addMailBills } from "../bills.ts";
import { ownerZone } from "../recordRows.ts";
import { orgOwner } from "../toolNames.ts";

const MAX_DUE = 10;
const MAX_PDFS = 5;
const CLAIM_MS = 30 * MINUTE_MS;

type Row = {
  readonly connectionId: string;
  readonly messageId: string;
  readonly address: string;
  readonly askedBy: string | null;
  readonly tries: number;
};
type Skip = "not_approved" | "unverified" | "same_mail" | "gone" | "removed" | "no_parts";
type File = Parameters<typeof addMailBills>[0]["files"][number];

const partsOf = (message: MailMessage) =>
  (message.body?.attachments ?? [])
    .flatMap((part) =>
      part.attachmentId !== undefined &&
      part.bytes !== null &&
      part.bytes > 0 &&
      part.bytes <= PROVIDER_SEND_TURN_MAX_FILE_BYTES &&
      mailFileType(part.name) === "application/pdf"
        ? [part.attachmentId]
        : [],
    )
    .slice(0, MAX_PDFS);

const bodyFile = (message: MailMessage, address: string, date: string) => {
  const link = httpsLink(message.webLink);
  const subject = message.subject.replace(/[\r\n]+/gu, " ");
  return new TextEncoder().encode(
    [
      `From: ${address}`,
      `Received: ${date}`,
      `Subject: ${subject}`,
      ...(link === null ? [] : [`Open the mail: ${link}`]),
      "",
      message.body?.text ?? "",
    ].join("\n"),
  );
};

export const readBillMail = Effect.fn("KinBillMail.readDue")(function* (
  orgId: KinOrgId,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const due = yield* sql<Row>`SELECT connection_id AS "connectionId", message_id AS "messageId",
      address, asked_by_person_id AS "askedBy", tries
    FROM kin_bill_mail WHERE org_id = ${orgId} AND state IN ('waiting', 'reading') AND next_at <= ${now}
    ORDER BY queued_at, connection_id, message_id LIMIT ${MAX_DUE}`;
  for (const row of due)
    yield* readOne(orgId, row, now).pipe(
      Effect.catch(() => Effect.logWarning("Kin bill mail read failed")),
    );
});

const readOne = Effect.fn("KinBillMail.readOne")(function* (
  orgId: KinOrgId,
  row: Row,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const connections = yield* KinConnections;
  const store = yield* KinAttachmentStore;
  const { connectionId, messageId, address } = row;
  const tries = row.tries + 1;
  const byId = sql`org_id = ${orgId} AND connection_id = ${connectionId} AND message_id = ${messageId}`;
  const claimed = sql`${byId} AND state = 'reading' AND tries = ${tries}`;
  const due = sql`${byId} AND state IN ('waiting', 'reading') AND next_at <= ${now} AND tries = ${row.tries}`;
  const liveClaim = sql`SELECT 1 FROM kin_bill_mail WHERE ${claimed}`;
  const approved = sql<{ decidedBy: string | null }>`SELECT decided_by_person_id AS "decidedBy"
    FROM kin_bill_senders WHERE org_id = ${orgId} AND address = ${address} AND state = 'approved'`;
  const mailbox = connectionById(orgId, connectionId).pipe(
    Effect.map((connection) =>
      connection?.personId == null && connection?.state === "active" && connection.pausedAt === null
        ? connection
        : undefined,
    ),
  );

  const skip = (reason: Skip, where = claimed) =>
    sql`UPDATE kin_bill_mail SET state = 'skipped', reason = ${reason}, done_at = ${now}
      WHERE ${where} RETURNING reason`.pipe(
      Effect.tap((rows) =>
        rows.length === 0 ? Effect.void : Effect.logDebug("Kin skipped bill mail", { reason }),
      ),
      Effect.asVoid,
    );
  const backoff = Math.min(CLAIM_MS, MINUTE_MS * 2 ** Math.min(tries - 1, 5));
  const wait = (delay: number) =>
    sql`UPDATE kin_bill_mail SET state = 'waiting', next_at = ${now + delay} WHERE ${claimed}`.pipe(
      Effect.asVoid,
    );

  const claim = sql.withTransaction(
    Effect.gen(function* () {
      if ((yield* approved).length === 0) {
        yield* skip("not_approved", due);
        return false;
      }
      if ((yield* mailbox) === undefined) {
        yield* skip("gone", due);
        return false;
      }
      const rows = yield* sql`UPDATE kin_bill_mail SET state = 'reading', tries = ${tries},
        next_at = ${now + CLAIM_MS} WHERE ${due} RETURNING tries`;
      return rows.length > 0;
    }),
  );

  const claimOnce = (arrival: MailArrival) =>
    sql.withTransaction(
      Effect.gen(function* () {
        if ((yield* approved).length === 0) {
          yield* skip("not_approved");
          return false;
        }
        const connection = yield* mailbox;
        if (
          connection === undefined ||
          !receivedAfter(arrival.receivedAt, yield* ownUntil(orgId, connection.accountLabel))
        ) {
          yield* skip("gone");
          return false;
        }
        const key =
          mailKeyOf(orgId, address, arrival.internetId) ??
          arrivalIdOf(orgId, connectionId, messageId);
        const [previous] = yield* sql<{ key: string | null }>`SELECT mail_key AS key
          FROM kin_bill_mail WHERE ${claimed}`;
        if (previous === undefined) return false;
        if (previous.key !== null && previous.key !== key) {
          yield* skip("unverified");
          return false;
        }
        const rows = yield* sql`UPDATE OR IGNORE kin_bill_mail SET mail_key = ${key}
          WHERE ${claimed} RETURNING mail_key`;
        if (rows.length > 0) return true;
        yield* skip("same_mail");
        return false;
      }),
    );

  const stored = new Set<string>();
  const save = Effect.fn("KinBillMail.save")(function* (
    bytes: Uint8Array,
    extension: "pdf" | "txt",
    date: string,
    part = "",
  ) {
    const suffix = `${part}.${extension}`;
    const name = `Mail from ${address}, ${date}`.slice(0, 200 - suffix.length) + suffix;
    const id = yield* store.storeFile(bytes, extension);
    stored.add(id);
    return {
      attachment: {
        id,
        name,
        type: "file",
        mimeType: extension === "pdf" ? "application/pdf" : "text/plain",
        sizeBytes: bytes.byteLength,
      },
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
    } satisfies File;
  }, Effect.uninterruptible);

  const liveAdder = (id: string | null) =>
    id === null
      ? Effect.undefined
      : sql<{ id: string }>`SELECT p.person_id AS id FROM kin_people p
      WHERE p.org_id = ${orgId} AND p.person_id = ${id} AND p.removed_at IS NULL
        AND ${sql.literal(ownerLevelSql("p.org_id", "p.person_id"))}`.pipe(
          Effect.map(([person]) =>
            person === undefined ? undefined : KinPersonId.make(person.id),
          ),
        );

  const write = (files: [File, ...Array<File>], at: number) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          if ((yield* liveClaim).length === 0) return [];
          const [sender] = yield* approved;
          if (sender === undefined) {
            yield* skip("removed");
            return [];
          }
          if ((yield* mailbox) === undefined) {
            yield* skip("gone");
            return [];
          }
          const adder =
            (yield* liveAdder(row.askedBy)) ??
            (yield* liveAdder(sender.decidedBy)) ??
            (yield* liveAdder(yield* orgOwner(orgId)));
          const added =
            adder === undefined
              ? undefined
              : yield* addMailBills({ orgId, adder, files, mail: { from: address, at } });
          if (added?._tag !== "added") {
            yield* wait(HOUR_MS);
            return [];
          }
          yield* sql`UPDATE kin_bill_mail SET state = 'done', batch_id = ${added.batchId}, done_at = ${now}
        WHERE ${claimed}`;
          return added.keptFiles;
        }),
      )
      .pipe(
        Effect.tap((used) =>
          Effect.sync(() => {
            for (const id of used) stored.delete(id);
          }),
        ),
        Effect.uninterruptible,
      );

  const read = Effect.gen(function* () {
    const arrival = yield* connections.billHeaders(orgId, connectionId, messageId);
    if (arrival === null) return yield* skip("gone");
    // Bills take the relaxed verdict (aligned DKIM and SPF without DMARC): a bill can only make a suggestion a person must keep, where a bank alert writes facts.
    if (verifiedBillingAddress(arrival) !== address) return yield* skip("unverified");
    if (!(yield* claimOnce(arrival))) return;

    const message = yield* connections.billMessage(orgId, connectionId, messageId);
    if (message === null) return yield* skip("gone");
    if (
      message.providerMessageId !== messageId ||
      (message.messageId !== null &&
        arrival.internetId !== null &&
        message.messageId !== arrival.internetId)
    )
      return yield* skip("unverified");

    const at = arrival.receivedAt;
    const date = formatKinWhen(at, "date", {
      zone: yield* ownerZone(orgId),
      locale: KIN_TEXT_LOCALE,
    });
    const parts = partsOf(message);
    const files: Array<File> = [];
    if (parts.length === 0) files.push(yield* save(bodyFile(message, address, date), "txt", date));
    for (const [index, id] of parts.entries()) {
      if ((yield* liveClaim).length === 0) return;
      if ((yield* approved).length === 0) return yield* skip("removed");
      const file = yield* connections.billAttachment(orgId, connectionId, messageId, id);
      if (file.mimeType === "application/pdf") {
        const ordinal = parts.length === 1 ? "" : `, ${index + 1} of ${parts.length}`;
        files.push(yield* save(file.bytes, "pdf", date, ordinal));
      }
    }
    const [first, ...rest] = files;
    if (first === undefined) return yield* skip("no_parts");
    yield* write([first, ...rest], at);
  }).pipe(
    Effect.catchTags({
      KinChatError: (error) => (error.reason === "not_found" ? skip("gone") : wait(backoff)),
    }),
  );

  yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      if (!(yield* claim)) return;
      // next_at is a lease while reading; the try number fences off a worker superseded after a crash.
      yield* restore(read).pipe(
        Effect.onExit((exit) =>
          store
            .remove([...stored])
            .pipe(Effect.andThen(Exit.isFailure(exit) ? wait(backoff) : Effect.void)),
        ),
      );
    }),
  );
});
