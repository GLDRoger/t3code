import {
  KinAgentId,
  KinChatError,
  KinPersonId,
  KinRecordKey,
  type KinOrgId,
  type KinPulseAside,
  type KinPulseFact,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";

import { outsideRead } from "../lead/OutsideContent.ts";
import { ownerLevelSql } from "../people/KinAccess.ts";
import { dayIn } from "../work/money.ts";
import { iso } from "./senses/shared.ts";

/**
 * A record set aside (`kin_holds`): one live hold per record for the company, and one per teammate
 * for their own view. `asideOf` is the one answer to "is this set aside now" every reader uses.
 */

/** Holding one of these holds everything scoped to it too. */
const COVERS_ALL = new Set(["clients", "projects"]);

export interface Hold {
  readonly holdId: string;
  readonly recordId: string;
  readonly recordKey: string;
  readonly title: string;
  readonly register: string;
  /** Null: the company's. */
  readonly forPersonId: string | null;
  readonly until: number | null;
  readonly byKind: "person" | "agent";
  readonly byId: string;
  readonly onWordOf: string | null;
  readonly note: string | null;
  readonly setAt: number;
  /** When it ended, by its day or a lift; null while live. */
  readonly endedAt: number | null;
  readonly liftedByKind: "person" | "agent" | null;
  readonly liftedById: string | null;
}

/** Who a read is for, as `KinPulse.Viewer` has it. */
type Reader =
  | { readonly _tag: "owner" }
  | { readonly _tag: "people"; readonly people: ReadonlyArray<string> };

const holdRows = (sql: SqlClient.SqlClient, orgId: KinOrgId, where: Statement.Fragment) =>
  sql<Omit<Hold, "endedAt"> & { liftedAt: number | null }>`SELECT h.hold_id AS "holdId",
      h.record_id AS "recordId", r.key AS "recordKey", r.title, r.register_id AS register,
      h.for_person_id AS "forPersonId", h.until_at AS until, h.set_by_kind AS "byKind",
      h.set_by_id AS "byId", h.on_word_of AS "onWordOf", h.note, h.set_at AS "setAt",
      h.lifted_at AS "liftedAt", h.lifted_by_kind AS "liftedByKind", h.lifted_by_id AS "liftedById"
    FROM kin_holds h JOIN kin_records r ON r.org_id = h.org_id AND r.record_id = h.record_id
    WHERE h.org_id = ${orgId} AND ${where}
    ORDER BY h.set_at, h.hold_id`;

const ended = (row: { liftedAt: number | null; until: number | null }, at: number) =>
  row.liftedAt ?? (row.until !== null && row.until <= at ? row.until : null);

/** Every hold that applies at `at`: not lifted, and its day not come. */
export const liveHolds = Effect.fn("KinHolds.live")(function* (orgId: KinOrgId, at: number) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* holdRows(
    sql,
    orgId,
    sql`h.lifted_at IS NULL AND (h.until_at IS NULL OR h.until_at > ${at})`,
  );
  return rows.map(({ liftedAt: _liftedAt, ...row }): Hold => ({ ...row, endedAt: null }));
});

/** Holds that ended (their day came, or a lift) after `since`, latest first. */
export const endedHolds = Effect.fn("KinHolds.ended")(function* (
  orgId: KinOrgId,
  since: number,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* holdRows(
    sql,
    orgId,
    sql`h.for_person_id IS NULL AND ((h.lifted_at > ${since} AND h.lifted_at <= ${at})
      OR (h.lifted_at IS NULL AND h.until_at > ${since} AND h.until_at <= ${at}))`,
  );
  return rows
    .map(({ liftedAt, ...row }): Hold => ({ ...row, endedAt: ended({ liftedAt, ...row }, at) }))
    .toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
});

/** Whether `hold` covers a fact about `fact.subject`, scoped as `fact.scope` says. */
export const covers = (
  hold: Pick<Hold, "recordId" | "recordKey" | "register">,
  fact: Pick<KinPulseFact, "subject" | "scope">,
) =>
  fact.subject.recordId === hold.recordId ||
  (COVERS_ALL.has(hold.register) &&
    (fact.scope.clientKey === hold.recordKey || fact.scope.projectKey === hold.recordKey));

/** Whether `hold` counts for this reader: the company's for everyone, a teammate's for them. */
const counts = (hold: Hold, reader: Reader) =>
  hold.forPersonId === null ||
  (reader._tag === "people" && reader.people.some((person) => person === hold.forPersonId));

/**
 * The hold that sets this fact aside for `reader` now, if any: the one function every reader
 * of the pulse goes through. Pass facts as sensed, before a teammate's view drops scope names.
 */
export const asideOf = (
  fact: Pick<KinPulseFact, "subject" | "scope">,
  holds: ReadonlyArray<Hold>,
  reader: Reader,
) => holds.find((hold) => counts(hold, reader) && covers(hold, fact));

/** The holds a reader sees, one per record: theirs and the company's. */
export const holdsFor = (holds: ReadonlyArray<Hold>, reader: Reader) =>
  holds.filter((hold) => counts(hold, reader));

/** A hold as a screen or an agent reads it; `liftable` for this reader. */
export const asideView = (hold: Hold, reader: Reader, readerId?: string): KinPulseAside => ({
  record: { key: KinRecordKey.make(hold.recordKey), title: hold.title.slice(0, 280) },
  covers: COVERS_ALL.has(hold.register) ? "all" : "only",
  until: hold.until === null ? null : iso(hold.until),
  by:
    hold.byKind === "agent"
      ? { _tag: "agent", agentId: KinAgentId.make(hold.byId) }
      : { _tag: "person", personId: KinPersonId.make(hold.byId) },
  onWordOf: hold.onWordOf === null ? null : KinPersonId.make(hold.onWordOf),
  mine: hold.forPersonId !== null,
  at: iso(hold.setAt),
  note: hold.note,
  liftable: reader._tag === "owner" ? hold.forPersonId === null : hold.forPersonId !== null,
  byYou: readerId !== undefined && hold.byKind === "person" && hold.byId === readerId,
  yourWord: readerId !== undefined && hold.onWordOf === readerId,
});

/** "C-7 Lumen Foods and everything under it" or "INV-9 Site build only". */
export const subjectText = (aside: Pick<KinPulseAside, "record" | "covers">) =>
  `${aside.record.key} ${aside.record.title}${aside.covers === "all" ? " and everything under it" : " only"}`;

/**
 * One line on a hold for an agent: "INV-9 Site build only is set aside until 2026-12-17, by
 * Finance on Rhea's word (2026-11-20)". `names` maps agent and person ids to names.
 */
export const asideLine = (
  aside: KinPulseAside,
  names: ReadonlyMap<string, string>,
  zone: string,
) => {
  const byId = aside.by._tag === "agent" ? aside.by.agentId : aside.by.personId;
  const who = names.get(byId) ?? (aside.by._tag === "agent" ? "an agent" : "a person");
  const word =
    aside.onWordOf === null ? "" : ` on ${names.get(aside.onWordOf) ?? "a person"}'s word`;
  const until =
    aside.until === null
      ? "until someone lifts it"
      : `until ${dayIn(DateTime.toEpochMillis(aside.until), zone)}`;
  return `${subjectText(aside)} is set aside ${until}, by ${who}${word} (${dayIn(DateTime.toEpochMillis(aside.at), zone)})${aside.note === null ? "" : `: ${aside.note}`}`;
};

/** Agents' and people's names in an org, for hold lines. */
export const holdNames = Effect.fn("KinHolds.names")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ id: string; name: string }>`SELECT agent_id AS id,
      display_name AS name FROM kin_agents WHERE org_id = ${orgId}
    UNION ALL SELECT person_id AS id, display_name AS name FROM kin_people WHERE org_id = ${orgId}
    ORDER BY id`;
  return new Map(rows.map((row) => [row.id, row.name]));
});

/** The record a hold is on, by key, in this org. */
export const holdRecord = Effect.fn("KinHolds.record")(function* (orgId: KinOrgId, key: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ recordId: string; key: string; title: string; register: string }>`
    SELECT record_id AS "recordId", key, title, register_id AS register FROM kin_records
    WHERE org_id = ${orgId} AND key = ${key} ORDER BY record_id LIMIT 1`;
  if (row === undefined)
    return yield* new KinChatError({ reason: "not_found", message: `No record ${key} here.` });
  return row;
});

/**
 * The one person whose own message or card tap in that chat woke this turn, beside nothing passed
 * on (an origin, a hand-off, outside words), no other person's event and no outside text read;
 * else null. Kin's own events beside it keep the word. Looser than `KinAccess.ownerLevelAsked`.
 */
export const wordOf = Effect.fn("KinHolds.wordOf")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: string;
  readonly wakeupId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    person: string | null;
    by: string | null;
    passedOn: number;
    ownerLevel: number;
  }>`WITH woke AS (SELECT e.event_id AS id, e.tag,
        json_extract(e.json, '$.origin') IS NOT NULL AS origin,
        CASE WHEN json_extract(e.json, '$.provenance._tag') = 'human'
          THEN json_extract(e.json, '$.provenance.personId') END AS by,
        CASE WHEN e.tag IN ('chat.message', 'widget.action')
            AND json_extract(e.json, '$.origin') IS NULL AND m.origin_json IS NULL
            AND m.author_kind = 'human' AND m.chat_id = json_extract(e.json, '$.chatId')
          THEN m.author_person_id END AS person,
        COALESCE(${sql.literal(ownerLevelSql("m.org_id", "m.author_person_id"))}, 0) AS "ownerLevel"
      FROM kin_events e
      LEFT JOIN kin_messages m ON m.org_id = e.org_id AND e.tag IN ('chat.message', 'widget.action')
        AND m.message_id = json_extract(e.json, '$.messageId')
        AND (m.kind = 'widget_action') = (e.tag = 'widget.action')
      WHERE e.org_id = ${input.orgId} AND e.agent_id = ${input.agentId}
        AND e.wakeup_id = ${input.wakeupId})
    SELECT person, by, "ownerLevel", (origin OR tag = 'github'
        OR (tag IN ('chat.message', 'widget.action') AND person IS NULL)) AS "passedOn"
    FROM woke ORDER BY id`;
  const said = rows.find((row) => row.person !== null);
  if (said === undefined || said.person === null) return null;
  const person = said.person;
  const beside = rows.every((row) =>
    row.person === null
      ? row.passedOn === 0 && (row.by === null || row.by === person)
      : row.person === person,
  );
  if (!beside || (yield* outsideRead(input))) return null;
  return { personId: KinPersonId.make(person), ownerLevel: said.ownerLevel === 1 };
});

const holdId = (parts: ReadonlyArray<string | number | null>) =>
  `hold-${NodeCrypto.createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\0"))
    .digest("hex")
    .slice(0, 24)}`;

/**
 * Sets `recordKey` aside for the company (`forPersonId` null) or one teammate, replacing the live
 * hold there; the same hold again changes nothing. Facts it covers lose their told rows (for that
 * teammate only, for theirs), so each is told once when it ends. `covered` are sensed facts' keys.
 */
export const setHold = Effect.fn("KinHolds.set")(function* (input: {
  readonly orgId: KinOrgId;
  readonly at: number;
  readonly recordKey: string;
  readonly forPersonId: string | null;
  readonly until: number | null;
  readonly by: KinWorkPrincipal;
  readonly onWordOf: string | null;
  readonly note: string | null;
  readonly covered: (
    hold: Pick<Hold, "recordId" | "recordKey" | "register">,
  ) => ReadonlyArray<string>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = input;
  if (input.until !== null && input.until <= at)
    return yield* new KinChatError({
      reason: "invalid_state",
      message: "The day it is set aside until must be after today.",
    });
  const record = yield* holdRecord(orgId, input.recordKey);
  const byKind = input.by._tag;
  const byId = input.by._tag === "agent" ? input.by.agentId : input.by.personId;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const [live] = yield* sql<{
        holdId: string;
        until: number | null;
        byKind: string;
        byId: string;
        onWordOf: string | null;
        note: string | null;
      }>`SELECT hold_id AS "holdId", until_at AS until, set_by_kind AS "byKind",
          set_by_id AS "byId", on_word_of AS "onWordOf", note FROM kin_holds
        WHERE org_id = ${orgId} AND record_id = ${record.recordId} AND lifted_at IS NULL
          AND COALESCE(for_person_id, '') = ${input.forPersonId ?? ""}
        ORDER BY hold_id`;
      const same =
        live !== undefined &&
        (live.until === null || live.until > at) &&
        live.until === input.until &&
        live.byKind === byKind &&
        live.byId === byId &&
        live.onWordOf === input.onWordOf &&
        live.note === input.note;
      if (!same) {
        if (live !== undefined)
          yield* sql`UPDATE kin_holds SET lifted_at = CASE
                WHEN until_at IS NOT NULL AND until_at <= ${at} THEN until_at ELSE ${at} END,
              lifted_by_kind = ${byKind}, lifted_by_id = ${byId}
            WHERE org_id = ${orgId} AND hold_id = ${live.holdId}`;
        yield* sql`INSERT INTO kin_holds (hold_id, org_id, record_id, for_person_id, until_at,
            set_by_kind, set_by_id, on_word_of, note, set_at)
          VALUES (${holdId([orgId, record.recordId, input.forPersonId, at, byId, input.until, input.note])}, ${orgId},
            ${record.recordId}, ${input.forPersonId}, ${input.until}, ${byKind}, ${byId},
            ${input.onWordOf}, ${input.note}, ${at})`;
        const stored = yield* sql<{ key: string }>`SELECT fact_key AS key FROM kin_pulse_facts
          WHERE org_id = ${orgId} AND (subject_record_id = ${record.recordId}
            OR (${COVERS_ALL.has(record.register) ? 1 : 0} = 1
              AND (json_extract(scope_json, '$.clientKey') = ${record.key}
                OR json_extract(scope_json, '$.projectKey') = ${record.key})))
          ORDER BY fact_key`;
        const keys = [
          ...new Set([
            ...stored.map((row) => row.key),
            ...input.covered({ ...record, recordKey: record.key }),
          ]),
        ];
        for (let start = 0; start < keys.length; start += 500)
          yield* sql`DELETE FROM kin_pulse_told WHERE org_id = ${orgId}
            AND fact_key IN ${sql.in(keys.slice(start, start + 500))}
            AND (${input.forPersonId === null ? 1 : 0} = 1 OR person_id = ${input.forPersonId ?? ""})`;
      }
      const [hold] = (yield* liveHolds(orgId, at)).filter(
        (one) => one.recordId === record.recordId && one.forPersonId === input.forPersonId,
      );
      return hold!;
    }),
  );
});

/**
 * Lifts the live hold on `recordKey` for the company or one teammate; its facts are news again.
 * Nothing live there: null, as after a retry.
 */
export const liftHold = Effect.fn("KinHolds.lift")(function* (input: {
  readonly orgId: KinOrgId;
  readonly at: number;
  readonly recordId: string;
  readonly forPersonId: string | null;
  readonly by: KinWorkPrincipal;
}) {
  const sql = yield* SqlClient.SqlClient;
  const [hold] = (yield* liveHolds(input.orgId, input.at)).filter(
    (one) => one.recordId === input.recordId && one.forPersonId === input.forPersonId,
  );
  if (hold === undefined) return null;
  yield* sql`UPDATE kin_holds SET lifted_at = ${input.at}, lifted_by_kind = ${input.by._tag},
      lifted_by_id = ${input.by._tag === "agent" ? input.by.agentId : input.by.personId}
    WHERE org_id = ${input.orgId} AND hold_id = ${hold.holdId} AND lifted_at IS NULL`;
  return hold;
});

/** A refusal to ask about a held record: the subject, the day and whose word it was. */
export const refusalText = (hold: Hold, names: ReadonlyMap<string, string>, zone: string) =>
  `${asideLine(asideView(hold, { _tag: "owner" }), names, zone)}. Kin won't ask about it before then.`;

/**
 * The live hold on any of these records, or on its project or client, that counts for `personId`
 * (the company's, or that person's own): what a question about them may not be raised over.
 */
export const holdOverAbout = Effect.fn("KinHolds.overAbout")(function* (input: {
  readonly orgId: KinOrgId;
  readonly at: number;
  readonly keys: ReadonlyArray<string>;
  readonly personId: string;
}) {
  if (input.keys.length === 0) return undefined;
  const holds = (yield* liveHolds(input.orgId, input.at)).filter(
    (hold) => hold.forPersonId === null || hold.forPersonId === input.personId,
  );
  if (holds.length === 0) return undefined;
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ recordId: string; projectId: string | null; clientId: string | null }>`
    SELECT r.record_id AS "recordId", p.record_id AS "projectId", c.record_id AS "clientId"
    FROM kin_records r
      LEFT JOIN kin_records p ON p.org_id = r.org_id AND p.record_id = r.project_id
      LEFT JOIN kin_records c ON c.org_id = r.org_id
        AND c.record_id = COALESCE(r.party_id, p.party_id)
    WHERE r.org_id = ${input.orgId} AND r.key IN ${sql.in(input.keys.slice(0, 50))}
    ORDER BY r.record_id`;
  return holds.find((hold) =>
    rows.some(
      (row) =>
        row.recordId === hold.recordId ||
        (COVERS_ALL.has(hold.register) &&
          (row.projectId === hold.recordId || row.clientId === hold.recordId)),
    ),
  );
});
