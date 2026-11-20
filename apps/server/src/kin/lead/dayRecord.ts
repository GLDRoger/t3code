import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { sentMail } from "../connections/Sending.ts";
import { formatMoney } from "../work/money.ts";
import { countedPayment, recordName } from "../work/recordRows.ts";
import { seenBy, type KinViewer } from "../work/teamView.ts";

/**
 * What happened in Kin's records between `from` and `until` (the company's day), for the evening
 * summary: one short line per thing, by its key, whoever did it and whatever an earlier pass told.
 */
export interface DayRecord {
  readonly finished: ReadonlyArray<string>;
  readonly changed: ReadonlyArray<string>;
  readonly notes: ReadonlyArray<string>;
  readonly made: ReadonlyArray<string>;
  readonly money: ReadonlyArray<string>;
  readonly mail: ReadonlyArray<string>;
}

const LIST_CAP = 10;
const EXCERPT = 100;
/** Lists whose state and holder are a person's work: what "finished" and "changed" read. */
const WORK_LISTS = ["work", "milestones", "projects"] as const;
const LIST_WORDS: Record<string, string> = {
  work: "task",
  milestones: "milestone",
  projects: "project",
  quotes: "quote",
  invoices: "invoice",
  receipts: "receipt",
  docs: "doc",
  expenses: "expense",
  clients: "client",
  contacts: "contact",
};
const STATE_WORDS: Record<string, string> = {
  open: "to do",
  doing: "in progress",
  waiting: "waiting",
  done: "done",
  dropped: "dropped",
};

const decodeFields = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ field: Schema.String, to: Schema.NullOr(Schema.String) })),
  ),
);
const excerpt = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= EXCERPT ? flat : `${chars.slice(0, EXCERPT - 1).join("")}…`;
};
/** The first `LIST_CAP` lines, the last replaced by how many more there were. */
const capped = (lines: ReadonlyArray<string>) =>
  lines.length <= LIST_CAP
    ? lines
    : [...lines.slice(0, LIST_CAP - 1), `and ${lines.length - LIST_CAP + 1} more`];

export const dayRecordEmpty = (day: DayRecord) =>
  day.finished.length +
    day.changed.length +
    day.notes.length +
    day.made.length +
    day.money.length +
    day.mail.length ===
  0;

/** What the evening facts say of a day with nothing in Kin's records. */
export const QUIET_DAY =
  "Nothing was finished, changed, noted, made, paid or mailed in Kin's records today.";

/** The day as the evening facts carry it: its lists that have lines, or `QUIET_DAY`. */
export const shownDay = (day: DayRecord) =>
  dayRecordEmpty(day)
    ? QUIET_DAY
    : Object.fromEntries(Object.entries(day).filter(([, lines]) => lines.length > 0));

export const dayRecord = Effect.fn("KinDayRecord.read")(function* (input: {
  readonly orgId: KinOrgId;
  readonly from: number;
  readonly until: number;
  readonly viewer: KinViewer;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, from, until, viewer } = input;
  const people = yield* sql<{ id: string; name: string }>`SELECT person_id AS id,
      display_name AS name FROM kin_people WHERE org_id = ${orgId} ORDER BY person_id`;
  const agents = yield* sql<{ id: string; name: string }>`SELECT agent_id AS id,
      display_name AS name FROM kin_agents WHERE org_id = ${orgId} ORDER BY agent_id`;
  const personName = new Map(people.map((one) => [one.id, one.name]));
  const agentName = new Map(agents.map((one) => [one.id, one.name]));
  const nameOf = (kind: string, id: string | null) =>
    kind === "person"
      ? (personName.get(id ?? "") ?? "a person")
      : kind === "agent"
        ? (agentName.get(id ?? "") ?? "an agent")
        : "Kin";
  const principalName = (shown: string | null) => {
    if (shown === null) return "nobody";
    const at = shown.indexOf(":");
    return at < 0 ? shown : nameOf(shown.slice(0, at), shown.slice(at + 1));
  };

  const changes = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    list: string;
    state: string;
    confirmed: number;
    kind: string;
    actorKind: string;
    actorId: string | null;
    fieldsJson: string;
  }>`SELECT c.record_id AS "recordId", r.key, r.title, r.register_id AS list, r.state,
      r.confirmed, c.kind, c.actor_kind AS "actorKind", c.actor_id AS "actorId",
      c.fields_json AS "fieldsJson"
    FROM kin_record_changes c JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
    WHERE c.org_id = ${orgId} AND c.at >= ${from} AND c.at < ${until} AND ${seenBy(sql, viewer)}
    ORDER BY c.seq`;
  const finished: Array<string> = [];
  const changed: Array<string> = [];
  const notes: Array<string> = [];
  const made: Array<string> = [];
  const byRecord = new Map<string, Array<(typeof changes)[number]>>();
  for (const change of changes)
    byRecord.set(change.recordId, [...(byRecord.get(change.recordId) ?? []), change]);
  for (const rows of byRecord.values()) {
    const first = rows[0]!;
    const named = `${first.key} ${first.title}`;
    const created = rows.find((row) => row.kind === "created");
    if (created !== undefined)
      made.push(
        `${named} (${LIST_WORDS[first.list] ?? first.list}${first.confirmed === 1 ? "" : ", suggested, not kept yet"}), by ${nameOf(created.actorKind, created.actorId)}`,
      );
    const moves: Array<string> = [];
    let doneBy: string | undefined;
    for (const row of rows) {
      if (row.kind !== "updated") continue;
      const who = nameOf(row.actorKind, row.actorId);
      for (const field of Option.getOrElse(decodeFields(row.fieldsJson), () => [])) {
        if (field.field === "notes") notes.push(`${named}: notes edited by ${who}`);
        if (!(WORK_LISTS as ReadonlyArray<string>).includes(first.list)) continue;
        if (field.field === "state" && field.to === "done") doneBy = who;
        else if (field.field === "state")
          moves.push(`now ${STATE_WORDS[field.to ?? ""] ?? field.to} (${who})`);
        else if (field.field === "owner")
          moves.push(`given to ${principalName(field.to)} (${who})`);
        else if (field.field === "waitingOn" && field.to !== null)
          moves.push(`waiting on ${principalName(field.to)} (${who})`);
      }
    }
    // Finished and still done now; one reopened since reads as a change.
    if (doneBy !== undefined && first.state === "done")
      finished.push(`${named}, done by ${doneBy}`);
    else if (doneBy !== undefined) moves.push(`was done (${doneBy})`);
    if (moves.length > 0) changed.push(`${named}: ${moves.join(", ")}`);
  }

  const comments = yield* sql<{
    key: string;
    title: string;
    authorKind: string;
    authorId: string;
    body: string;
  }>`SELECT r.key, r.title, k.author_kind AS "authorKind", k.author_id AS "authorId", k.body
    FROM kin_record_comments k JOIN kin_records r ON r.org_id = k.org_id AND r.record_id = k.record_id
    WHERE k.org_id = ${orgId} AND k.created_at >= ${from} AND k.created_at < ${until}
      AND k.removed_at IS NULL AND ${seenBy(sql, viewer)}
    ORDER BY k.created_at, k.comment_id`;
  for (const comment of comments)
    notes.push(
      `${comment.key} ${comment.title}: note by ${nameOf(comment.authorKind, comment.authorId)}: "${excerpt(comment.body)}"`,
    );

  const payments = yield* sql<{
    key: string;
    title: string;
    list: string;
    minor: number;
    currency: string;
    byKind: string;
    byId: string | null;
    number: unknown;
  }>`SELECT r.key, r.title, r.register_id AS list, p.amount_minor AS minor, p.currency,
      p.created_by_kind AS "byKind", p.created_by_id AS "byId",
      json_extract(r.fields_json, '$.number') AS number
    FROM kin_record_payments p JOIN kin_records r ON r.org_id = p.org_id AND r.record_id = p.record_id
    WHERE p.org_id = ${orgId} AND p.created_at >= ${from} AND p.created_at < ${until}
      AND ${countedPayment(sql)} AND ${seenBy(sql, viewer)}
    ORDER BY p.created_at, p.payment_id`;
  const money = payments.map(
    (one) =>
      `${formatMoney({ minor: one.minor, currency: one.currency })} ${one.list === "invoices" || one.list === "receipts" ? "in on" : "out on"} ${recordName(one.key, one.number)} ${one.title}, recorded by ${nameOf(one.byKind, one.byId)}`,
  );

  // Mail is the owner's: a narrower reader sees none of it here.
  const mail: Array<string> = [];
  if (viewer._tag === "ownerLevel") {
    for (const sent of (yield* sentMail({ orgId, limit: 50 })).toReversed()) {
      const at = Date.parse(sent.at);
      if (at < from || at >= until) continue;
      mail.push(
        `sent to ${sent.to.join(", ")}: "${excerpt(sent.subject)}"${sent.confirmedBy === null ? "" : `, confirmed by ${sent.confirmedBy}`}`,
      );
    }
    const received = yield* sql<{ key: string; title: string; note: string }>`SELECT r.key, r.title,
        t.note FROM kin_client_touches t
        JOIN kin_records r ON r.org_id = t.org_id AND r.record_id = t.party_id
      WHERE t.org_id = ${orgId} AND t.origin_key LIKE 'mail-in:%' AND t.removed_at IS NULL
        AND t.created_at >= ${from} AND t.created_at < ${until}
      ORDER BY t.created_at, t.touch_id`;
    for (const one of received)
      mail.push(`received from ${one.key} ${one.title}: "${excerpt(one.note)}"`);
  }

  return {
    finished: capped(finished),
    changed: capped(changed),
    notes: capped(notes),
    made: capped(made),
    money: capped(money),
    mail: capped(mail),
  } satisfies DayRecord;
});
