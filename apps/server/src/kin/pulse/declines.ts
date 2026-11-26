import { KinChatError, type KinOrgId, type KinPersonId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { keySentSql } from "../chat/keySent.ts";
import { accessSql } from "../people/KinAccess.ts";
import { NUDGE_PREFIX } from "../reply/promises.ts";
import { dayIn } from "../work/money.ts";
import { ownerZone } from "../work/recordRows.ts";
import { viewSees } from "../work/teamView.ts";
import { holdId, wordMessages, type WordTurn } from "./holds.ts";

const PREFIX = "declined:";
const encodeKeys = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
export const isDeclineKey = (key: string) => key.startsWith(PREFIX);

type Decline = { holdId: string; recordKey: string; title: string; name: string };

export const declineLine = ({ recordKey, title, name }: Omit<Decline, "holdId">) =>
  `${recordKey} ${title}: ${name} turned down a nudge about it, so no more nudges to ${name} about it until it changes or ${name} brings it up.`.replace(
    /[\r\n\u2028\u2029]+/gu,
    " ",
  );

const postedNudges = (sql: SqlClient.SqlClient, orgId: KinOrgId) => sql`
  SELECT n.fact_key, m.message_id, m.chat_id, m.seq, n.person_id
  FROM kin_pulse_nudges n JOIN kin_messages m ON m.org_id = n.org_id AND m.chat_id = n.chat_id
    AND m.author_agent_id = n.agent_id
    AND m.client_message_id = ${`send:${NUDGE_PREFIX}`} || n.person_id || ':' || n.day
  WHERE n.org_id = ${orgId} AND m.status = 'posted'
  UNION
  SELECT json_extract(plan.plan_json, '$.factKey'), m.message_id, m.chat_id, m.seq,
    json_extract(plan.plan_json, '$.personId')
  FROM kin_card_plans plan JOIN kin_widgets w ON w.org_id = plan.org_id AND w.widget_id = plan.widget_id
  JOIN kin_messages m ON m.org_id = w.org_id AND m.chat_id = w.chat_id AND m.message_id = w.message_id
  WHERE plan.org_id = ${orgId} AND m.status = 'posted'
    AND m.client_message_id GLOB 'send:kin-fact-card:*'
    AND json_extract(plan.plan_json, '$.factKey') IS NOT NULL
    AND json_extract(plan.plan_json, '$.personId') IS NOT NULL`;

const liveRows = Effect.fn("KinDeclines.live")(function* (
  orgId: KinOrgId,
  at: number,
  where: Statement.Fragment,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const rows = yield* sql<
        Decline & { day: string | null; dueAt: number | null; changed: number }
      >`
      WITH nudges AS (${postedNudges(sql, orgId)})
      SELECT h.hold_id AS "holdId", r.key AS "recordKey", r.title, p.display_name AS name,
        json_extract(h.decline_json, '$.day') AS day, r.due_at AS "dueAt",
        (r.state IS NOT json_extract(h.decline_json, '$.state')
          OR r.owner_kind IS NOT json_extract(h.decline_json, '$.holderKind')
          OR r.owner_id IS NOT json_extract(h.decline_json, '$.holderId')
          OR EXISTS (SELECT 1 FROM kin_record_comments c
            WHERE c.org_id = h.org_id AND c.record_id = h.record_id
              AND c.author_kind = 'person' AND c.author_id = h.for_person_id
              AND c.created_at > h.set_at AND c.created_at <= ${at})
          OR EXISTS (SELECT 1 FROM kin_messages m JOIN kin_messages parent
              ON parent.org_id = m.org_id AND parent.chat_id = m.chat_id AND parent.message_id = m.reply_to
            WHERE m.org_id = h.org_id AND m.author_kind = 'human' AND m.author_person_id = h.for_person_id
              AND m.origin_json IS NULL AND NOT ${sql.literal(keySentSql("m.client_message_id"))}
              AND m.status = 'posted' AND m.message_id != d.message_id
              AND (CASE WHEN m.chat_id = d.chat_id THEN m.seq > d.seq
                ELSE ROUND(unixepoch(m.created_at, 'subsec') * 1000) > h.set_at END)
              AND ROUND(unixepoch(m.created_at, 'subsec') * 1000) <= ${at}
              AND (parent.message_id = json_extract(h.decline_json, '$.nudgeMessageId')
                OR EXISTS (SELECT 1 FROM kin_message_names n, json_each(n.names_json) named
                  WHERE n.org_id = parent.org_id AND n.message_id = parent.message_id
                    AND json_extract(named.value, '$.key') = r.key)
                OR EXISTS (SELECT 1 FROM nudges n JOIN kin_pulse_facts f
                  ON f.org_id = h.org_id AND f.fact_key = n.fact_key
                  WHERE n.message_id = parent.message_id AND f.subject_record_id = r.record_id)))) AS changed
        FROM kin_holds h
        JOIN kin_records r ON r.org_id = h.org_id AND r.record_id = h.record_id
        JOIN kin_people p ON p.org_id = h.org_id AND p.person_id = h.for_person_id
        JOIN kin_messages d ON d.org_id = h.org_id AND d.message_id = json_extract(h.decline_json, '$.messageId')
        WHERE h.org_id = ${orgId} AND h.decline_json IS NOT NULL AND h.lifted_at IS NULL AND ${where}
        ORDER BY h.set_at, h.hold_id`;
      if (rows.length === 0) return [];
      const zone = yield* ownerZone(orgId);
      const live: Array<Decline> = [];
      for (const { day, dueAt, changed, ...row } of rows) {
        if (changed || (dueAt === null ? null : dayIn(dueAt, zone)) !== day)
          yield* sql`UPDATE kin_holds SET lifted_at = ${at} WHERE org_id = ${orgId}
          AND hold_id = ${row.holdId} AND lifted_at IS NULL`;
        else live.push(row);
      }
      return live;
    }),
  );
});

const appliesTo = (sql: SqlClient.SqlClient, recordId: string, personId: KinPersonId) =>
  sql`h.record_id = ${recordId} AND h.for_person_id = ${personId}`;

export const nudgeDeclined = Effect.fn("KinDeclines.nudgeDeclined")(function* (
  orgId: KinOrgId,
  recordId: string,
  personId: KinPersonId,
  at: number,
) {
  const sql = yield* SqlClient.SqlClient;
  return (yield* liveRows(orgId, at, appliesTo(sql, recordId, personId))).length > 0;
});

type Target = {
  readonly recordKey?: string | undefined;
  readonly factKey?: string | undefined;
  readonly current: ReadonlyArray<{
    readonly key: string;
    readonly subject: {
      readonly recordId?: string | undefined;
    };
  }>;
  readonly people: ReadonlyArray<KinPersonId> | undefined;
};

const findRecord = Effect.fn("KinDeclines.record")(function* (orgId: KinOrgId, target: Target) {
  const sql = yield* SqlClient.SqlClient;
  const recordId = target.current.find((fact) => fact.key === target.factKey)?.subject.recordId;
  const [row] = yield* sql<{
    recordId: string;
    recordKey: string;
    title: string;
    dueAt: number | null;
    state: string;
    holderKind: string;
    holderId: string | null;
  }>`SELECT r.record_id AS "recordId", r.key AS "recordKey", r.title, r.due_at AS "dueAt",
      r.state, r.owner_kind AS "holderKind", r.owner_id AS "holderId"
    FROM kin_records r WHERE r.org_id = ${orgId}
      AND ${target.people === undefined ? sql`1 = 1` : viewSees(sql, target.people)} AND
      ${
        target.factKey === undefined
          ? sql`r.key = ${target.recordKey ?? ""}`
          : sql`(r.record_id = ${recordId ?? null} OR r.record_id = (SELECT f.subject_record_id
          FROM kin_pulse_facts f WHERE f.org_id = r.org_id AND f.fact_key = ${target.factKey}))`
      }
    ORDER BY r.record_id LIMIT 1`;
  return row;
});

const refused = () =>
  new KinChatError({
    reason: "not_allowed",
    message: "Only the person who answered the nudge can decline it.",
  });

type Change = WordTurn & Target & { readonly at: number };

export const recordDecline = Effect.fn("KinDeclines.recordDecline")(function* (input: Change) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = input;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const word = yield* wordMessages(input);
      if (word === null) return yield* refused();
      const record = yield* findRecord(orgId, input);
      if (record === undefined) return yield* refused();
      const facts = input.current
        .filter((fact) => fact.subject.recordId === record.recordId)
        .map(({ key }) => key);
      const [answer] = yield* sql<{
        messageId: string;
        nudgeMessageId: string;
        at: number;
        name: string;
      }>`
      WITH nudges AS (${postedNudges(sql, orgId)})
      SELECT a.message_id AS "messageId", n.message_id AS "nudgeMessageId",
        ROUND(unixepoch(a.created_at, 'subsec') * 1000) AS at, p.display_name AS name
      FROM kin_messages a JOIN kin_people p ON p.org_id = a.org_id AND p.person_id = a.author_person_id
      JOIN nudges n ON n.chat_id = a.chat_id AND n.person_id = p.person_id
        AND n.seq < a.seq AND (n.message_id = a.reply_to OR (a.reply_to IS NULL
          AND n.seq = (SELECT MAX(prior.seq) FROM nudges prior
            WHERE prior.chat_id = a.chat_id AND prior.person_id = n.person_id AND prior.seq < a.seq)
          AND NOT EXISTS (SELECT 1 FROM kin_messages earlier
            WHERE earlier.org_id = a.org_id AND earlier.chat_id = a.chat_id
              AND earlier.author_person_id = p.person_id AND earlier.status = 'posted'
              AND earlier.origin_json IS NULL AND NOT ${sql.literal(keySentSql("earlier.client_message_id"))}
              AND earlier.seq > n.seq AND earlier.seq < a.seq)))
      WHERE a.org_id = ${orgId} AND p.person_id = ${word.personId} AND p.removed_at IS NULL
        AND a.status = 'posted' AND a.message_id IN ${sql.in(word.messageIds)}
        AND ${input.factKey === undefined ? sql`1 = 1` : sql`n.fact_key = ${input.factKey}`}
        AND (n.fact_key IN ${sql.in(facts.length === 0 ? [""] : facts)}
          OR EXISTS (SELECT 1 FROM kin_pulse_facts f WHERE f.org_id = a.org_id
            AND f.fact_key = n.fact_key AND f.subject_record_id = ${record.recordId}))
      ORDER BY a.created_at DESC, a.seq DESC, a.message_id LIMIT 1`;
      if (answer === undefined) return yield* refused();
      const id = holdId([orgId, record.recordId, word.personId, "declined", answer.messageId]);
      const [live] = yield* liveRows(orgId, at, appliesTo(sql, record.recordId, word.personId));
      if (live !== undefined) return live;
      const zone = yield* ownerZone(orgId);
      const day = record.dueAt === null ? null : dayIn(record.dueAt, zone);
      const created = yield* sql`INSERT INTO kin_holds (hold_id, org_id, record_id, for_person_id,
        set_by_kind, set_by_id, on_word_of, set_at, decline_json)
      VALUES (${id}, ${orgId}, ${record.recordId}, ${word.personId}, 'agent',
        ${input.agentId}, ${word.personId}, ${answer.at}, json_object('day', ${day},
          'state', ${record.state}, 'holderKind', ${record.holderKind}, 'holderId', ${record.holderId},
          'messageId', ${answer.messageId}, 'nudgeMessageId', ${answer.nudgeMessageId}))
      ON CONFLICT DO NOTHING RETURNING hold_id`;
      if (created.length === 0) return null;
      const [standing] = yield* liveRows(orgId, at, appliesTo(sql, record.recordId, word.personId));
      return standing ?? null;
    }),
  );
});

export const liftDecline = Effect.fn("KinDeclines.lift")(function* (input: Change) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId, at } = input;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const word = yield* wordMessages(input);
      if (word === null) return null;
      const record = yield* findRecord(orgId, input);
      if (record === undefined) return null;
      const [decline] = yield* liveRows(orgId, at, appliesTo(sql, record.recordId, word.personId));
      if (decline === undefined) return null;
      yield* sql`UPDATE kin_holds SET lifted_at = ${at}, lifted_by_kind = 'agent', lifted_by_id = ${input.agentId}
      WHERE org_id = ${orgId} AND hold_id = ${decline.holdId} AND lifted_at IS NULL`;
      return decline;
    }),
  );
});

export const openDeclines = Effect.fn("KinDeclines.open")(function* (input: {
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  readonly at: number;
  readonly replacing: ReadonlyArray<string>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const live = yield* liveRows(
    input.orgId,
    input.at,
    sql`
    EXISTS (SELECT 1 FROM kin_people reader WHERE reader.org_id = h.org_id
      AND reader.person_id = ${input.personId} AND ${sql.literal(accessSql("reader"))} IN ('owner', 'co_owner'))`,
  );
  if (live.length === 0) return live;
  const keys = yield* encodeKeys(live.map(({ holdId }) => PREFIX + holdId));
  const reserved = yield* sql<{ key: string }>`SELECT t.fact_key AS key
    FROM kin_pulse_told t JOIN kin_events e ON e.org_id = t.org_id AND e.event_id = t.event_id
    WHERE t.org_id = ${input.orgId} AND t.person_id = ${input.personId}
      AND t.fact_key IN (SELECT value FROM json_each(${keys}))
      AND e.state IN ('queued', 'claimed', 'done')
      ${input.replacing.length === 0 ? sql`` : sql`AND e.event_id NOT IN ${sql.in(input.replacing)}`}
    ORDER BY t.fact_key`;
  const keysTaken = new Set(reserved.map(({ key }) => key));
  return live.filter(({ holdId }) => !keysTaken.has(PREFIX + holdId));
});

export const reserveDeclines = Effect.fn("KinDeclines.reserve")(function* (
  input: Parameters<typeof openDeclines>[0] & { readonly eventId: string },
) {
  const sql = yield* SqlClient.SqlClient;
  for (const { holdId } of yield* openDeclines(input))
    yield* sql`INSERT INTO kin_pulse_told (org_id, person_id, fact_key, event_id, sig, told_at)
      VALUES (${input.orgId}, ${input.personId}, ${PREFIX + holdId}, ${input.eventId}, 'declined', ${input.at})
      ON CONFLICT DO NOTHING RETURNING fact_key`;
});

export const givenDeclines = Effect.fn("KinDeclines.given")(function* (
  orgId: KinOrgId,
  at: number,
  keys: ReadonlySet<string>,
) {
  const ids = [...keys].filter(isDeclineKey).map((key) => key.slice(PREFIX.length));
  if (ids.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const encoded = yield* encodeKeys(ids);
  return yield* liveRows(orgId, at, sql`h.hold_id IN (SELECT value FROM json_each(${encoded}))`);
});
