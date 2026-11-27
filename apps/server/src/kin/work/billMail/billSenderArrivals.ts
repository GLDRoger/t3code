import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { arrivalIdOf, mailKeyOf } from "../../arrivals/ArrivalStore.ts";
import { KinRefreshObserver } from "../../chat/KinRefreshHub.ts";
import type { MailArrival } from "../../connections/MailProvider.ts";
import { billingHint } from "../../connections/MailSignals.ts";
import { DAY_MS } from "../../durations.ts";

const HOLD_MS = 30 * DAY_MS;

/** The change feed has already checked that the mailbox is active and belongs to the company. */
export const billsOnMail = Effect.fn("KinBillSenders.onMail")(function* (input: {
  readonly orgId: KinOrgId;
  readonly connectionId: string;
  readonly mail: MailArrival;
  readonly knownBillers: ReadonlySet<string>;
  readonly now: number;
}) {
  const { orgId, connectionId, mail, now } = input;
  const hint = billingHint(mail);
  if (hint === undefined || (!hint.billSubject && mail.hasBillFile !== true)) return;
  const { address } = hint;
  const sql = yield* SqlClient.SqlClient;
  const mailbox = yield* sql`SELECT 1 FROM kin_connections WHERE org_id = ${orgId}
    AND connection_id = ${connectionId} AND person_id IS NULL AND state = 'active'
    AND removed_at IS NULL AND paused_at IS NULL`;
  if (mailbox.length === 0) return;
  const [local, domain] = address.split("@");
  const pieces = local!.split("+");
  // An existing address never vouches for a plus variant, including a tag appended to a tag.
  const otherAddresses = pieces
    .slice(0, -1)
    .map((_, index) => `${pieces.slice(0, index + 1).join("+")}@${domain}`);
  const known = yield* sql<{ address: string; state: string }>`SELECT address, state
    FROM kin_bill_senders WHERE org_id = ${orgId} AND address IN ${sql.in([address, ...otherAddresses])}`;
  if (known.some((row) => row.address !== address || row.state !== "candidate")) return;
  const key =
    mailKeyOf(orgId, address, mail.internetId) ?? arrivalIdOf(orgId, connectionId, mail.messageId);
  const displayName = mail.from?.split("<", 1)[0]?.trim().replace(/^"|"$/g, "").slice(0, 160);
  const name =
    displayName === undefined || displayName.toLowerCase() === address ? null : displayName || null;
  const biller = input.knownBillers.has(address) ? 1 : 0;
  yield* sql`INSERT INTO kin_bill_senders (org_id, address, name, state, first_seen_at, last_seen_at,
      known_biller, created_at)
    VALUES (${orgId}, ${address}, ${name}, 'candidate', ${mail.receivedAt}, ${mail.receivedAt},
      ${biller}, ${now}) ON CONFLICT (org_id, address) DO NOTHING`;
  const held = yield* sql`INSERT INTO kin_bill_sender_mail
      (org_id, mail_key, address, connection_id, message_id, thread_id, received_at)
    VALUES (${orgId}, ${key}, ${address}, ${connectionId}, ${mail.messageId}, ${mail.threadId},
      ${mail.receivedAt}) ON CONFLICT (org_id, mail_key) DO NOTHING RETURNING mail_key`;
  if (held.length === 0) return;
  yield* sql`UPDATE kin_bill_senders SET seen_count = seen_count + 1,
      first_seen_at = MIN(first_seen_at, ${mail.receivedAt}),
      last_seen_at = MAX(last_seen_at, ${mail.receivedAt}),
      known_biller = MAX(known_biller, ${biller})
    WHERE org_id = ${orgId} AND address = ${address}`;
  yield* (yield* KinRefreshObserver).touch(orgId, "billSenders");
});

export const pruneHeldBillMail = Effect.fn("KinBillSenders.pruneHeld")(function* (now: number) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM kin_bill_sender_mail WHERE received_at < ${now - HOLD_MS}`;
});
