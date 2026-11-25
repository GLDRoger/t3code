import {
  formatKinWhen,
  KIN_TEXT_LOCALE,
  KIN_TURN_CHANGES_SHOWN,
  type KinAgentChange,
  KinAgentId as AgentId,
  type KinOrgId,
  type KinTurnChange,
  type KinTurnChanges,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { kindOf } from "../chat/messageLinks.ts";
import { type TextClock, textLocale } from "../work/companyProfile.ts";
import { isClosed, ownerZone, parseChanges } from "../work/recordRows.ts";
import { type KinViewer, seenBy } from "../work/teamView.ts";
import { ALONG, changeOf, changeSql, isState, millisOf, otherEnd, type Row } from "./changeRows.ts";

type TurnRow = Omit<Row, "seq"> & {
  readonly seq: number | null;
  readonly messageId: string;
  readonly total: number;
  readonly agentId: string | null;
  readonly namesJson: string | null;
  readonly filedUnder: string | null;
  readonly partyKey: string | null;
};

const decodeNames = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
);

const STATE_WORDS: Record<string, string> = {
  done: "done",
  dropped: "dropped",
  doing: "started",
  waiting: "waiting",
};
const FIELD_WORDS: Record<string, string> = {
  notes: "notes changed",
  title: "renamed",
  amount: "amount changed",
  party: "client changed",
  category: "kind changed",
  repo: "repo changed",
  repeat: "repeat changed",
};

/** Kin's own short phrase for what one change did: "given to Finance", "due moved to 24 Nov". */
const whatOf = (
  change: KinAgentChange,
  names: Readonly<Record<string, string | null>>,
  filedUnder: string | null,
  clock: TextClock,
) => {
  if (change.kind === "created") return "created";
  if (change.kind === "linked")
    return change.linkedTo == null ? "linked" : `linked to ${change.linkedTo.key}`;
  const nameOf = (shown: string | null) => (shown === null ? null : (names[shown] ?? null));
  const dayOf = (shown: string | null) => {
    const at = millisOf(shown);
    return at === null || at === undefined ? null : formatKinWhen(at, "date", clock);
  };
  const handedBack = change.fields.some((one) => one.field === "handedBack");
  const due = change.fields.some((one) => one.field === "due");
  const phrases = change.fields.flatMap(({ field, from, to }): ReadonlyArray<string> => {
    switch (field) {
      case "state":
        return [
          to === "open"
            ? from !== null && isState(from) && isClosed(from)
              ? "reopened"
              : "opened"
            : (STATE_WORDS[to ?? ""] ?? "changed"),
        ];
      case "owner": {
        const name = nameOf(to) ?? "someone else";
        return [handedBack ? `handed back to ${name}` : `given to ${name}`];
      }
      case "waitingOn":
        return [to === null ? "no longer waiting" : `waiting on ${nameOf(to) ?? "someone"}`];
      case "project":
        return [
          to === null ? "taken out of its project" : `filed under ${filedUnder ?? "another entry"}`,
        ];
      case "due": {
        const shown = dayOf(to);
        return [shown === null ? "due date taken off" : `due moved to ${shown}`];
      }
      case "dueAllDay":
        return due ? [] : ["due time changed"];
      case "date": {
        const shown = dayOf(to);
        return [shown === null ? "date taken off" : `moved to ${shown}`];
      }
      case "side":
        return [to === "theirs" ? "theirs to do" : "ours to do"];
      case "sensitive":
        return [to === "true" ? "marked sensitive" : "no longer sensitive"];
      case "team":
        return [to === "true" ? "shared with the team" : "no longer shared with the team"];
      case "confirmed":
        return [to === "true" ? "kept" : "no longer kept"];
      case "payment":
        return [to === null ? "payment taken off" : "payment recorded"];
      default:
        return ALONG.has(field) ? [] : [FIELD_WORDS[field] ?? "changed"];
    }
  });
  const unique = [...new Set(phrases)];
  return unique.length === 0 ? "changed" : unique.join(", ");
};

/**
 * What each agent reply's wake-up changed, as this viewer sees it, oldest first: one read for the
 * whole page. Absent for any message that is not a reply from a wake-up.
 */
export const turnChanges = Effect.fn("KinAgentChanges.turn")(function* (
  viewer: KinViewer,
  orgId: KinOrgId,
  messageIds: ReadonlyArray<string>,
) {
  const receipts = new Map<string, KinTurnChanges>();
  if (messageIds.length === 0) return receipts;
  const sql = yield* SqlClient.SqlClient;
  const change = changeSql(sql, viewer);
  const toOf = (field: string) => sql`(SELECT json_extract(f.value, '$.to')
    FROM json_each(c.fields_json) f WHERE json_extract(f.value, '$.field') = ${field} LIMIT 1)`;
  const rows = yield* sql<TurnRow>`WITH m AS (
        SELECT message_id, source_wakeup_id AS wakeup_id, author_agent_id AS agent_id
        FROM kin_messages WHERE org_id = ${orgId} AND message_id IN ${sql.in(messageIds)}
          AND author_kind = 'agent' AND source_wakeup_id IS NOT NULL AND body <> ''),
      picked AS (SELECT m.message_id, c.seq,
          COUNT(c.seq) OVER (PARTITION BY m.message_id) AS total,
          ROW_NUMBER() OVER (PARTITION BY m.message_id ORDER BY c.seq) AS n
        FROM m LEFT JOIN kin_record_changes c ON c.org_id = ${orgId}
          AND c.wakeup_id = m.wakeup_id AND c.actor_kind = 'agent' AND c.actor_id = m.agent_id
          AND EXISTS (SELECT 1 FROM kin_records r WHERE r.org_id = c.org_id
            AND r.record_id = c.record_id AND ${seenBy(sql, viewer)})
          AND ${change.listed})
      SELECT p.message_id AS "messageId", p.total, c.actor_id AS "agentId", ${change.columns},
        (SELECT json_group_object(json_extract(f.value, '$.to'),
            COALESCE(pp.display_name, aa.display_name))
          FROM json_each(c.fields_json) f
          LEFT JOIN kin_people pp ON pp.org_id = c.org_id
            AND json_extract(f.value, '$.to') LIKE 'person:%'
            AND pp.person_id = substr(json_extract(f.value, '$.to'), 8)
          LEFT JOIN kin_agents aa ON aa.org_id = c.org_id
            AND json_extract(f.value, '$.to') LIKE 'agent:%'
            AND aa.agent_id = substr(json_extract(f.value, '$.to'), 7)
          WHERE json_extract(f.value, '$.field') IN ('owner', 'waitingOn')
            AND json_extract(f.value, '$.to') IS NOT NULL) AS "namesJson",
        (SELECT r.key FROM kin_records r WHERE r.org_id = c.org_id AND r.key = ${toOf("project")}
          AND ${seenBy(sql, viewer)}) AS "filedUnder",
        (SELECT r.key FROM kin_records r WHERE r.org_id = c.org_id AND r.register_id = 'clients'
          AND r.record_id = (SELECT x.party_id FROM kin_records x WHERE x.org_id = c.org_id
            AND x.record_id = c.record_id AND x.register_id = 'contacts')
          AND ${seenBy(sql, viewer)}) AS "partyKey"
      FROM picked p
      LEFT JOIN kin_record_changes c ON c.org_id = ${orgId} AND c.seq = p.seq
      LEFT JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
      ${otherEnd(sql)}
      WHERE p.n <= ${KIN_TURN_CHANGES_SHOWN}
      ORDER BY p.message_id, p.seq`;
  const dated = rows.some(
    (row) =>
      row.seq !== null &&
      parseChanges(row.fieldsJson).some((one) => one.field === "due" || one.field === "date"),
  );
  const clock: TextClock = dated
    ? { zone: yield* ownerZone(orgId), locale: yield* textLocale(orgId) }
    : { zone: "UTC", locale: KIN_TEXT_LOCALE };
  const undoable = viewer._tag === "ownerLevel";
  for (const row of rows) {
    const receipt = receipts.get(row.messageId) ?? { count: row.total, items: [], more: 0 };
    if (row.seq !== null && row.agentId !== null) {
      const made = changeOf({ ...row, seq: row.seq });
      const item: KinTurnChange = {
        key: made.key,
        kind: kindOf(made.registerId),
        ...(row.partyKey === null ? {} : { party: row.partyKey }),
        title: made.title,
        what: whatOf(
          made,
          Option.getOrElse(decodeNames(row.namesJson ?? "{}"), () => ({})),
          row.filedUnder,
          clock,
        ),
        change: { agentId: AgentId.make(row.agentId), seq: made.seq },
        undoable: undoable && made.undo,
        undone: made.undone === true,
      };
      receipts.set(row.messageId, {
        ...receipt,
        items: [...receipt.items, item],
        more: receipt.count - receipt.items.length - 1,
      });
    } else receipts.set(row.messageId, receipt);
  }
  return receipts;
});
