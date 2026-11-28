import { KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { type Matched, mailLine, NEW_SENDERS_PER_POLL, wakeMatches } from "../pulse/outside.ts";
import { companyRuleMailbox } from "./ruleAccess.ts";

type PlaybookMatch = Extract<Matched, { domain: string }>;
export type PlaybookMail = PlaybookMatch & { arrivalId: string; mailClass: string };

export const playbookRoute = (match: PlaybookMail | undefined) =>
  match === undefined
    ? null
    : JSON.stringify({
        domain: match.domain,
        clientId: match.clientId,
        matched: match.line.matched,
        to: match.line.to,
      });

export const takeHeldRulePlaybook = Effect.fn("KinMailRules.takeHeldPlaybook")(function* (
  orgId: KinOrgId,
  connectionId: string,
  live: ReadonlyMap<string, PlaybookMail> = new Map(),
) {
  const sql = yield* SqlClient.SqlClient;
  const where = sql`org_id = ${orgId} AND connection_id = ${connectionId}
    AND rule_playbook_route IS NOT NULL AND rule_hold_reason IS NOT NULL`;
  const rows = yield* sql<{
    arrivalId: string;
    mailClass: string;
    from: string | null;
    threadId: string;
    receivedAt: number;
    domain: PlaybookMail["domain"];
    clientId: string | null;
    matched: string;
    receivedBy: string | null;
  }>`SELECT arrival_id AS "arrivalId", class AS "mailClass", from_address AS "from",
    thread_id AS "threadId", received_at AS "receivedAt",
    json_extract(rule_playbook_route, '$.domain') AS domain,
    json_extract(rule_playbook_route, '$.clientId') AS "clientId",
    json_extract(rule_playbook_route, '$.matched') AS matched,
    json_extract(rule_playbook_route, '$.to') AS "receivedBy"
    FROM kin_arrivals WHERE ${where} ORDER BY noticed_at, arrival_id`;
  if (rows.length === 0) return [];
  yield* sql`UPDATE kin_arrivals SET rule_playbook_route = NULL WHERE ${where}`;
  const mailbox = yield* companyRuleMailbox(orgId, connectionId);
  if (mailbox === undefined) return [];
  // Delayed routing keeps the classified destination and provider IDs without storing the subject.
  return rows.map(
    (row): PlaybookMail =>
      live.get(row.arrivalId) ?? {
        domain: row.domain,
        arrivalId: row.arrivalId,
        mailClass: row.mailClass,
        ...(row.clientId === null ? {} : { clientId: row.clientId }),
        line: {
          ...mailLine(mailbox.label, mailbox.account, {
            from: row.from,
            threadId: row.threadId,
            date: DateTime.formatIso(DateTime.makeUnsafe(row.receivedAt)),
            receivedBy: row.receivedBy,
            subject: null,
          }),
          matched: row.matched,
        },
      },
  );
});

export const wakePlaybookMail = (
  orgId: KinOrgId,
  at: number,
  candidates: Iterable<PlaybookMail>,
) => {
  let newSenders = 0;
  let notices = 0;
  const matches = Array.from(candidates).filter(({ mailClass }) => {
    if (mailClass === "unknown_person") return newSenders++ < NEW_SENDERS_PER_POLL;
    if (mailClass === "automated_notice") return notices++ < NEW_SENDERS_PER_POLL;
    return true;
  });
  return wakeMatches(orgId, at, matches);
};

export const routeLateRuleHolds = Effect.fn("KinMailRules.routeLateHolds")(function* (at: number) {
  const sql = yield* SqlClient.SqlClient;
  const mailboxes = yield* sql<{ orgId: string; connectionId: string }>`SELECT DISTINCT
    org_id AS "orgId", connection_id AS "connectionId" FROM kin_arrivals
    WHERE rule_playbook_route IS NOT NULL AND rule_hold_reason IS NOT NULL`;
  for (const mailbox of mailboxes) {
    const orgId = KinOrgId.make(mailbox.orgId);
    // One mailbox's failure must not stop the others, or the feed's reads after this.
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const matches = yield* takeHeldRulePlaybook(orgId, mailbox.connectionId);
          yield* wakePlaybookMail(orgId, at, matches);
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Kin couldn't route held mail rule mail", { orgId, cause }),
        ),
      );
  }
});
