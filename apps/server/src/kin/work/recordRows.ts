import {
  EnvironmentId,
  KIN_RECORD_CHANGES_CAP,
  KinAgentId,
  KinChatError,
  KIN_TEAM_ROOM_TEAM_ID,
  KinChatId,
  KinMessageId,
  KinPersonId,
  KinAttachment,
  KinRecordId,
  KinRepeatRule,
  ThreadId,
  type KinFileRef,
  type KinOrgId,
  type KinPayment,
  type KinPaymentSource,
  type KinPartyKind,
  type KinRecord,
  type KinRecordCategory,
  type KinRecordChange,
  type KinRecordDetail,
  type KinRecordLink,
  type KinRecordSide,
  type KinRecordState,
  type KinWorkActor,
  type KinWorkPrincipal,
  canonicalTimeZone,
  formatKinLate,
  formatKinWhen,
  KIN_TEXT_LOCALE,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { keySentSql } from "../chat/keySent.ts";
import { ownerLevelPeople, ownerLevelSql } from "../people/KinAccess.ts";
import { billedParty, billingClientFromProject } from "./billTo.ts";
import { fieldList, listNameOf, parseFields } from "./lists.ts";
import { isBuiltIn } from "./registers.ts";
import { bankKnown } from "./statements/bankKnown.ts";
import { DAY_MS } from "../durations.ts";
import { entryAfterReading } from "../lead/OutsideContent.ts";

/** The plain rows behind `KinRecords`: reads and the shapes they decode into. No writes here. */

export type Principal = KinWorkPrincipal;
export type Actor = KinWorkActor;
export type RecordRow = {
  readonly listMoneyVisible?: number;
  readonly orgId: string;
  readonly recordId: string;
  readonly registerId: string;
  readonly key: string;
  readonly title: string;
  readonly state: KinRecordState;
  readonly waitingOnKind: "person" | "agent" | null;
  readonly waitingOnId: string | null;
  readonly ownerKind: "person" | "agent";
  readonly ownerId: string;
  readonly side: KinRecordSide;
  /** A Work category, or a client's kind. */
  readonly category: string | null;
  readonly dueAt: number | null;
  readonly dueAllDay: number;
  readonly sensitive: number;
  /** The owner shared it with the team (`teamView.ts`). */
  readonly teamShared: number;
  readonly confirmed: number;
  readonly notes: string;
  /** The person whose words the title and the notes are (`KinRecords` sets them on each write). */
  readonly titleBy: string | null;
  readonly notesBy: string | null;
  readonly rev: number;
  readonly sourceChatId: string | null;
  readonly sourceMessageId: string | null;
  readonly createdByKind: "person" | "agent" | "system";
  readonly createdById: string | null;
  readonly assignedBy: string | null;
  readonly assignedByAgent: string | null;
  readonly assignedAt: number | null;
  /** Who handed it back to its holder, and when, until it is given again or closed. */
  readonly handedBackKind: "person" | "agent" | null;
  readonly handedBackId: string | null;
  readonly handedBackAt: number | null;
  /** The person who marked it private, while it is (`teamView.ts`). */
  readonly markedBy: string | null;
  readonly originKey: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly closedAt: number | null;
  readonly partyId: string | null;
  readonly projectId: string | null;
  readonly repo: string | null;
  readonly fieldsJson: string;
  readonly working: number;
  readonly pullUrl: string | null;
  readonly partyKey: string | null;
  readonly partyTitle: string | null;
  readonly partyCategory: string | null;
  readonly projectKey: string | null;
  readonly projectTitle: string | null;
  /** Its client, its project or its project's client is labelled sensitive. */
  readonly inheritedSensitive: number;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly dateAt: number | null;
  readonly dateAllDay: number;
  readonly repeatJson: string | null;
  /** A task's checklist (`stepsOf`), and whether someone marked it urgent. */
  readonly stepsJson: string | null;
  readonly urgent: number | null;
  /** Payments not voided, in its own currency. */
  readonly paid: number;
  /** Of `paid`, tax the payer withheld at source rather than paid in. */
  readonly withheld: number;
  /** Its list's entries are paid over time: Invoices, or a list whose definition says so. */
  readonly takesPayments: number;
};

export const unavailable = new KinChatError({
  reason: "unavailable",
  message: "Work is unavailable right now. Try again.",
});
export const notFound = (key: string) =>
  new KinChatError({ reason: "not_found", message: `No entry ${key.slice(0, 40)} in Work.` });

const isChatError = Schema.is(KinChatError);
/** A Work read or write that failed for any reason but a refusal: logged, and "unavailable". */
export const workFailure = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, KinChatError, R> =>
  effect.pipe(
    Effect.tapError((error) =>
      isChatError(error)
        ? Effect.void
        : Effect.logWarning("Kin Work failed", { errorTag: error._tag }),
    ),
    Effect.mapError((error) => (isChatError(error) ? error : unavailable)),
  );
export const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
export const isClosed = (state: KinRecordState) => state === "done" || state === "dropped";
export const principal = (kind: string | null, id: string | null): Principal | null =>
  id === null
    ? null
    : kind === "person"
      ? { _tag: "person", personId: KinPersonId.make(id) }
      : kind === "agent"
        ? { _tag: "agent", agentId: KinAgentId.make(id) }
        : null;
export const principalId = (who: Principal) => (who._tag === "person" ? who.personId : who.agentId);
export const samePrincipal = (left: Principal | null, right: Principal | null) =>
  left === null || right === null
    ? left === right
    : left._tag === right._tag && principalId(left) === principalId(right);
export const actorOf = (kind: string, id: string | null): Actor =>
  kind === "system" ? { _tag: "system" } : (principal(kind, id) ?? { _tag: "system" });

/** Lists whose entries are private only by their own label: a task never inherits one. */
export const OWN_LABEL_LISTS = ["work", "milestones"] as const;

/** `r` is a promise (`promises.ts`): an obligation sitting on a deal, `d`. */
const promiseOn = (
  sql: SqlClient.SqlClient,
  deal: Statement.Fragment,
) => sql`(r.register_id = 'work'
  AND r.category = 'obligation' AND EXISTS (SELECT 1 FROM kin_record_links dl
    JOIN kin_records d ON d.org_id = dl.org_id AND d.record_id = dl.target
    WHERE dl.org_id = r.org_id AND dl.record_id = r.record_id AND dl.kind = 'record'
      AND d.register_id = 'deals' AND ${deal}))`;
export const promiseOnDeal = (sql: SqlClient.SqlClient) => promiseOn(sql, sql`1 = 1`);

/**
 * The entry `r` was made from: a receipt's invoice, through the payment its `tie` stored
 * (`gendocs/receipts.ts`, the only writer of `$.payment`). Null for anything else.
 */
const madeFrom = (sql: SqlClient.SqlClient) => sql`(CASE WHEN r.register_id = 'receipts' THEN
    (SELECT pay.record_id FROM kin_record_payments pay WHERE pay.org_id = r.org_id
      AND pay.payment_id = json_extract(r.fields_json, '$.payment')) END)`;

/**
 * A promise on a deal kept private, or on any deal while Deals (or Clients, which holds it) is off
 * (`KinShell.sectionOn`): it is as hidden as its deal.
 */
const promiseOnHiddenDeal = (sql: SqlClient.SqlClient, shell: boolean) =>
  promiseOn(
    sql,
    shell
      ? sql`(d.sensitive = 1 OR EXISTS (SELECT 1 FROM kin_company_shell sh, json_each(sh.shell_json) j
      WHERE sh.org_id = r.org_id AND json_extract(j.value, '$.id') IN ('deals', 'clients')
        AND json_extract(j.value, '$.on') = 0))`
      : sql`d.sensitive = 1`,
  );

/**
 * Whether `r`'s client, its project or its project's client is labelled sensitive, or its deal; for
 * an entry made from another (`madeFrom`), that entry's client, project or project's client too.
 */
const parentLabelled = (sql: SqlClient.SqlClient, shell = true) => sql`(EXISTS (SELECT 1
    FROM kin_records s
    WHERE s.org_id = r.org_id AND s.sensitive = 1 AND s.record_id IN (r.party_id, r.project_id,
      (SELECT p.party_id FROM kin_records p WHERE p.org_id = r.org_id AND p.record_id = r.project_id),
      (SELECT f.party_id FROM kin_records f WHERE f.org_id = r.org_id AND f.record_id = ${madeFrom(sql)}),
      (SELECT f.project_id FROM kin_records f WHERE f.org_id = r.org_id AND f.record_id = ${madeFrom(sql)}),
      (SELECT fp.party_id FROM kin_records f JOIN kin_records fp
        ON fp.org_id = f.org_id AND fp.record_id = f.project_id
        WHERE f.org_id = r.org_id AND f.record_id = ${madeFrom(sql)})))
  OR ${promiseOnHiddenDeal(sql, shell)})`;

/**
 * Whether `r` inherits a label from its client or project (design 4.9), or a promise from its deal.
 * Other tasks and milestones are private only when marked so themselves.
 */
export const inheritedSensitive = (sql: SqlClient.SqlClient, shell = true) =>
  sql`((r.register_id NOT IN ${sql.in(OWN_LABEL_LISTS)} AND ${parentLabelled(sql, shell)})
    OR ${promiseOnHiddenDeal(sql, shell)})`;

/** `r`'s own label or one it inherits: the one check every screen and Kin agent uses. */
export const sensitiveNow = (sql: SqlClient.SqlClient) =>
  sql`(r.sensitive = 1 OR ${inheritedSensitive(sql)})`;

/**
 * `sensitiveNow` by labels alone, for the pulse: it hears Deals being off through KinShell's quiet,
 * which keeps its facts when the shell can't be read.
 */
export const labelledNow = (sql: SqlClient.SqlClient) =>
  sql`(r.sensitive = 1 OR ${inheritedSensitive(sql, false)})`;

/**
 * What a coding-agent key never reaches: `r`'s own label, or its client's, project's or project's
 * client's, tasks included. Screens and Kin's own agents keep `sensitiveNow`.
 */
export const keySensitive = (sql: SqlClient.SqlClient) =>
  sql`(r.sensitive = 1 OR ${parentLabelled(sql)})`;

/**
 * A label a person put on `alias` on purpose: one on an entry of a list with no default label, or
 * one recorded as theirs (`marked_by_person_id`) where the list labels every entry when it is made.
 */
const chosenLabel = (sql: SqlClient.SqlClient, alias: string) =>
  sql`(${sql(alias)}.sensitive = 1 AND (${sql(alias)}.marked_by_person_id IS NOT NULL
    OR NOT EXISTS (SELECT 1 FROM kin_registers g WHERE g.org_id = ${sql(alias)}.org_id
      AND g.register_id = ${sql(alias)}.register_id AND g.built_in = 0
      AND json_extract(g.definition_json, '$.sensitive') = 1)))`;

/**
 * What a coding-agent key never carries, whoever holds it: a label a person chose for `r`, or for
 * the entry it was made from, or any label on its client, project or project's client (or theirs).
 * A list's own default label is no person's choice; Money's permission gates those lists.
 */
export const keyWithheld = (sql: SqlClient.SqlClient) =>
  sql`(${chosenLabel(sql, "r")} OR ${parentLabelled(sql)} OR EXISTS (SELECT 1 FROM kin_records f
    WHERE f.org_id = r.org_id AND f.record_id = ${madeFrom(sql)} AND ${chosenLabel(sql, "f")}))`;

/**
 * Whether an entry is sensitive now: its own label, or its client's, project's or project's
 * client's. Reads through the caller's transaction; `undefined` when the org has no such entry.
 */
export const effectivelySensitive = Effect.fn("KinRecords.effectivelySensitive")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ sensitive: number }>`SELECT ${sensitiveNow(sql)} AS sensitive
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.record_id = ${recordId}`;
  return row === undefined ? undefined : row.sensitive === 1;
});

/** Whether `r`'s list is paid over time, as `registers.ts` reads a definition. */
const takesPayments = (sql: SqlClient.SqlClient) =>
  sql`(r.register_id = 'invoices' OR EXISTS (SELECT 1 FROM kin_registers g
    WHERE g.org_id = r.org_id AND g.register_id = r.register_id AND g.built_in = 0
      AND json_extract(g.definition_json, '$.payments') = 1))`;

/**
 * A suggestion: an entry nobody with the right has kept, whatever it holds now. Its money is owed,
 * due, received or spent nowhere until the owner or a co-owner keeps it; as work or a date it is
 * still there. `KinRecords` alone decides the flag (`keepsAsked`).
 */
export const isSuggestion = (row: { readonly confirmed: number }) => row.confirmed === 0;
/** `isSuggestion` in SQL, for an entry `r`: true for one that was kept. */
export const keptEntry = (sql: SqlClient.SqlClient) => sql`r.confirmed = 1`;
/**
 * A suggestion's state as an agent reads it: issued, sent or owed nowhere, so never its list's
 * word for that; a quote or invoice draft says it is one.
 */
export const suggestedStateLabel = (list: string, state: string, label: string) =>
  state === "open" && (list === "quotes" || list === "invoices")
    ? `${label}, suggested: waits for the owner or a co-owner to keep it`
    : "Suggested: waits for the owner or a co-owner to keep it";
/** A kept invoice nobody has issued, as an agent's tool result names it. */
export const UNISSUED_INVOICE = "Draft: waits for the owner or a co-owner to issue it";
/** The one refusal for anything done to a suggestion before it is kept, whoever asks. */
export const stillSuggestion = (key: string) =>
  `${key} is still a suggestion: the owner or a co-owner hasn't kept it. They keep it with Keep on its page, or by asking you to keep it themselves. Nothing changed.`;

/**
 * The one rule for what a figure, a chart or a file counts: an entry `r` that isn't void, dropped
 * or undone, unless the filter it answers names dropped entries itself, and isn't a suggestion.
 * Every query that adds up or exports amounts uses it or `countedPayment`; `counted.test.ts` finds
 * one that doesn't.
 */
export const countedEntry = (
  sql: SqlClient.SqlClient,
  asked?: ReadonlyArray<KinRecordState> | undefined,
) =>
  asked?.includes("dropped") === true
    ? keptEntry(sql)
    : sql`r.state <> 'dropped' AND ${keptEntry(sql)}`;
/** A payment `p` not taken back, on an entry `r` that counts. */
export const countedPayment = (sql: SqlClient.SqlClient) =>
  sql`p.voided_at IS NULL AND ${countedEntry(sql)}`;

/** `termsDays` in SQL, for the forms its test names; null where it finds no days. */
const termsDaysSql = (sql: SqlClient.SqlClient, terms: Statement.Fragment) => sql`(
  SELECT CASE WHEN days BETWEEN 0 AND 365 THEN days END FROM (
    SELECT CASE
      WHEN net > 0 AND (day = 0 OR net < day) AND afterNet GLOB '[0-9]*'
        THEN CAST(substr(afterNet, 1, 3) AS INTEGER)
      WHEN day > 0 AND (substr(x, day + 3) = '' OR substr(x, day + 3) GLOB '[^a-z0-9_]*'
          OR substr(x, day + 3) = 's' OR substr(x, day + 3) GLOB 's[^a-z0-9_]*')
        THEN CASE
          WHEN substr(beforeDay, -3) GLOB '[0-9][0-9][0-9]' THEN CAST(substr(beforeDay, -3) AS INTEGER)
          WHEN substr(beforeDay, -2) GLOB '[0-9][0-9]' THEN CAST(substr(beforeDay, -2) AS INTEGER)
          WHEN substr(beforeDay, -1) GLOB '[0-9]' THEN CAST(substr(beforeDay, -1) AS INTEGER)
        END
    END AS days FROM (
      SELECT x, net, day, ltrim(substr(x, net + 3), ' ' || char(9, 10, 13)) AS afterNet,
        rtrim(substr(x, 1, day - 1), ' -' || char(9, 10, 13)) AS beforeDay
      FROM (SELECT x, instr(x, 'net') AS net, instr(x, 'day') AS day
        FROM (SELECT lower(${terms}) AS x)))))`;

/**
 * When an issued invoice `r` falls due: its due date, else its issue day plus its client's terms
 * in days, else never (null), as an invoice with no due date and no terms isn't due at once.
 * Overdue is past it, the same in the pulse, Money, the client page and every brief.
 */
export const invoiceDue = (sql: SqlClient.SqlClient) => sql`COALESCE(r.due_at,
  r.date_at + ${DAY_MS} * ${termsDaysSql(
    sql,
    sql`(SELECT json_extract(c.fields_json, '$.terms') FROM kin_records c
      WHERE c.org_id = r.org_id AND c.register_id = 'clients' AND c.record_id = ${billingClientFromProject(
        sql,
        sql`(SELECT p.party_id FROM kin_records p WHERE p.org_id = r.org_id AND p.record_id = r.project_id)`,
      )})`,
  )})`;

/** `owedInvoices`' overdue in SQL, for an invoice `r`: counted, issued, a balance left, past due. */
export const overdueInvoice = (sql: SqlClient.SqlClient, now: number) => sql`(
  r.register_id = 'invoices' AND ${countedEntry(sql)} AND r.state = 'waiting'
  AND r.amount_minor IS NOT NULL AND r.amount_minor > (SELECT COALESCE(SUM(p.amount_minor), 0)
    FROM kin_record_payments p
    WHERE p.org_id = r.org_id AND p.record_id = r.record_id AND p.voided_at IS NULL)
  AND ${invoiceDue(sql)} < ${now})`;

/**
 * Issued invoices still owed, oldest due first: counted, issued (waiting), with an amount and a
 * balance after payments not taken back. Overdue is past `invoiceDue`. What a client owes, the
 * Money tab and the weekly brief all read owed money here; the pulse chases on the same rows.
 */
export const owedInvoices = Effect.fn("KinRecordRows.owedInvoices")(function* (input: {
  readonly orgId: KinOrgId;
  readonly now: number;
  readonly partyId?: string | undefined;
  /** A viewer filter over `r`, such as `viewSees`; the company's own figures with none. */
  readonly seen?: Statement.Fragment | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    partyId: string | null;
    partyKey: string | null;
    partyTitle: string | null;
    fieldsJson: string | null;
    minor: number;
    currency: string;
    paid: number;
    dueAt: number | null;
    number: unknown;
  }>`SELECT r.record_id AS "recordId", r.key, r.title, r.party_id AS "partyId",
      CASE WHEN pa.record_id IS NULL THEN r.fields_json END AS "fieldsJson",
      pa.key AS "partyKey", pa.title AS "partyTitle", r.amount_minor AS minor, r.currency,
      (SELECT COALESCE(SUM(p.amount_minor), 0) FROM kin_record_payments p
        WHERE p.org_id = r.org_id AND p.record_id = r.record_id AND p.voided_at IS NULL) AS paid,
      ${invoiceDue(sql)} AS "dueAt", json_extract(r.fields_json, '$.number') AS number
    FROM kin_records r
    LEFT JOIN kin_records pa ON pa.org_id = r.org_id AND pa.record_id = r.party_id
    WHERE r.org_id = ${input.orgId} AND r.register_id = 'invoices' AND ${countedEntry(sql)}
      AND r.state = 'waiting' AND r.amount_minor IS NOT NULL
      ${input.partyId === undefined ? sql`` : sql`AND r.party_id = ${input.partyId}`}
      ${input.seen === undefined ? sql`` : sql`AND ${input.seen}`}
    ORDER BY r.due_at, r.key`;
  const zone = yield* ownerZone(input.orgId);
  return rows
    .map(({ fieldsJson, ...row }) => {
      const billTo =
        fieldsJson === null
          ? undefined
          : billedParty({ registerId: "invoices", fieldsJson }, undefined)?.name;
      const overdue = row.dueAt !== null && row.dueAt < input.now;
      return {
        ...row,
        ...(billTo === undefined ? {} : { billTo }),
        balance: { minor: row.minor - row.paid, currency: row.currency },
        overdue,
        daysOverdue: overdue ? daysOverdue(row.dueAt!, input.now, zone) : 0,
      };
    })
    .filter((row) => row.balance.minor > 0);
});

/** Payment days written in a client's terms, such as "Net 30" or "15 days"; undefined if none. */
export const termsDays = (terms: string | null | undefined) => {
  const found = /(?:net\s*(\d{1,3}))|(?:(\d{1,3})[\s-]*(?:days?|d)\b)/i.exec(terms ?? "");
  const days = Number(found?.[1] ?? found?.[2]);
  return Number.isSafeInteger(days) && days >= 0 && days <= 365 ? days : undefined;
};

/** An entry's money day: its own date, else when it was added. Filters, groups and Money share it. */
export const moneyDay = (sql: SqlClient.SqlClient) => sql`COALESCE(r.date_at, r.created_at)`;

/**
 * The columns every read selects, with the derived ones: an old worker run, the last PR, the client
 * and project as they are now, and the label they lend it. Joins stay inside the entry's org.
 */
/** `shell` false reads labels alone, as `labelledNow` does for the pulse. */
export const selectRecords = (sql: SqlClient.SqlClient, extra = sql``, shell = true) => sql`
  SELECT r.org_id AS "orgId", r.record_id AS "recordId", r.register_id AS "registerId", r.key,
    r.title, r.state,
    r.waiting_on_kind AS "waitingOnKind", r.waiting_on_id AS "waitingOnId",
    r.owner_kind AS "ownerKind", r.owner_id AS "ownerId", r.side, r.category,
    r.due_at AS "dueAt", r.due_all_day AS "dueAllDay", r.sensitive, r.team_shared AS "teamShared",
    r.confirmed, r.notes, r.title_by AS "titleBy", r.notes_by AS "notesBy", r.rev,
    r.source_chat_id AS "sourceChatId", r.source_message_id AS "sourceMessageId",
    r.created_by_kind AS "createdByKind", r.created_by_id AS "createdById",
    r.assigned_by_person_id AS "assignedBy", r.assigned_by_agent_id AS "assignedByAgent",
    r.assigned_at AS "assignedAt", r.marked_by_person_id AS "markedBy",
    r.handed_back_kind AS "handedBackKind", r.handed_back_id AS "handedBackId",
    r.handed_back_at AS "handedBackAt",
    r.origin_key AS "originKey", r.created_at AS "createdAt", r.updated_at AS "updatedAt",
    r.closed_at AS "closedAt", r.party_id AS "partyId", r.project_id AS "projectId", r.repo,
    r.fields_json AS "fieldsJson",
    r.amount_minor AS "amountMinor", r.currency, r.date_at AS "dateAt",
    r.date_all_day AS "dateAllDay", r.repeat_json AS "repeatJson",
    r.steps_json AS "stepsJson", r.urgent,
    (SELECT COALESCE(SUM(p.amount_minor), 0) FROM kin_record_payments p
      WHERE p.org_id = r.org_id AND p.record_id = r.record_id AND p.voided_at IS NULL) AS paid,
    (SELECT COALESCE(SUM(p.amount_minor), 0) FROM kin_record_payments p
      WHERE p.org_id = r.org_id AND p.record_id = r.record_id AND p.voided_at IS NULL
        AND p.withheld = 1) AS withheld,
    ${takesPayments(sql)} AS "takesPayments",
    pa.key AS "partyKey", pa.title AS "partyTitle", pa.category AS "partyCategory",
    pj.key AS "projectKey",
    pj.title AS "projectTitle",
    ${inheritedSensitive(sql, shell)} AS "inheritedSensitive",
    EXISTS (SELECT 1 FROM kin_record_links l JOIN kin_workers k
        ON k.org_id = l.org_id AND k.worker_id = l.target
      WHERE l.org_id = r.org_id AND l.record_id = r.record_id AND l.kind = 'worker'
        AND k.ended_at IS NULL) AS working,
    (SELECT l.target FROM kin_record_links l WHERE l.org_id = r.org_id
      AND l.record_id = r.record_id AND l.kind = 'pull_request'
      ORDER BY l.created_at DESC, l.target LIMIT 1) AS "pullUrl"${extra}
  FROM kin_records r
  LEFT JOIN kin_records pa ON pa.org_id = r.org_id AND pa.record_id = r.party_id
  LEFT JOIN kin_records pj ON pj.org_id = r.org_id AND pj.record_id = r.project_id`;

export const byKey = Effect.fn("KinRecords.byKey")(function* (orgId: KinOrgId, key: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<RecordRow>`${selectRecords(sql)}
    WHERE r.org_id = ${orgId} AND r.key = ${key} ORDER BY r.record_id`;
  return row;
});
/**
 * The entry a number names, as people see it on screen. Issued numbers are unique within a list
 * (`kin_issued_numbers`); two entries showing one, as two lists may, name none rather than guess.
 */
export const byNumber = Effect.fn("KinRecords.byNumber")(function* (
  orgId: KinOrgId,
  number: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<RecordRow>`${selectRecords(sql)}
    WHERE r.org_id = ${orgId} AND json_extract(r.fields_json, '$.number') = ${number.trim()}
    ORDER BY r.record_id LIMIT 2`;
  return rows.length === 1 ? rows[0] : undefined;
});
export const byId = Effect.fn("KinRecords.byId")(function* (orgId: KinOrgId, recordId: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<RecordRow>`${selectRecords(sql)}
    WHERE r.org_id = ${orgId} AND r.record_id = ${recordId} ORDER BY r.record_id`;
  return row;
});

const pullNumber = (url: string) => {
  const found = /\/pull\/(\d+)(?:[/?#]|$)/.exec(url)?.[1];
  return found === undefined ? undefined : Number.parseInt(found, 10);
};

const WORK_CATEGORIES: ReadonlyArray<string> = ["task", "issue", "obligation"];
/** A client's category says whether it is one we sell to or buy from. */
export const partyKind = (category: string | null): KinPartyKind =>
  category === "vendor" ? "vendor" : "client";
const refOf = (recordId: string | null, key: string | null, title: string | null) =>
  recordId === null || key === null || title === null
    ? undefined
    : { recordId: KinRecordId.make(recordId), key, title: title as KinRecord["title"] };

export const toRecord = (row: RecordRow, now: number): KinRecord => {
  const number = row.pullUrl === null ? undefined : pullNumber(row.pullUrl);
  const ref = refOf(row.partyId, row.partyKey, row.partyTitle);
  const party = ref === undefined ? undefined : { ...ref, kind: partyKind(row.partyCategory) };
  const project = refOf(row.projectId, row.projectKey, row.projectTitle);
  return {
    recordId: KinRecordId.make(row.recordId),
    orgId: row.orgId as KinOrgId,
    key: row.key,
    title: row.title as KinRecord["title"],
    state: row.state,
    waitingOn: row.state === "waiting" ? principal(row.waitingOnKind, row.waitingOnId) : null,
    owner: principal(row.ownerKind, row.ownerId) ?? {
      _tag: "agent",
      agentId: KinAgentId.make(row.ownerId),
    },
    category:
      row.category !== null && WORK_CATEGORIES.includes(row.category)
        ? (row.category as KinRecordCategory)
        : null,
    side: row.side,
    dueAt: row.dueAt === null ? null : iso(row.dueAt),
    dueAllDay: row.dueAllDay === 1,
    late: row.dueAt !== null && row.dueAt < now && !isClosed(row.state),
    confirmed: row.confirmed === 1,
    sensitive: row.sensitive === 1,
    working: row.working === 1,
    pullRequest: row.pullUrl === null || number === undefined ? null : { url: row.pullUrl, number },
    rev: row.rev,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    closedAt: row.closedAt === null ? null : iso(row.closedAt),
    ...(party === undefined ? {} : { party }),
    ...(project === undefined ? {} : { project }),
    ...(row.repo === null ? {} : { repo: row.repo }),
    ...(row.inheritedSensitive === 1 ? { sensitiveInherited: true as const } : {}),
    ...(row.teamShared === 1 ? { shared: true as const } : {}),
    ...givenOf(row),
    ...handedBackOf(row),
    ...(row.sensitive === 1 && row.markedBy !== null
      ? { markedBy: KinPersonId.make(row.markedBy) }
      : {}),
    ...moneyOf(row),
    ...listNameOf(row.registerId),
    ...stepsCount(row),
    ...(row.registerId === "work" && row.urgent === 1 ? { urgent: true as const } : {}),
    ...alsoOnShown(row),
  };
};

/** `person:<id>` or `agent:<id>`, as a list of people in an entry's fields stores one. */
export const storedPrincipal = (text: string) => {
  const at = text.indexOf(":");
  return at < 1 || at === text.length - 1 ? null : principal(text.slice(0, at), text.slice(at + 1));
};
/** Who is on a task besides its holder (`fields.alsoOn`), in the order they were put on it. */
const alsoOnOf = (row: Pick<RecordRow, "registerId" | "fieldsJson">) => {
  if (row.registerId !== "work" || !row.fieldsJson.includes('"alsoOn"')) return [];
  return fieldList(parseFields(row.fieldsJson), "alsoOn").flatMap((text) => {
    const who = storedPrincipal(text);
    return who === null ? [] : [who];
  });
};
const alsoOnShown = (row: RecordRow) => {
  const alsoOn = alsoOnOf(row);
  return alsoOn.length === 0 ? {} : { alsoOn };
};

/** A task's steps as stored: in order, each its words and whether it is ticked. */
const StepsJson = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ title: Schema.String, done: Schema.Boolean })),
);
const decodeSteps = Schema.decodeUnknownOption(StepsJson);
export const encodeSteps = Schema.encodeEffect(StepsJson);
export const stepsOf = (row: Pick<RecordRow, "registerId" | "stepsJson">) =>
  row.registerId !== "work" || row.stepsJson === null
    ? []
    : Option.getOrElse(decodeSteps(row.stepsJson), () => []);
const stepsCount = (row: RecordRow) => {
  const steps = stepsOf(row);
  return steps.length === 0
    ? {}
    : { steps: { done: steps.filter((step) => step.done).length, of: steps.length } };
};
/** How a checklist reads in a task's history: "Wireframe (done), Review with Zoya". */
export const shownSteps = (steps: ReadonlyArray<{ title: string; done: boolean }>) =>
  steps.length === 0
    ? null
    : steps.map((step) => (step.done ? `${step.title} (done)` : step.title)).join(", ");

/** Who gave a task to whoever holds it now, when that is someone else. */
const givenOf = (row: RecordRow): { readonly givenBy?: KinWorkPrincipal } => {
  if (row.registerId !== "work") return {};
  const by: KinWorkPrincipal | null =
    row.assignedBy !== null
      ? { _tag: "person", personId: KinPersonId.make(row.assignedBy) }
      : row.assignedByAgent !== null
        ? { _tag: "agent", agentId: KinAgentId.make(row.assignedByAgent) }
        : null;
  return by === null ||
    (by._tag === row.ownerKind && (by._tag === "person" ? by.personId : by.agentId) === row.ownerId)
    ? {}
    : { givenBy: by };
};

const handedBackOf = (row: RecordRow) => {
  if (
    row.registerId !== "work" ||
    isClosed(row.state) ||
    row.handedBackAt === null ||
    row.handedBackId === null
  )
    return {};
  const by: KinWorkPrincipal =
    row.handedBackKind === "agent"
      ? { _tag: "agent", agentId: KinAgentId.make(row.handedBackId) }
      : { _tag: "person", personId: KinPersonId.make(row.handedBackId) };
  return { handedBack: { by, at: iso(row.handedBackAt) } };
};

/** Its amount, own date and repeat; in a defined list, the list, its category and a balance. */
const moneyOf = (row: RecordRow) => {
  const amount = amountOf(row);
  const repeat = repeatOf(row.repeatJson);
  return {
    ...(isBuiltIn(row.registerId) ? {} : { list: row.registerId }),
    ...(row.category === null || isBuiltIn(row.registerId) ? {} : { listCategory: row.category }),
    ...(amount === undefined ? {} : { amount }),
    ...(row.dateAt === null ? {} : { dateAt: iso(row.dateAt), dateAllDay: row.dateAllDay === 1 }),
    ...(repeat === undefined ? {} : { repeat: repeat.rule }),
    // A suggestion owes and has received nothing yet; its old payments are only history.
    ...(amount === undefined || row.takesPayments !== 1 || isSuggestion(row)
      ? {}
      : {
          balance: { minor: Math.max(amount.minor - row.paid, 0), currency: amount.currency },
          received: { minor: row.paid - row.withheld, currency: amount.currency },
          ...(row.withheld === 0
            ? {}
            : { tdsDeducted: { minor: row.withheld, currency: amount.currency } }),
        }),
  };
};
export const amountOf = (row: RecordRow) =>
  row.amountMinor === null || row.currency === null
    ? undefined
    : { minor: row.amountMinor, currency: row.currency };

/** A repeat rule as stored, with the day of the month each date keeps. */
export const StoredRepeat = Schema.Struct({
  rule: KinRepeatRule,
  dueDay: Schema.optional(Schema.Int),
  dateDay: Schema.optional(Schema.Int),
});
export type StoredRepeat = typeof StoredRepeat.Type;
const RepeatJson = Schema.fromJsonString(StoredRepeat);
const decodeRepeat = Schema.decodeUnknownOption(RepeatJson);
export const encodeRepeat = Schema.encodeEffect(RepeatJson);
export const repeatOf = (json: string | null) =>
  json === null ? undefined : Option.getOrUndefined(decodeRepeat(json));

type ChangeRow = {
  readonly seq: number;
  readonly at: number;
  readonly actorKind: string;
  readonly actorId: string | null;
  readonly via: KinRecordChange["via"];
  readonly kind: KinRecordChange["kind"];
  readonly fieldsJson: string;
};
const numberText = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
/** An entry's issued number from its `$.number` field, as an optional `number` to spread. */
export const issuedNumber = (value: unknown) => {
  const number = numberText(value);
  return number === undefined ? {} : { number };
};
/**
 * An entry as text agents read names it: its issued number, as people see it, then the key its
 * tools take, "INV/26-27/004 (INV-1)"; the key alone until it has one.
 */
export const recordName = (key: string, number: unknown) => {
  const issued = numberText(number);
  return issued === undefined ? key : `${issued} (${key})`;
};

type LinkRow = {
  readonly kind: KinRecordLink["kind"];
  readonly relation: KinRecordLink["relation"];
  readonly target: string;
  readonly chatId: string | null;
  readonly label: string | null;
  readonly createdAt: number;
  readonly otherId: string | null;
  readonly otherKey: string | null;
  readonly otherTitle: string | null;
  readonly otherNumber: unknown;
  readonly otherDeleted: number | null;
  readonly workerId: string | null;
  readonly workerThreadId: string | null;
  readonly workerEnvironmentId: string | null;
  readonly workerEndedAt: number | null;
  readonly workerPullUrl: string | null;
  readonly workerPullNumber: number | null;
};
export type FieldChange = {
  readonly field: string;
  readonly from: string | null;
  readonly to: string | null;
  /** What `from` and `to` read as at the change, such as a deal's stage names for their ids. */
  readonly names?: { readonly from: string | null; readonly to: string | null };
};

/** SQL for the name of the coding-agent key a `table` row came through; NULL when none did. */
export const CODING_AGENT_NAME = (table: "kin_record_changes" | "kin_record_comments") =>
  `CASE WHEN ${table}.coding_agent_key IS NULL THEN NULL
    ELSE COALESCE((SELECT k.label FROM kin_tasks_keys k WHERE k.org_id = ${table}.org_id
      AND k.session_id = ${table}.coding_agent_key), 'Coding agent') END`;
export const parseChanges = (json: string): ReadonlyArray<FieldChange> => {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as ReadonlyArray<FieldChange>) : [];
  } catch {
    return [];
  }
};

/** A history line as stored: its fields keep their `names` until a reader puts them in words. */
export type StoredChange = KinRecordChange & { readonly fields: ReadonlyArray<FieldChange> };

/**
 * Who wrote an entry's title and notes up to change `upTo`, newest first, and who made the entry
 * those words began on. A repeat's next occurrence (`spawnNext`) is made by Kin with the words of
 * the one it follows, so its words are that one's, as they were when it was made.
 */
export const wordsOf = Effect.fn("KinRecords.wordsOf")(function* (
  orgId: KinOrgId,
  recordId: string,
  upTo: number = Number.MAX_SAFE_INTEGER,
) {
  const sql = yield* SqlClient.SqlClient;
  const copied = sql`r.created_by_kind = 'system' AND r.origin_key LIKE 'repeat:%'`;
  const chain = sql`WITH RECURSIVE chain(record_id, bound) AS (
      SELECT ${recordId}, ${upTo}
      UNION
      SELECT substr(r.origin_key, 8), (SELECT MIN(c.seq) FROM kin_record_changes c
          WHERE c.org_id = ${orgId} AND c.record_id = chain.record_id)
        FROM chain JOIN kin_records r ON r.org_id = ${orgId} AND r.record_id = chain.record_id
        WHERE ${copied})`;
  const writers = yield* sql<{
    actorKind: string;
    actorId: string | null;
    coding: number;
    notes: number;
  }>`${chain} SELECT c.actor_kind AS "actorKind", c.actor_id AS "actorId",
      c.coding_agent_key IS NOT NULL AS coding,
      EXISTS (SELECT 1 FROM json_each(c.fields_json) f
        WHERE json_extract(f.value, '$.field') = 'notes') AS notes
    FROM chain JOIN kin_records r ON r.org_id = ${orgId} AND r.record_id = chain.record_id
    JOIN kin_record_changes c ON c.org_id = r.org_id AND c.record_id = r.record_id
      AND c.seq <= chain.bound
    WHERE EXISTS (SELECT 1 FROM json_each(c.fields_json) f
        WHERE json_extract(f.value, '$.field') IN ('title', 'notes'))
      AND NOT (c.kind = 'created' AND ${copied})
    ORDER BY c.seq DESC`;
  const [madeBy] = yield* sql<{ kind: string; id: string | null }>`${chain}
    SELECT r.created_by_kind AS kind, r.created_by_id AS id
    FROM chain JOIN kin_records r ON r.org_id = ${orgId} AND r.record_id = chain.record_id
    WHERE NOT (${copied}) ORDER BY r.created_at LIMIT 1`;
  return { writers, madeBy };
});

const changesOf = Effect.fn("KinRecords.changesOf")(function* (
  orgId: KinOrgId,
  recordId: string,
  limit: number = KIN_RECORD_CHANGES_CAP,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ChangeRow>`SELECT seq, at, actor_kind AS "actorKind",
      actor_id AS "actorId", via, kind, fields_json AS "fieldsJson"
    FROM kin_record_changes WHERE org_id = ${orgId} AND record_id = ${recordId}
    ORDER BY seq DESC LIMIT ${limit}`;
  return rows.map((row): StoredChange => ({
    seq: row.seq,
    at: iso(row.at),
    by: actorOf(row.actorKind, row.actorId),
    via: row.via,
    kind: row.kind,
    fields: parseChanges(row.fieldsJson).filter((change) => change.field.trim() !== ""),
  }));
});

const HAND_OFF_FIELDS = new Set(["owner", "handedBack", "reason", "state"]);

/** G13: the hand-back that blocks giving this task again until it changes or the owner asks. */
export const notBouncedBack = Effect.fn("KinWorkTools.notBouncedBack")(function* (
  orgId: KinOrgId,
  before: RecordRow,
  to: KinWorkPrincipal,
  turn?: { readonly agentId: KinAgentId; readonly wakeupId: string },
) {
  const who = `${to._tag}:${principalId(to)}`;
  let back: { readonly seq: number; readonly to: string | null } | undefined;
  for (const change of yield* changesOf(orgId, before.recordId, 50).pipe(workFailure)) {
    const returned = change.fields.find(
      (field) => field.field === "handedBack" && field.from === who,
    );
    if (returned !== undefined) {
      back = { seq: change.seq, to: returned.to };
      break;
    }
    if (change.fields.some((field) => !HAND_OFF_FIELDS.has(field.field))) return;
  }
  if (back === undefined) return;
  const sql = yield* SqlClient.SqlClient;
  if (turn !== undefined) {
    const owners = [...(yield* ownerLevelPeople(orgId))];
    const said = yield* sql`SELECT 1 FROM kin_events e
      JOIN kin_messages m ON m.org_id = e.org_id AND m.message_id = json_extract(e.json, '$.messageId')
        AND m.chat_id = json_extract(e.json, '$.chatId')
      WHERE e.org_id = ${orgId} AND e.agent_id = ${turn.agentId}
        AND e.wakeup_id = ${turn.wakeupId} AND e.tag = 'chat.message' AND m.author_kind = 'human'
        AND m.origin_json IS NULL AND NOT ${sql.literal(keySentSql("m.client_message_id"))}
        AND m.author_person_id IN ${sql.in(owners.length === 0 ? [""] : owners)}
      LIMIT 1`;
    if (said.length > 0) return;
  }
  const [mark] = yield* sql<{ marked: number }>`SELECT coding_agent_key IS NOT NULL AS marked
    FROM kin_record_changes
    WHERE org_id = ${orgId} AND record_id = ${before.recordId} AND seq = ${back.seq}`;
  return { to: back.to, codingAgent: mark?.marked === 1 };
});

const linksOf = Effect.fn("KinRecords.linksOf")(function* (orgId: KinOrgId, recordId: string) {
  const sql = yield* SqlClient.SqlClient;
  // Same-org joins only: the other end is opened by what this host stores, never by the target text.
  const rows = yield* sql<LinkRow>`SELECT l.kind, l.relation, l.target, l.chat_id AS "chatId",
      l.label, l.created_at AS "createdAt",
      o.record_id AS "otherId", o.key AS "otherKey", o.title AS "otherTitle",
      json_extract(o.fields_json, '$.number') AS "otherNumber",
      (o.register_id = 'docs' AND o.state = 'dropped') AS "otherDeleted",
      k.worker_id AS "workerId", k.thread_id AS "workerThreadId",
      k.environment_id AS "workerEnvironmentId", k.ended_at AS "workerEndedAt",
      k.pull_request_url AS "workerPullUrl", k.pull_request_number AS "workerPullNumber"
    FROM kin_record_links l
    LEFT JOIN kin_records o ON l.kind = 'record' AND o.org_id = l.org_id AND o.record_id = l.target
    LEFT JOIN kin_workers k ON l.kind = 'worker' AND k.org_id = l.org_id AND k.worker_id = l.target
    WHERE l.org_id = ${orgId} AND l.record_id = ${recordId}
    ORDER BY l.created_at, l.kind, l.target`;
  return rows.map((row): KinRecordLink => ({
    kind: row.kind,
    relation: row.relation,
    target: row.target,
    chatId: row.chatId === null ? null : KinChatId.make(row.chatId),
    label: row.label,
    createdAt: iso(row.createdAt),
    ...(row.otherId === null || row.otherKey === null || row.otherTitle === null
      ? {}
      : {
          record: {
            recordId: KinRecordId.make(row.otherId),
            key: row.otherKey,
            title: row.otherTitle as KinRecord["title"],
          },
          ...issuedNumber(row.otherNumber),
          ...(row.otherDeleted === 1 ? { deleted: true as const } : {}),
        }),
    ...(row.workerId === null
      ? {}
      : {
          worker: {
            threadId: row.workerThreadId === null ? null : ThreadId.make(row.workerThreadId),
            remoteEnvironmentId:
              row.workerEnvironmentId === null ? null : EnvironmentId.make(row.workerEnvironmentId),
            running: row.workerEndedAt === null,
            pullRequest:
              row.workerPullUrl === null || row.workerPullNumber === null
                ? null
                : { url: row.workerPullUrl, number: row.workerPullNumber },
          },
        }),
  }));
});

/**
 * A record's chat links as `personId` may follow them, by the rule a chat opens by (an active
 * member; the Team room only owner-level). A chat they can't open keeps no id or label, only the
 * agent it was with; a source in one is not theirs.
 */
export const chatLinksFor = Effect.fn("KinRecords.chatLinksFor")(function* <
  A extends {
    readonly links: ReadonlyArray<KinRecordLink>;
    readonly source?: KinRecordDetail["source"];
  },
>(orgId: KinOrgId, personId: KinPersonId, detail: A) {
  const chatIds = [
    ...new Set([
      ...detail.links.flatMap((link) =>
        link.kind === "message" && link.chatId !== null ? [link.chatId] : [],
      ),
      ...(detail.source?.chatId == null ? [] : [detail.source.chatId]),
    ]),
  ];
  if (chatIds.length === 0) return detail;
  const sql = yield* SqlClient.SqlClient;
  // `me` binds the reader once, so the owner-level rule reads trusted column names.
  const rows = yield* sql<{ chatId: string; open: number; agent: string | null }>`
    SELECT c.chat_id AS "chatId",
      EXISTS (SELECT 1 FROM kin_chat_members m WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id
          AND m.principal_kind = 'person' AND m.person_id = me.person_id AND m.left_at IS NULL)
        AND (c.team_id IS NOT ${KIN_TEAM_ROOM_TEAM_ID}
          OR ${sql.literal(ownerLevelSql("me.org_id", "me.person_id"))}) AS open,
      (SELECT CASE WHEN COUNT(DISTINCT a.agent_id) = 1 THEN MIN(a.display_name) END
        FROM kin_chat_members m JOIN kin_agents a ON a.org_id = m.org_id AND a.agent_id = m.agent_id
        WHERE m.org_id = c.org_id AND m.chat_id = c.chat_id AND m.principal_kind = 'agent') AS agent
    FROM kin_chats c, (SELECT ${orgId} AS org_id, ${personId} AS person_id) me
    WHERE c.org_id = ${orgId} AND c.chat_id IN ${sql.in(chatIds)}
    ORDER BY c.chat_id`;
  const chats = new Map(rows.map((row) => [row.chatId, row]));
  const opens = (chatId: string) => chats.get(chatId)?.open === 1;
  return {
    ...detail,
    links: detail.links.map((link): KinRecordLink =>
      link.kind !== "message" || link.chatId === null || opens(link.chatId)
        ? link
        : {
            ...link,
            chatId: null,
            label: null,
            closedChat: { agent: chats.get(link.chatId)?.agent ?? null },
          },
    ),
    ...(detail.source?.chatId == null || opens(detail.source.chatId)
      ? {}
      : { source: { chatId: null, messageId: null } }),
  };
});

/**
 * An entry's "after reading" line for its reader: anyone reads what kind of text it was; an
 * owner-level reader also reads where it came from (`renderSource`).
 */
export const afterReadingFor = Effect.fn("KinRecords.afterReadingFor")(function* <
  A extends { readonly recordId: string; readonly afterReading?: KinRecordDetail["afterReading"] },
>(orgId: KinOrgId, ownerLevelReader: boolean, detail: A) {
  if (detail.afterReading === undefined || !ownerLevelReader) return detail;
  const afterReading = yield* entryAfterReading(orgId, detail.recordId, true);
  return afterReading === undefined ? detail : { ...detail, afterReading };
});

export const toDetail = Effect.fn("KinRecords.toDetail")(function* (
  row: RecordRow,
  now: number,
  changeLimit?: number,
) {
  const orgId = row.orgId as KinOrgId;
  const reason = row.registerId === "work" ? parseFields(row.fieldsJson).reason : undefined;
  const checklist = stepsOf(row);
  return {
    ...toRecord(row, now),
    notes: row.notes,
    source: {
      chatId: row.sourceChatId === null ? null : KinChatId.make(row.sourceChatId),
      messageId: row.sourceMessageId === null ? null : KinMessageId.make(row.sourceMessageId),
    },
    assignedBy: principal("person", row.assignedBy),
    assignedAt: row.assignedAt === null ? null : iso(row.assignedAt),
    ...(row.assignedByAgent === null
      ? {}
      : { assignedByAgent: KinAgentId.make(row.assignedByAgent) }),
    ...(typeof reason === "string" ? { reason } : {}),
    // Even empty, it tells a screen this host keeps a task's steps.
    ...(row.registerId === "work" ? { checklist } : {}),
    createdBy: actorOf(row.createdByKind, row.createdById),
    links: yield* linksOf(orgId, row.recordId),
    changes: yield* changesOf(orgId, row.recordId, changeLimit),
    seq: yield* recordSeq(orgId, row.recordId),
    ...(isBuiltIn(row.registerId) ? {} : yield* definedDetail(row)),
    ...(yield* entryAfterReading(orgId, row.recordId).pipe(
      Effect.map((afterReading) => (afterReading === undefined ? {} : { afterReading })),
    )),
  } satisfies KinRecordDetail;
});

const decodeAttachments = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(KinAttachment)),
);
/** A defined list's fields, the files they keep and, where it is paid over time, its payments. */
const definedDetail = Effect.fn("KinRecords.definedDetail")(function* (row: RecordRow) {
  const sql = yield* SqlClient.SqlClient;
  const orgId = row.orgId as KinOrgId;
  const fields = parseFields(row.fieldsJson);
  const ids = [
    ...new Set(
      Object.values(fields).flatMap((value) =>
        Array.isArray(value) ? (value as ReadonlyArray<string>) : [],
      ),
    ),
  ];
  const stored =
    ids.length === 0
      ? []
      : yield* sql<{ id: string; chatId: string; messageId: string; json: string | null }>`
          SELECT a.attachment_id AS id, a.chat_id AS "chatId", a.message_id AS "messageId",
            m.attachments_json AS json
          FROM kin_message_attachments a
          JOIN kin_messages m ON m.org_id = a.org_id AND m.message_id = a.message_id
          WHERE a.org_id = ${orgId} AND a.attachment_id IN ${sql.in(ids)} AND m.status <> 'deleted'
          ORDER BY a.attachment_id`;
  const files = stored.flatMap((file): ReadonlyArray<KinFileRef> => {
    const found = Option.getOrElse(decodeAttachments(file.json ?? "[]"), () => []).find(
      (attachment) => attachment.id === file.id,
    );
    return found === undefined
      ? []
      : [
          {
            attachmentId: file.id,
            name: found.name,
            mimeType: found.mimeType,
            chatId: KinChatId.make(file.chatId),
            messageId: KinMessageId.make(file.messageId),
          },
        ];
  });
  const payments = row.takesPayments === 1 ? yield* paymentsOf(orgId, row.recordId) : undefined;
  const sent = yield* sentWith(orgId, row.recordId);
  const bank = row.registerId === "invoices" ? yield* bankKnown(orgId) : undefined;
  return {
    fields,
    ...(files.length === 0 ? {} : { files }),
    ...(payments === undefined ? {} : { payments }),
    ...(bank === undefined ? {} : { bankKnown: { through: bank.through } }),
    ...(sent.length === 0 ? {} : { sent }),
  };
});

/** Mail that carried this entry's file, sent on the owner level's Confirm (`connections/Sending.ts`). */
const sentWith = Effect.fn("KinRecords.sentWith")(function* (orgId: KinOrgId, recordId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    to: string | null;
    subject: string | null;
    threadId: string | null;
    at: number;
  }>`
    SELECT COALESCE(json_extract(payload_json, '$.confirmed.to'),
        json_extract(payload_json, '$.to')) AS "to",
      COALESCE(json_extract(payload_json, '$.confirmed.subject'),
        json_extract(payload_json, '$.subject')) AS subject,
      json_extract(result_json, '$.threadId') AS "threadId", done_at AS at
    FROM kin_connection_asks k
    WHERE k.org_id = ${orgId} AND k.entry_record_id = ${recordId} AND k.state = 'sent'
      -- A person's own mailbox's mail stays theirs: the record keeps only its client's touch.
      AND NOT EXISTS (SELECT 1 FROM kin_connections c WHERE c.org_id = k.org_id
        AND c.connection_id = k.connection_id AND c.person_id IS NOT NULL)
    ORDER BY k.done_at DESC, k.ask_id LIMIT 20`;
  return rows.map((sent) => ({
    to: Option.getOrElse(decodeAddresses(sent.to ?? "[]"), () => []),
    subject: sent.subject ?? "",
    at: iso(sent.at),
    threadId: sent.threadId,
  }));
});
const decodeAddresses = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

const paymentsOf = Effect.fn("KinRecords.paymentsOf")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<
    {
      paymentId: string;
      minor: number;
      currency: string;
      paidOn: string;
      note: string;
      originKey: string;
      createdAt: number;
      voidedAt: number | null;
      withheld: number;
    } & PaymentSourceRow
  >`SELECT p.payment_id AS "paymentId", p.amount_minor AS minor, p.currency,
      p.paid_on AS "paidOn", p.note, p.origin_key AS "originKey", p.created_at AS "createdAt",
      p.voided_at AS "voidedAt", p.withheld, ${paymentSourceColumns(sql)}
    FROM kin_record_payments p WHERE p.org_id = ${orgId} AND p.record_id = ${recordId}
    ORDER BY p.paid_on DESC, p.created_at DESC, p.payment_id`;
  const receipts =
    rows.length === 0
      ? []
      : yield* sql<{ payment: string; key: string; number: string | null; doc: string | null }>`
        SELECT json_extract(r.fields_json, '$.payment') AS payment, r.key, n.number,
          (SELECT d.key FROM kin_doc_jobs j
            JOIN kin_doc_versions v ON v.org_id = j.org_id AND v.worker_id = j.worker_id
            JOIN kin_records d ON d.org_id = v.org_id AND d.record_id = v.record_id
            WHERE j.org_id = r.org_id AND j.entry_record_id = r.record_id AND j.recipe = 'receipt'
            ORDER BY j.created_at DESC LIMIT 1) AS doc
        FROM kin_records r
        LEFT JOIN kin_issued_numbers n ON n.org_id = r.org_id AND n.record_id = r.record_id
        WHERE r.org_id = ${orgId} AND r.register_id = 'receipts' AND r.state <> 'dropped'
          AND r.origin_key LIKE 'receipt:%'
          AND json_extract(r.fields_json, '$.payment') IN ${sql.in(rows.map((row) => row.paymentId))}
        ORDER BY r.created_at DESC, r.record_id DESC`;
  const numbers = yield* notedReceiptNumbers(
    orgId,
    rows.filter(fromImport).map((row) => row.note),
  );
  return rows.map((payment): KinPayment => {
    const receipt = receipts.find((one) => one.payment === payment.paymentId);
    const noted = fromImport(payment) ? numbers.get(payment.note) : undefined;
    return {
      paymentId: payment.paymentId,
      amount: { minor: payment.minor, currency: payment.currency },
      paidOn: payment.paidOn,
      note: payment.note,
      recordedAt: iso(payment.createdAt),
      voidedAt: payment.voidedAt === null ? null : iso(payment.voidedAt),
      ...(payment.withheld === 1 ? { withheld: true as const } : {}),
      source: paymentSourceOf(payment),
      receipt:
        receipt === undefined && noted === undefined
          ? null
          : {
              key: receipt?.key ?? null,
              number: receipt?.number ?? noted ?? null,
              receivedOn: payment.paidOn,
              amount: { minor: payment.minor, currency: payment.currency },
              document: receipt?.doc ?? null,
            },
    };
  });
});

type PaymentSourceRow = {
  readonly byKind: string;
  readonly byId: string | null;
  readonly fromBank: number;
  readonly wordOf: string | null;
};
/**
 * SQL over `kin_record_payments p` for where each payment came from, from what Kin already keeps:
 * a line of a statement still confirmed made it or was matched to it; else who wrote it. An agent's payment keeps the
 * turn's event in its origin (`lead:<agent>:<event>:…`), and that event names the person whose
 * message or tap it was.
 */
const paymentSourceColumns = (sql: SqlClient.SqlClient) => sql`p.created_by_kind AS "byKind",
  p.created_by_id AS "byId",
  EXISTS (SELECT 1 FROM kin_bank_statement_entries be
    JOIN kin_bank_statements bs ON bs.org_id = be.org_id AND bs.statement_id = be.statement_id
    WHERE be.org_id = p.org_id AND bs.applied_at IS NOT NULL AND bs.undone_at IS NULL
      AND (be.payment_id = p.payment_id OR (be.payment_id IS NULL AND be.action = 'payment'
        AND be.target_record_id = p.record_id
        AND json_extract(be.prior_json, '$.matched') = p.payment_id))) AS "fromBank",
  CASE WHEN p.created_by_kind = 'agent' AND p.created_by_id IS NOT NULL
      AND substr(p.origin_key, 1, length(p.created_by_id) + 6) = 'lead:' || p.created_by_id || ':'
    THEN (SELECT json_extract(ev.json, '$.provenance.personId') FROM kin_events ev
      WHERE ev.event_id = substr(p.origin_key, length(p.created_by_id) + 7,
          instr(substr(p.origin_key, length(p.created_by_id) + 7), ':') - 1)
        AND ev.org_id = p.org_id AND ev.agent_id = p.created_by_id
        AND json_extract(ev.json, '$.provenance._tag') = 'human'
        AND COALESCE(json_extract(ev.json, '$.reason'), '') <> 'joined')
  END AS "wordOf"`;
const paymentSourceOf = (row: PaymentSourceRow): KinPaymentSource =>
  row.fromBank === 1
    ? { _tag: "statement" }
    : row.byKind === "person" && row.byId !== null
      ? { _tag: "person", personId: KinPersonId.make(row.byId) }
      : row.byKind === "agent" && row.byId !== null
        ? row.wordOf === null
          ? { _tag: "agent", agentId: KinAgentId.make(row.byId) }
          : {
              _tag: "person",
              personId: KinPersonId.make(row.wordOf),
              agentId: KinAgentId.make(row.byId),
            }
        : { _tag: "recorded" };

/** Written by an import: only such a payment's note can hold a number another system issued. */
export const fromImport = (payment: { readonly originKey: string }) =>
  payment.originKey.startsWith("import:");
/** `QST-RN/2026-27/001`: a receipt number another system issued, written in a payment's note. */
const RECEIPT_IN_NOTE =
  /(?<![A-Za-z0-9/-])([A-Za-z][A-Za-z0-9-]{0,7}\/(?:\d{2})?\d{2}-\d{2}\/\d{1,9})(?![A-Za-z0-9/-])/g;
/** Every number in a note shaped like a receipt number, in order. */
export const receiptNumbersIn = (note: string) =>
  [...note.matchAll(RECEIPT_IN_NOTE)].map((found) => found[1]!);
/**
 * The receipt number each payment note holds, such as "Advance received; receipt note
 * QST-RN/2026-27/001": its first number of that shape that isn't a number of an entry in another
 * list, such as the invoice's own. Notes with none aren't in the map.
 */
export const notedReceiptNumbers = Effect.fn("KinRecords.notedReceiptNumbers")(function* (
  orgId: KinOrgId,
  notes: ReadonlyArray<string>,
) {
  const found = new Map(notes.map((note) => [note, receiptNumbersIn(note)] as const));
  const shaped = [...new Set([...found.values()].flat())];
  const noted = new Map<string, string>();
  if (shaped.length === 0) return noted;
  const sql = yield* SqlClient.SqlClient;
  const other = new Set(
    (yield* sql<{ number: string }>`SELECT number FROM kin_issued_numbers
      WHERE org_id = ${orgId} AND register_id <> 'receipts' AND number IN ${sql.in(shaped)}`).map(
      (row) => row.number,
    ),
  );
  for (const [note, numbers] of found) {
    const number = numbers.find((one) => !other.has(one));
    if (number !== undefined) noted.set(note, number);
  }
  return noted;
});

export const recordSeq = Effect.fn("KinRecords.recordSeq")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ seq: number | null }>`SELECT MAX(seq) AS seq FROM kin_record_changes
    WHERE org_id = ${orgId} AND record_id = ${recordId}`;
  return row?.seq ?? 0;
});

/** The latest change number in an org, which clients and cursors compare against. */
export const latestSeq = Effect.fn("KinRecords.latestSeq")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ seq: number | null }>`SELECT MAX(seq) AS seq FROM kin_record_changes
    WHERE org_id = ${orgId}`;
  return row?.seq ?? 0;
});

/** The zone Kin uses until the owner sets one: the host's, whose clock check-ins run on. */
export const unsetOwnerZone = () => {
  const host = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return validZone(host) ? host : "UTC";
};

/** The owner's IANA zone, for all-day due dates; the host's until he sets one. */
export const ownerZone = Effect.fn("KinRecords.ownerZone")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  // oxlint-disable-next-line t3code/kin-zoned-time -- this is the one owner-zone read
  const [row] = yield* sql<{ zone: string | null }>`SELECT time_zone AS zone
    FROM kin_trigger_settings WHERE org_id = ${orgId} ORDER BY org_id`.pipe(
    Effect.orElseSucceed(() => []),
  );
  const zone = row?.zone ?? unsetOwnerZone();
  return validZone(zone) ? zone : unsetOwnerZone();
});
const validZone = (zone: string) => {
  try {
    return canonicalTimeZone(zone) !== "";
  } catch {
    return false;
  }
};

const dayStart = (day: string, zone: string) => {
  const [year, month, date] = day.split("-").map((part) => Number.parseInt(part, 10));
  return DateTime.makeZonedUnsafe(
    { year: year ?? 1970, month: month ?? 1, day: date ?? 1 },
    { timeZone: zone, adjustForTimeZone: true },
  );
};
const calendarDay = (ms: number, zone: string) =>
  Date.parse(DateTime.formatIsoDate(DateTime.makeZonedUnsafe(ms, { timeZone: zone })));
/**
 * Days overdue, for money and tasks alike: whole calendar days in `zone`, the company's, from the
 * day `dueAt` falls on to today's. Due the 8th, on the 20th that is 12; due today, 0.
 */
export const daysOverdue = (dueAt: number, now: number, zone: string) =>
  Math.max(0, Math.round((calendarDay(now, zone) - calendarDay(dueAt, zone)) / DAY_MS));
/** How long an owed invoice is overdue, after "overdue": "for 12 days" counted as `daysOverdue`. */
export const overdueFor = (dueAt: number, days: number, now: number, zone: string) =>
  days >= 2 && days < 60
    ? `for ${days} days`
    : formatKinLate(dueAt, now, { zone, locale: KIN_TEXT_LOCALE });
/** A calendar day's last millisecond in `zone`: an all-day entry is late only once it is over. */
export const endOfDay = (day: string, zone: string) =>
  DateTime.toEpochMillis(DateTime.add(dayStart(day, zone), { days: 1 })) - 1;
/** A due as a person reads it: a day is the company's calendar day for anyone, a time their own. */
export const dueWhenText = (
  at: number,
  allDay: boolean,
  company: string,
  clock: { readonly zone: string; readonly locale: string },
  timed: "day" | "dayTime" = "dayTime",
) =>
  allDay
    ? formatKinWhen(at, "day", { zone: company, locale: clock.locale })
    : formatKinWhen(at, timed, clock);
/** A task's due as the tasks tools write it, in the company's zone. */
export const dueText = (dueAt: number, allDay: boolean, zone: string) =>
  dueWhenText(dueAt, allDay, zone, { zone, locale: KIN_TEXT_LOCALE });
/** A date field's value as an instant: a day is its last millisecond, as an all-day entry's is. */
export const fieldDateAt = (value: string, zone: string) => {
  if (value.length === 10) return { at: endOfDay(value, zone), allDay: true };
  const [hour, minute] = value
    .slice(11)
    .split(":")
    .map((part) => Number.parseInt(part, 10));
  const [year, month, day] = value
    .slice(0, 10)
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  return {
    at: DateTime.toEpochMillis(
      DateTime.makeZonedUnsafe(
        {
          year: year ?? 1970,
          month: month ?? 1,
          day: day ?? 1,
          hour: hour ?? 0,
          minute: minute ?? 0,
        },
        { timeZone: zone, adjustForTimeZone: true },
      ),
    ),
    allDay: false,
  };
};
/** A calendar day's first millisecond in `zone`. */
export const startOfDay = (day: string, zone: string) =>
  DateTime.toEpochMillis(dayStart(day, zone));
