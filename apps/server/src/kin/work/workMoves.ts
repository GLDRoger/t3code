// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import {
  KIN_WORK_MOVE_GROUPS,
  KinAgentId,
  KinChatError,
  KinMessageId,
  type KinOrgId,
  KinPersonId,
  type KinWorkMoveCounts,
  type KinWorkMoveGroup,
  type KinWorkNudgeInput,
  type KinWorkPrincipal,
  type KinWorkRowMove,
  kinWorkMove,
  kinWorkMoveOrder,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { PersonIdentity } from "../chat/KinIdentity.ts";
import { teamAgent } from "../lead/LeadAccess.ts";
import { tellPeople } from "./assignNotices.ts";
import { KinRecords, type MoveRow, type QueryInput } from "./KinRecords.ts";
import { dayIn } from "./money.ts";
import { waitingCards } from "./recordComments.ts";
import { iso, isClosed, notFound, ownerZone, type RecordRow, workFailure } from "./recordRows.ts";
import { teamVisible } from "./teamView.ts";
import { DAY_MS } from "../durations.ts";

const RECENT_DONE_MS = 14 * DAY_MS;

const principalOf = (kind: "person" | "agent", id: string): KinWorkPrincipal =>
  kind === "person"
    ? { _tag: "person", personId: KinPersonId.make(id) }
    : { _tag: "agent", agentId: KinAgentId.make(id) };

/** Who gave it to its holder, when that is someone else: `toRecord`'s `givenBy`. */
const givenOf = (row: MoveRow): KinWorkPrincipal | null => {
  const by =
    row.assignedBy !== null
      ? principalOf("person", row.assignedBy)
      : row.assignedByAgent !== null
        ? principalOf("agent", row.assignedByAgent)
        : null;
  if (by === null) return null;
  const id = by._tag === "person" ? by.personId : by.agentId;
  return by._tag === row.ownerKind && id === row.ownerId ? null : by;
};

/** One nudge a day per task from each person: the message's id is the day's. */
const nudgeMessageId = (orgId: string, recordId: string, by: string, day: string) =>
  KinMessageId.make(
    `kin-nudge-${NodeCrypto.createHash("sha256")
      .update(`${orgId}:${recordId}:${by}:${day}`)
      .digest("hex")
      .slice(0, 32)}`,
  );

/** Today's nudges by this person, sent or held for the holder's hours, by message id. */
const nudgesSent = Effect.fn("KinWork.nudgesSent")(function* (
  orgId: KinOrgId,
  ids: ReadonlyArray<string>,
) {
  const sent = new Map<string, number>();
  if (ids.length === 0) return sent;
  const sql = yield* SqlClient.SqlClient;
  const posted = yield* sql<{ id: string; at: string }>`SELECT message_id AS id, created_at AS at
    FROM kin_messages WHERE org_id = ${orgId} AND message_id IN ${sql.in(ids)}
    ORDER BY message_id`;
  for (const one of posted) sent.set(one.id, Date.parse(one.at));
  const held = yield* sql<{ id: string; at: number }>`SELECT kind AS id, held_at AS at
    FROM kin_held_posts WHERE org_id = ${orgId} AND kind IN ${sql.in(ids)} ORDER BY rowid`;
  for (const one of held) if (!sent.has(one.id)) sent.set(one.id, one.at);
  return sent;
});

/**
 * A `byMove` page: every open match placed by `kinWorkMove` for this reader and ordered by
 * `kinWorkMoveOrder`, the page's rows, each row's step, and exact counts of every match.
 */
export const movePage = Effect.fn("KinWork.movePage")(function* (input: {
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  readonly ownerLevel: boolean;
  readonly filter: QueryInput;
  readonly offset: number;
  readonly limit: number;
  readonly at: number;
}) {
  const { orgId, personId, at } = input;
  const records = yield* KinRecords;
  const { states: _states, late: _late, open: _open, ...rest } = input.filter;
  const filter: QueryInput = { ...rest, open: true, at };
  const light = yield* records.moveRows(orgId, filter);
  const cards = yield* waitingCards(orgId, personId, light).pipe(workFailure);
  const placed = light.flatMap((row) => {
    const late = row.dueAt !== null && row.dueAt < at;
    const group = kinWorkMove(
      {
        state: row.state,
        owner: principalOf(row.ownerKind, row.ownerId),
        waitingOn:
          row.waitingOnKind === null || row.waitingOnId === null
            ? null
            : principalOf(row.waitingOnKind, row.waitingOnId),
        late,
        confirmed: row.confirmed === 1,
        askedBy: row.askedBy === null ? null : KinPersonId.make(row.askedBy),
        givenBy: givenOf(row),
        card: cards.has(row.recordId),
      },
      { personId, ownerLevel: input.ownerLevel },
    );
    return group === null
      ? []
      : [{ row, group, late, dueMs: row.dueAt, createdMs: row.createdAt, key: row.key }];
  });
  const rank = (group: KinWorkMoveGroup) => KIN_WORK_MOVE_GROUPS.indexOf(group);
  placed.sort((a, b) => rank(a.group) - rank(b.group) || kinWorkMoveOrder(a, b));
  const page = placed.slice(input.offset, input.offset + input.limit);
  const done = yield* records.query(orgId, {
    ...rest,
    states: ["done"],
    closedAfter: at - RECENT_DONE_MS,
    at,
    limit: 1,
  });
  const counts: KinWorkMoveCounts = {
    needsYou: placed.filter((one) => one.group === "needsYou").length,
    waiting: placed.filter((one) => one.group === "waiting").length,
    rest: placed.filter((one) => one.group === "rest").length,
    doneRecently: done.total,
  };
  const full =
    page.length === 0
      ? { rows: [] as ReadonlyArray<RecordRow>, seq: done.seq }
      : yield* records.query(orgId, {
          ...rest,
          keys: page.map((one) => one.key),
          at,
          limit: page.length,
        });
  const byKey = new Map(full.rows.map((row) => [row.key, row]));
  const shown = page.filter((one) => byKey.has(one.key));
  // A late task someone else holds for this reader: what its holder last said, and today's nudge.
  const chased = shown.filter(
    (one) => one.group === "needsYou" && one.late && one.row.ownerId !== personId,
  );
  const sql = yield* SqlClient.SqlClient;
  const said =
    chased.length === 0
      ? []
      : yield* sql<{ recordId: string; body: string }>`SELECT c.record_id AS "recordId", c.body
          FROM kin_record_comments c
          JOIN kin_records r ON r.org_id = c.org_id AND r.record_id = c.record_id
          WHERE c.org_id = ${orgId} AND c.removed_at IS NULL
            AND c.author_kind = r.owner_kind AND c.author_id = r.owner_id
            AND c.record_id IN ${sql.in(chased.map((one) => one.row.recordId))}
          ORDER BY c.created_at DESC, c.seq DESC`.pipe(workFailure);
  const saidBy = new Map<string, string>();
  for (const one of said) if (!saidBy.has(one.recordId)) saidBy.set(one.recordId, one.body);
  const day = chased.length === 0 ? "" : dayIn(at, yield* ownerZone(orgId).pipe(workFailure));
  const nudged = yield* nudgesSent(
    orgId,
    chased.map((one) => nudgeMessageId(orgId, one.row.recordId, personId, day)),
  ).pipe(workFailure);
  const moves = shown.map((one): KinWorkRowMove => {
    const card = cards.get(one.row.recordId);
    const words = saidBy.get(one.row.recordId)?.trim();
    const sent = chased.includes(one)
      ? nudged.get(nudgeMessageId(orgId, one.row.recordId, personId, day))
      : undefined;
    return {
      key: one.row.key as KinWorkRowMove["key"],
      group: one.group,
      ...(card === undefined ? {} : { card }),
      ...(words === undefined || words === "" ? {} : { said: words as KinWorkRowMove["said"] }),
      ...(sent === undefined ? {} : { nudgedAt: iso(sent) }),
    };
  });
  return {
    rows: shown.map((one) => byKey.get(one.key)!),
    moves,
    counts,
    total: placed.length,
    seq: full.seq,
  };
});

const refuse = (message: string) => new KinChatError({ reason: "not_allowed", message });

/**
 * The reader asks a person holding a task where it stands: one server-written line in the
 * holder's chat with the team agent, at most once a day per task from each person. A second tap
 * that day sends nothing and answers when the first went.
 */
export const nudge = Effect.fn("KinWork.nudge")(function* (
  viewer: { readonly person: PersonIdentity; readonly teammate: boolean },
  input: KinWorkNudgeInput,
) {
  const { orgId } = input;
  const me = viewer.person.personId;
  const records = yield* KinRecords;
  const row = yield* records.get(orgId, input.key);
  if (row === undefined || row.registerId !== "work") return yield* notFound(input.key);
  if (
    viewer.teammate &&
    !(yield* teamVisible(orgId, me, [row.recordId]).pipe(workFailure)).has(row.recordId)
  )
    return yield* notFound(input.key);
  if (isClosed(row.state)) return yield* refuse("That task is already closed.");
  if (row.ownerKind !== "person" || row.ownerId === me)
    return yield* refuse("Only a person holding a task can be asked where it stands.");
  const sql = yield* SqlClient.SqlClient;
  const [asked] = yield* sql<{ askedBy: string | null }>`SELECT COALESCE(r.asked_by_person_id,
      CASE WHEN r.created_by_kind = 'person' THEN r.created_by_id END,
      r.assigned_by_person_id) AS "askedBy"
    FROM kin_records r WHERE r.org_id = ${orgId} AND r.record_id = ${row.recordId}`.pipe(
    workFailure,
  );
  if (viewer.teammate && asked?.askedBy !== me)
    return yield* refuse("Only whoever asked for it, or an owner, can ask where it stands.");
  const now = yield* Clock.currentTimeMillis;
  const day = dayIn(now, yield* ownerZone(orgId).pipe(workFailure));
  const messageId = nudgeMessageId(orgId, row.recordId, me, day);
  const before = (yield* nudgesSent(orgId, [messageId]).pipe(workFailure)).get(messageId);
  if (before !== undefined) return { key: row.key, nudgedAt: iso(before), already: true };
  const agentId = yield* teamAgent(orgId).pipe(workFailure);
  const [named] = yield* sql<{ name: string }>`SELECT display_name AS name FROM kin_people
    WHERE org_id = ${orgId} AND person_id = ${me}`.pipe(workFailure);
  const holder = KinPersonId.make(row.ownerId);
  const told =
    agentId === null
      ? new Set<string>()
      : yield* tellPeople(
          {
            orgId,
            agentId,
            wakeupId: `nudge:${messageId}`,
            by: named?.name ?? "Someone",
            byPersonId: me,
            messageId,
          },
          [{ personId: holder, kind: "nudged", row, why: null }],
        ).pipe(workFailure);
  if (!told.has(holder)) return yield* refuse("Kin couldn't reach them in a chat just now.");
  const sent = (yield* nudgesSent(orgId, [messageId]).pipe(workFailure)).get(messageId) ?? now;
  return { key: row.key, nudgedAt: iso(sent), already: false };
});
