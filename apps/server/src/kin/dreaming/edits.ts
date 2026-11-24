import type { KinOrgId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { confirmedOf, PreparedJson } from "../connections/Sending.ts";
import { ownerLevelSql } from "../people/KinAccess.ts";
import { cutAt } from "../work/draftOpening.ts";
import { sensitiveNow } from "../work/recordRows.ts";

/** The most edits one night reads, newest first; the material says how many it left out. */
export const EDITS_PER_NIGHT = 20;
/** Each side of an edit is given whole up to this; a longer one is cut and says so. */
export const EDIT_SIDE_MAX = 6_000;

export type DraftEdit = {
  readonly ref: string;
  readonly saidBy: string;
  readonly at: number;
  readonly about: string;
  readonly before: string;
  readonly after: string;
  readonly sensitive: boolean;
};

const decodePrepared = Schema.decodeUnknownOption(PreparedJson);
const mailText = (mail: { readonly subject: string; readonly body: string }) =>
  `Subject: ${mail.subject}\n\n${mail.body}`;

/** One side as the material holds it: whole, or cut where no character splits, with its length. */
export const editSide = (text: string) =>
  text.length <= EDIT_SIDE_MAX
    ? { text }
    : { text: text.slice(0, cutAt(text, EDIT_SIDE_MAX)), length: text.length };

/**
 * What an owner-level person changed in an agent's draft, with its last change in `(from, until]`:
 * a doc version by them right after an agent's (their later versions with nobody's between count
 * as one), and a mail whose words they changed on its send card before Confirm. Left out: a
 * teammate's change, and anything from a turn that read someone's own mailbox or sent from one.
 */
export const draftEdits = Effect.fn("DreamMaterial.draftEdits")(function* (
  orgId: KinOrgId,
  from: number,
  until: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const versions = yield* sql<{
    recordId: string;
    key: string;
    title: string;
    version: number;
    actorKind: string;
    actorId: string | null;
    bodyKind: string;
    createdAt: number;
    handle: string | null;
    level: number;
    private: number;
  }>`SELECT v.record_id AS "recordId", r.key, r.title, v.version, v.actor_kind AS "actorKind",
      v.actor_id AS "actorId", v.body_kind AS "bodyKind", v.created_at AS "createdAt", p.handle,
      ${sql.literal(ownerLevelSql("v.org_id", "v.actor_id"))} AS level,
      ${sensitiveNow(sql)} AS private
    FROM kin_doc_versions v
    JOIN kin_records r ON r.org_id = v.org_id AND r.record_id = v.record_id
      AND r.register_id = 'docs'
    LEFT JOIN kin_people p ON p.org_id = v.org_id AND p.person_id = v.actor_id
      AND v.actor_kind = 'person'
    WHERE v.org_id = ${orgId} AND v.created_at <= ${until}
      AND EXISTS (SELECT 1 FROM kin_doc_versions pv WHERE pv.org_id = v.org_id
        AND pv.record_id = v.record_id AND pv.actor_kind = 'person'
        AND pv.created_at > ${from} AND pv.created_at <= ${until})
      AND NOT EXISTS (SELECT 1 FROM kin_doc_versions av JOIN kin_private_turns pt
        ON pt.org_id = av.org_id AND pt.wakeup_id = av.wakeup_id
        WHERE av.org_id = v.org_id AND av.record_id = v.record_id AND av.actor_kind = 'agent')
    ORDER BY v.record_id, v.version`;
  const pairs: Array<{ draft: (typeof versions)[number]; last: (typeof versions)[number] }> = [];
  let draft: (typeof versions)[number] | undefined;
  let last: (typeof versions)[number] | undefined;
  const close = () => {
    if (draft !== undefined && last !== undefined && last.createdAt > from)
      pairs.push({ draft, last });
    draft = last = undefined;
  };
  for (const [index, row] of versions.entries()) {
    if (index > 0 && versions[index - 1]!.recordId !== row.recordId) close();
    const person = row.actorKind === "person" && row.bodyKind === "markdown";
    if (person && last !== undefined && last.actorId === row.actorId) last = row;
    else if (person && last === undefined && draft !== undefined && row.level === 1) last = row;
    else {
      close();
      if (row.actorKind === "agent" && row.bodyKind === "markdown") draft = row;
    }
  }
  close();
  const bodies = new Map<string, string>();
  if (pairs.length > 0)
    for (const row of yield* sql<{ recordId: string; version: number; body: string }>`SELECT
        record_id AS "recordId", version, body FROM kin_doc_versions
      WHERE org_id = ${orgId} AND ${sql.or(
        pairs.map(
          (pair) =>
            sql`(record_id = ${pair.draft.recordId} AND version IN (${pair.draft.version}, ${pair.last.version}))`,
        ),
      )}
      ORDER BY record_id, version`)
      bodies.set(`${row.recordId}:${row.version}`, row.body);
  const edits: Array<DraftEdit> = [];
  for (const { draft, last } of pairs) {
    const before = bodies.get(`${draft.recordId}:${draft.version}`) ?? "";
    const after = bodies.get(`${last.recordId}:${last.version}`) ?? "";
    if (before === after) continue;
    edits.push({
      ref: `kin:doc:${draft.recordId}:version:${draft.version}..${last.version}`,
      saidBy: last.handle ?? "external",
      at: last.createdAt,
      about: `${draft.key} ${draft.title}`,
      before,
      after,
      sensitive: draft.private === 1,
    });
  }
  // A send card keeps the agent's draft and, beside it, the words a person's Confirm took.
  const mails = yield* sql<{
    askId: string;
    payload: string;
    decidedAt: number;
    handle: string;
    private: number;
  }>`SELECT k.ask_id AS "askId", k.payload_json AS payload, k.decided_at AS "decidedAt",
      p.handle, COALESCE((SELECT ${sensitiveNow(sql)} FROM kin_records r
        WHERE r.org_id = k.org_id AND r.record_id = k.entry_record_id), 0) AS private
    FROM kin_connection_asks k
    JOIN kin_connections c ON c.org_id = k.org_id AND c.connection_id = k.connection_id
    JOIN kin_people p ON p.org_id = k.org_id AND p.person_id = k.decided_by
    WHERE k.org_id = ${orgId} AND k.decided_at > ${from} AND k.decided_at <= ${until}
      AND json_extract(k.payload_json, '$.confirmed') IS NOT NULL AND c.person_id IS NULL
      AND ${sql.literal(ownerLevelSql("p.org_id", "p.person_id"))}
      AND NOT EXISTS (SELECT 1 FROM kin_private_turns pt
        WHERE pt.org_id = k.org_id AND pt.wakeup_id = k.wakeup_id)
    ORDER BY k.decided_at, k.ask_id`;
  for (const mail of mails) {
    const drafted = Option.getOrUndefined(decodePrepared(mail.payload));
    if (drafted?._tag !== "email") continue;
    const sent = confirmedOf(drafted, mail.payload);
    if (sent._tag !== "email") continue;
    const before = mailText(drafted);
    const after = mailText(sent);
    if (before === after) continue;
    edits.push({
      ref: `kin:send:${mail.askId}`,
      saidBy: mail.handle,
      at: mail.decidedAt,
      about: `Mail to ${sent.to.join(", ")}`,
      before,
      after,
      sensitive: mail.private === 1,
    });
  }
  const newest = edits.toSorted((a, b) => b.at - a.at || (a.ref < b.ref ? -1 : 1));
  return {
    edits: newest.slice(0, EDITS_PER_NIGHT).map((edit) => ({
      ...edit,
      at: DateTime.formatIso(DateTime.makeUnsafe(edit.at)),
    })),
    leftOut: Math.max(0, newest.length - EDITS_PER_NIGHT),
  };
});
