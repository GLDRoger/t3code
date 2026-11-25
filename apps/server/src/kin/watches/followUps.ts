import {
  KinChatError,
  KinDeferralCard,
  type KinFollowUp,
  type KinMemoryItemId,
  type KinOrgId,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { personReads } from "../chat/sharing.ts";
import { listNumberSeenBy, seenBy } from "../work/teamView.ts";
import { MemorySyncHooks, type MemorySyncSnapshot } from "../memory/Memory.ts";
import { readableSources } from "../memory/quoteAccess.ts";
import * as KinShell from "../shell/KinShell.ts";
import { looksLikeRecordReference, resolveSections } from "../shell/sections.ts";
import { askerOf } from "../triggers/deferralOrigin.ts";
import { deferralOpen, promiserLead } from "../triggers/deferrals.ts";
import { memoryDateMillis } from "../memory/frontMatter.ts";
import { KIN_OWNER_LEVEL } from "../work/teamView.ts";
import type { WatchReader } from "./readRpcs.ts";

export class KinFollowUpItems extends Context.Service<
  KinFollowUpItems,
  {
    readonly get: (orgId: KinOrgId) => MemorySyncSnapshot | undefined;
    readonly remember: (orgId: KinOrgId, snapshot: MemorySyncSnapshot) => void;
  }
>()("t3/kin/watches/followUps/KinFollowUpItems") {}

export const itemsLayer = Layer.sync(KinFollowUpItems, () => {
  const snapshots = new Map<KinOrgId, MemorySyncSnapshot>();
  return {
    get: (orgId) => snapshots.get(orgId),
    remember: (orgId, snapshot) => void snapshots.set(orgId, snapshot),
  };
});

// Memory load can synchronize runs on the writer. The RPC uses the same committed snapshot without doing I/O.
export const rememberSnapshots = Layer.effect(
  MemorySyncHooks,
  Effect.gen(function* () {
    const hooks = yield* MemorySyncHooks;
    const items = yield* Effect.serviceOption(KinFollowUpItems);
    return {
      syncItems: Effect.fn("KinFollowUps.syncItems")(function* (orgId, snapshot) {
        yield* hooks.syncItems(orgId, snapshot);
        if (Option.isSome(items) && items.value.get(orgId)?.head !== snapshot.head)
          items.value.remember(orgId, snapshot);
      }),
    };
  }),
);

const activeStates = ["armed", "heads_up", "asked", "grace", "snoozed"];
const decodeCard = Schema.decodeUnknownOption(Schema.fromJsonString(KinDeferralCard));
const iso = (at: number) => DateTime.formatIso(DateTime.makeUnsafe(at));
const unavailable = () =>
  new KinChatError({ reason: "unavailable", message: "Kin is unavailable." });

const recordReferences = (head: MemoryItemHead) => {
  // Deferrals.sectionOff returns a boolean; the list also needs the matching section.
  const mentioned =
    head.title.match(
      /(?<![\w/-])(?:[A-Z][A-Z0-9]{0,7}-[1-9]\d{0,8}|[A-Z0-9-]+(?:\/[A-Z0-9-]+)+)(?![\w/-])/gi,
    ) ?? [];
  return new Set([
    ...head.links
      .map((value) => value.trim())
      .filter((value) => looksLikeRecordReference(value, true)),
    ...mentioned.filter((value) => looksLikeRecordReference(value)),
  ]);
};

interface Run {
  readonly itemId: KinMemoryItemId;
  readonly state: string;
  readonly dueAt: number | null;
  readonly movedFrom: number | null;
  readonly onDue: KinFollowUp["onDue"];
  readonly card: string | null;
  readonly cardReadable: number;
}

const runs = Effect.fn("KinFollowUps.runs")(function* (
  orgId: KinOrgId,
  reader: WatchReader,
  itemId?: KinMemoryItemId,
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<Run>`SELECT d.item_id AS "itemId", d.state, d.due_at AS "dueAt",
      json_extract(d.snapshot_json, '$.movedFrom') AS "movedFrom", d.on_due AS "onDue",
      w.state_json AS card, EXISTS (
        SELECT 1 FROM kin_messages WHERE kin_messages.org_id = w.org_id
          AND kin_messages.message_id = w.message_id AND kin_messages.status = 'posted'
          AND ${personReads(sql, reader.personId)}
      ) AS "cardReadable"
    FROM kin_deferral_runs d
    LEFT JOIN kin_widgets w ON w.org_id = d.org_id AND w.type = 'deferral'
      AND w.widget_id = 'deferral:' || d.org_id || ':' || d.item_id
    WHERE d.org_id = ${orgId}
      ${itemId === undefined ? sql`AND d.state IN ${sql.in(activeStates)}` : sql`AND d.item_id = ${itemId}`}
    ORDER BY d.due_at, d.item_id`;
});

const titleMayName = Effect.fn("KinFollowUps.titleMayName")(function* (
  orgId: KinOrgId,
  reader: WatchReader,
  refs: ReadonlySet<string>,
) {
  if (refs.size === 0) return true;
  const sql = yield* SqlClient.SqlClient;
  const [hidden] = yield* sql`SELECT 1 FROM kin_records r WHERE r.org_id = ${orgId}
    AND (r.key IN ${sql.in([...refs].map((ref) => ref.toUpperCase()))}
      OR json_extract(r.fields_json, '$.number') IN ${sql.in([...refs])})
    AND (NOT (${seenBy(sql, reader.viewer)})
      OR (json_extract(r.fields_json, '$.number') IN ${sql.in([...refs])}
        AND NOT (${listNumberSeenBy(sql, reader.viewer)})))
    ORDER BY r.key LIMIT 1`;
  return hidden === undefined;
});

const cardOf = (run: Run) =>
  run.card === null ? undefined : Option.getOrUndefined(decodeCard(run.card));

const asker = (sql: SqlClient.SqlClient, orgId: KinOrgId, head: MemoryItemHead, run: Run) =>
  askerOf(sql, orgId, cardOf(run)?.askedBy?.personId ?? head.said_by);

const matchesDue = (head: MemoryItemHead, run: Run) => {
  const due = memoryDateMillis(head.due);
  return run.dueAt !== null && (run.dueAt === due || run.movedFrom === due);
};

export const list = Effect.fn("KinFollowUps.list")(function* (
  orgId: KinOrgId,
  reader: WatchReader,
) {
  const sql = yield* SqlClient.SqlClient;
  const items = yield* KinFollowUpItems;
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* runs(orgId, reader);
  const followUps: Array<KinFollowUp> = [];
  if (rows.length === 0) return { followUps };
  const snapshot = items.get(orgId);
  if (snapshot === undefined) return yield* unavailable();
  const heads = new Map(snapshot.items.map(({ head }) => [head.id, head]));
  const shell = rows.some((row) => row.dueAt !== null && row.dueAt <= now)
    ? yield* KinShell.get(orgId)
    : undefined;
  const owner = reader.viewer._tag === "ownerLevel";
  for (const run of rows) {
    const head = heads.get(run.itemId);
    if (
      head === undefined ||
      head.orgId !== orgId ||
      snapshot.duplicateIds.has(head.id) ||
      head.every !== undefined ||
      !deferralOpen(head) ||
      run.dueAt === null ||
      !matchesDue(head, run)
    )
      continue;
    const askedBy = yield* asker(sql, orgId, head, run);
    if (!owner && askedBy?.personId !== reader.personId) continue;
    const refs = recordReferences(head);
    const card = cardOf(run);
    const canShowTitle =
      owner ||
      ((run.card === null
        ? (yield* readableSources(orgId, reader.personId, [head.source])).has(head.source)
        : run.cardReadable === 1 && card?.title === head.title) &&
        (yield* titleMayName(orgId, reader, refs)));
    let held: KinFollowUp["held"];
    if (canShowTitle && run.dueAt <= now && shell !== undefined && !KinShell.builtInsOn(shell)) {
      const sectionOf = yield* resolveSections(orgId, refs, KIN_OWNER_LEVEL);
      for (const reference of refs) {
        const section = sectionOf(reference);
        if (section !== null && !KinShell.sectionOn(shell, section)) {
          held = { section, sectionName: KinShell.sectionName(shell, section) };
          break;
        }
      }
    }
    const lead = yield* promiserLead(sql, orgId, head);
    followUps.push({
      itemId: run.itemId,
      title: canShowTitle ? head.title : "",
      dueAt: iso(run.dueAt),
      onDue: run.onDue,
      agent: lead === undefined ? null : { agentId: lead.agentId, name: lead.name },
      ...(askedBy === undefined ? {} : { askedBy }),
      ...(held === undefined ? {} : { held }),
    });
  }
  return { followUps };
});
