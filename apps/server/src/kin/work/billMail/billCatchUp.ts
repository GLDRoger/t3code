import {
  formatKinWhen,
  KIN_TEXT_LOCALE,
  KinChatError,
  KinDay,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinConnections, type BillSearchMessage } from "../../connections/ConnectionsService.ts";
import { normalizeAddress } from "../../connections/MailSignals.ts";
import { MINUTE_MS } from "../../durations.ts";
import { sectionOnFor } from "../../shell/KinShell.ts";
import { onlyOwnerLevel } from "../mailSenderAccess.ts";
import { dayIn } from "../money.ts";
import { ownerZone, startOfDay } from "../recordRows.ts";
import { BILL_SENDERS_OWNER_ONLY } from "./billSenders.ts";

const MAX_MAIL = 200;
const LISTING_MS = 20_000;
const RESUME_MS = 15 * MINUTE_MS;
const MAX_SAVED_SEARCHES = 64;
// Skipped only because the sender or the mailbox couldn't be read then: an owner's catch-up asks again.
const SKIPS_LIFTED = ["not_approved", "removed", "gone"];

type Cursor = {
  readonly connectionId: string;
  readonly service: string;
  pageToken?: string;
  through: number;
};
type Continuation = {
  readonly expiresAt: number;
  readonly boxIds: string;
  readonly cursors: Cursor[];
  readonly pending: BillSearchMessage[];
};

// A retry can reach later pages even when listing the same earlier pages would use the budget.
const continuations = new WeakMap<KinConnections["Service"], Map<string, Continuation>>();

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const isDay = Schema.is(KinDay);
const encodeStrings = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const newestFirst = (a: BillSearchMessage, b: BillSearchMessage) => b.receivedAt - a.receivedAt;

export const readSince = Effect.fn("KinBillSenders.readSince")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  value: string,
  since: string,
) {
  yield* onlyOwnerLevel(orgId, personId, BILL_SENDERS_OWNER_ONLY);
  const sql = yield* SqlClient.SqlClient;
  const address = normalizeAddress(value);
  if (address === undefined)
    return yield* invalid("Enter a full email address for the billing sender.");
  const requireReadable = Effect.gen(function* () {
    if (!(yield* sectionOnFor(orgId, "money")))
      return yield* invalid("Turn Money on to read bills from mail.");
    const [approved] = yield* sql`SELECT 1 FROM kin_bill_senders
      WHERE org_id = ${orgId} AND address = ${address} AND state = 'approved'`;
    if (approved === undefined)
      return yield* invalid(
        `Approve ${address} first: Kin reads bills only from approved senders.`,
      );
  });
  yield* requireReadable;

  const zone = yield* ownerZone(orgId);
  const now = yield* Clock.currentTimeMillis;
  if (!isDay(since) || since > dayIn(now, zone))
    return yield* invalid("Pick a day that has passed.");
  const sinceMs = startOfDay(since, zone);
  const connections = yield* KinConnections;
  const mailboxes = yield* connections.billMailboxes(orgId);
  if (mailboxes.length === 0) return yield* invalid("Kin has no company mailbox it can search.");

  const saved = continuations.get(connections) ?? new Map<string, Continuation>();
  continuations.set(connections, saved);
  const key = yield* encodeStrings([orgId, personId, address, since, zone]);
  const boxIds = yield* encodeStrings(mailboxes.map(({ connectionId }) => connectionId));
  const previous = saved.get(key);
  saved.delete(key);
  const resume =
    previous !== undefined && previous.expiresAt > now && previous.boxIds === boxIds
      ? previous
      : undefined;
  const cursors: Cursor[] =
    resume?.cursors ?? mailboxes.map((mailbox) => ({ ...mailbox, through: Infinity }));
  const pending = resume?.pending ?? [];
  const queueThrough = Effect.fn("KinBillSenders.queueSearchPage")(function* (
    through: number,
    limit: number,
  ) {
    let queued = 0;
    while (queued < limit && pending[0] !== undefined && pending[0].receivedAt >= through) {
      const firstOlder = pending.findIndex((message) => message.receivedAt < through);
      const room = limit - queued;
      const batch = pending.splice(0, firstOlder < 0 ? room : Math.min(room, firstOlder));
      const inserted = yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* onlyOwnerLevel(orgId, personId, BILL_SENDERS_OWNER_ONLY);
          yield* requireReadable;
          const at = yield* Clock.currentTimeMillis;
          const rows = batch.map((message) => ({
            org_id: orgId,
            connection_id: message.connectionId,
            message_id: message.messageId,
            thread_id: message.threadId,
            address,
            received_at: message.receivedAt,
            state: "waiting",
            next_at: at,
            queued_at: at,
            asked_by_person_id: personId,
          }));
          if (!Arr.isArrayNonEmpty(rows)) return [];
          return yield* sql`INSERT INTO kin_bill_mail ${sql.insert(rows)}
            ON CONFLICT (org_id, connection_id, message_id) DO UPDATE SET state = 'waiting',
              reason = NULL, done_at = NULL, next_at = excluded.next_at,
              queued_at = excluded.queued_at, asked_by_person_id = excluded.asked_by_person_id
            WHERE kin_bill_mail.state = 'skipped' AND kin_bill_mail.reason IN ${sql.in(SKIPS_LIFTED)}
            RETURNING message_id`;
        }),
      );
      queued += inserted.length;
    }
    return queued;
  });

  const deadline = (yield* Clock.currentTimeMillis) + LISTING_MS;
  let queued = yield* queueThrough(cursors[0]?.through ?? -Infinity, MAX_MAIL);
  let stopped = "";
  while (queued < MAX_MAIL && cursors.length > 0) {
    const cursor = cursors[0]!;
    yield* onlyOwnerLevel(orgId, personId, BILL_SENDERS_OWNER_ONLY);
    yield* requireReadable;
    const remaining = deadline - (yield* Clock.currentTimeMillis);
    const found =
      remaining <= 0
        ? Option.none()
        : yield* connections
            .billSearch(orgId, cursor.connectionId, address, sinceMs, cursor.pageToken)
            .pipe(Effect.timeoutOption(remaining));
    if (Option.isNone(found)) {
      stopped = "Kin stopped looking after 20 seconds. Run this again to continue.";
      break;
    }
    const page = found.value;
    if ("_tag" in page) {
      stopped = `${cursor.service} asked Kin to wait before looking further: run this again in a few minutes.`;
      break;
    }
    if (page.messages.length > 0) {
      const ids = yield* encodeStrings(page.messages.map((message) => message.messageId));
      const stored = yield* sql<{ messageId: string }>`SELECT message_id AS "messageId"
        FROM kin_bill_mail WHERE org_id = ${orgId} AND connection_id = ${cursor.connectionId}
        AND message_id IN (SELECT value FROM json_each(${ids}))
        AND NOT (state = 'skipped' AND reason IN ${sql.in(SKIPS_LIFTED)})`;
      const known = new Set(stored.map((row) => row.messageId));
      for (const message of pending) {
        if (message.connectionId === cursor.connectionId) known.add(message.messageId);
      }
      for (const message of page.messages) {
        if (known.has(message.messageId)) continue;
        known.add(message.messageId);
        pending.push(message);
      }
      pending.sort(newestFirst);
    }

    if (page.nextPage === null) cursors.shift();
    else {
      cursor.pageToken = page.nextPage;
      cursor.through = Math.min(cursor.through, page.through);
      cursors.sort((a, b) => b.through - a.through);
    }
    // A later page in any inbox can still have newer messages than the tail of this page.
    queued += yield* queueThrough(cursors[0]?.through ?? -Infinity, MAX_MAIL - queued);
  }
  if (stopped !== "") queued += yield* queueThrough(-Infinity, MAX_MAIL - queued);
  const older = queued === MAX_MAIL && (pending.length > 0 || cursors.length > 0);
  if (older || stopped !== "") {
    const expiresAt = (yield* Clock.currentTimeMillis) + RESUME_MS;
    const first = saved.keys().next();
    if (saved.size >= MAX_SAVED_SEARCHES && !first.done) saved.delete(first.value);
    saved.set(key, { expiresAt, boxIds, cursors, pending });
  }
  const date = formatKinWhen(sinceMs, "date", { zone, locale: KIN_TEXT_LOCALE });
  const text =
    queued === 0 && stopped === ""
      ? `Kin found no new mail from ${address} since ${date}.`
      : [
          `Kin is reading ${queued} ${queued === 1 ? "mail" : "mails"} from ${address} since ${date}.`,
          ...(older ? ["There are older mails. Run this again to read the next 200."] : []),
          ...(stopped === "" ? [] : [stopped]),
        ].join(" ");
  return { queued, older, ...(stopped === "" ? {} : { stopped: true as const }), text };
});
