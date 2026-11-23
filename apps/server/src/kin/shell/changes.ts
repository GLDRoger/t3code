import {
  KinChatError,
  KinPersonId,
  type KinOrgId,
  KinShellSection,
  type KinShell as Shell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { ownerLevel } from "../people/KinAccess.ts";
import { get, set } from "./KinShell.ts";
import { BUILT_IN_SECTIONS, kinTitle } from "./words.ts";

/**
 * An agent's change to the company's sections, waiting on the owner's card (`company_sections` in
 * `mcp.ts`). Its rows live in `kin_profile_changes` under `sc_` ids; the profile's answers skip them.
 */
export const SHELL_CHANGE = "sc_";
export interface AskedSection {
  readonly id: string;
  readonly on?: boolean | undefined;
  readonly name?: string | null | undefined;
  readonly noun?: string | null | undefined;
}
// The shell the card was drawn against and the one Confirm saves: the card's words come from both.
const ChangeJson = Schema.fromJsonString(
  Schema.Struct({
    before: Schema.Array(KinShellSection),
    after: Schema.Array(KinShellSection),
  }),
);
const encodeChange = Schema.encodeEffect(ChangeJson);
const decodeChange = Schema.decodeUnknownEffect(ChangeJson);
const quoted = (word: string) => `"${word}"`;

/** The shell with each asked change made: a null name or noun goes back to Kin's. */
export const applied = (shell: Shell, asked: ReadonlyArray<AskedSection>) =>
  shell.sections.map((section) => {
    const change = asked.find((one) => one.id === section.id);
    if (change === undefined) return section;
    const { name, noun, ...rest } = section;
    const nextName = change.name === undefined ? name : (change.name ?? undefined);
    const nextNoun = change.noun === undefined ? noun : (change.noun ?? undefined);
    return {
      ...rest,
      on: change.on ?? section.on,
      ...(nextName === undefined ? {} : { name: nextName }),
      ...(nextNoun === undefined ? {} : { noun: nextNoun }),
    };
  });

type Change =
  | { readonly kind: "on" | "off"; readonly what: string }
  | { readonly kind: "name"; readonly what: string; readonly to: string; readonly from?: string }
  | { readonly kind: "noun"; readonly to: string; readonly from?: string };

/** Each change in the shell's order, by Kin's own title, the company's word quoted after it. */
const changesOf = (
  current: ReadonlyArray<KinShellSection>,
  next: ReadonlyArray<KinShellSection>,
): ReadonlyArray<Change> =>
  BUILT_IN_SECTIONS.flatMap((id): ReadonlyArray<Change> => {
    const before = current.find((one) => one.id === id);
    const after = next.find((one) => one.id === id);
    if (before === undefined || after === undefined) return [];
    const title = kinTitle(id);
    const what =
      before.name === undefined ? title : `${title} (called ${quoted(before.name)} here)`;
    const changes: Array<Change> = [];
    if (after.on !== before.on) changes.push({ kind: after.on ? "on" : "off", what });
    if (after.name !== before.name)
      changes.push({
        kind: "name",
        what: title,
        to: after.name ?? title,
        ...(before.name === undefined ? {} : { from: before.name }),
      });
    if (after.noun !== before.noun)
      changes.push({
        kind: "noun",
        to: after.noun ?? "client",
        ...(before.noun === undefined ? {} : { from: before.noun }),
      });
    return changes;
  });

const was = (from: string | undefined) => (from === undefined ? "" : ` (now ${quoted(from)})`);
const cardLine = (change: Change) => {
  switch (change.kind) {
    case "on":
      return `Turn on ${change.what}`;
    case "off":
      return `Turn off ${change.what}`;
    case "name":
      return `Call ${change.what} ${quoted(change.to)}${was(change.from)}`;
    case "noun":
      return `Call one client ${quoted(change.to)}${was(change.from)}`;
  }
};
const doneLine = (change: Change) => {
  switch (change.kind) {
    case "on":
      return `Turned on ${change.what}.`;
    case "off":
      return `Turned off ${change.what}.`;
    case "name":
      return `Called ${change.what} ${quoted(change.to)}.`;
    case "noun":
      return `Called one client ${quoted(change.to)}.`;
  }
};
const declinedLine = (change: Change) => {
  switch (change.kind) {
    case "on":
      return `Said no to turning on ${change.what}.`;
    case "off":
      return `Said no to turning off ${change.what}.`;
    case "name":
      return `Said no to calling ${change.what} ${quoted(change.to)}.`;
    case "noun":
      return `Said no to calling one client ${quoted(change.to)}.`;
  }
};

/** Each change as the owner's card lists it. */
export const shellChangeLines = (
  current: ReadonlyArray<KinShellSection>,
  next: ReadonlyArray<KinShellSection>,
) => changesOf(current, next).map(cardLine);

/**
 * Stores the change as asked against the shell, bound to its card, and declines every older
 * unanswered shell card, in the card's own transaction. Returns the older cards to close.
 */
export const bindShellChange = Effect.fn("KinShellChanges.bind")(function* (input: {
  readonly orgId: KinOrgId;
  readonly changeId: string;
  readonly agentId: string;
  readonly wakeupId: string;
  readonly before: ReadonlyArray<KinShellSection>;
  readonly after: ReadonlyArray<KinShellSection>;
  readonly baseRev: number;
  readonly widgetId: string;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const patch = yield* encodeChange({ before: input.before, after: input.after }).pipe(
    Effect.orDie,
  );
  yield* sql`INSERT INTO kin_profile_changes (org_id, change_id, agent_id, wakeup_id, patch_json,
      base_rev, widget_id, proposed_at)
    VALUES (${input.orgId}, ${input.changeId}, ${input.agentId}, ${input.wakeupId}, ${patch},
      ${input.baseRev}, ${input.widgetId}, ${input.now})
    ON CONFLICT (org_id, change_id) DO NOTHING`;
  // Only cards stored before this one: a retry of an older card never declines a newer one.
  const older = yield* sql<{ changeId: string; widgetId: string }>`
    SELECT change_id AS "changeId", widget_id AS "widgetId" FROM kin_profile_changes
    WHERE org_id = ${input.orgId} AND substr(change_id, 1, 3) = ${SHELL_CHANGE}
      AND widget_id IS NOT NULL AND applied_at IS NULL AND declined_at IS NULL
      AND rowid < (SELECT rowid FROM kin_profile_changes
        WHERE org_id = ${input.orgId} AND change_id = ${input.changeId})
    ORDER BY rowid`;
  if (older.length === 0) return [];
  yield* sql`UPDATE kin_profile_changes SET declined_at = ${input.now}
    WHERE org_id = ${input.orgId} AND change_id IN ${sql.in(older.map((row) => row.changeId))}`;
  return older.map((row) => row.widgetId);
});

const shellRow = Effect.fn("KinShellChanges.row")(function* (orgId: KinOrgId, widgetId: string) {
  const sql = yield* SqlClient.SqlClient;
  const [row] = yield* sql<{ changeId: string; patch: string; baseRev: number; done: number }>`
    SELECT change_id AS "changeId", patch_json AS patch, base_rev AS "baseRev",
      (applied_at IS NOT NULL OR declined_at IS NOT NULL) AS done
    FROM kin_profile_changes
    WHERE org_id = ${orgId} AND widget_id = ${widgetId}
      AND substr(change_id, 1, 3) = ${SHELL_CHANGE}`;
  return row;
});

/**
 * What memory keeps of a settled shell card: Kin's own line from the sections and the answer,
 * never the card's text. Undefined for any other card.
 */
export const shellDecision = Effect.fn("KinShellChanges.decision")(function* (
  orgId: KinOrgId,
  widgetId: string,
  confirmed: boolean,
) {
  const row = yield* shellRow(orgId, widgetId);
  if (row === undefined) return undefined;
  const { before, after } = yield* decodeChange(row.patch).pipe(Effect.orDie);
  return changesOf(before, after)
    .map(confirmed ? doneLine : declinedLine)
    .join(" ");
});

/**
 * The answer on a shell change card: Confirm applies exactly the stored sections, once, and only
 * at the revision the card showed, for an owner-level person. Undefined for any other card.
 */
export const answerShellChange = Effect.fn("KinShellChanges.answer")(function* (input: {
  readonly orgId: KinOrgId;
  readonly widgetId: string;
  readonly personId: string;
  readonly confirmed: boolean;
  readonly via: "tap" | "reaction";
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* shellRow(input.orgId, input.widgetId);
  if (row === undefined) return undefined;
  const personId = KinPersonId.make(input.personId);
  if (!(yield* ownerLevel(input.orgId, personId).pipe(Effect.orDie)))
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Only the owner or a co-owner changes how Kin is set up for the company.",
    });
  if (input.via === "reaction")
    return yield* new KinChatError({
      reason: "not_allowed",
      message: "Tap Confirm or Cancel on the card to answer this change.",
    });
  if (row.done === 1)
    return yield* new KinChatError({
      reason: "widget_changed",
      message: "This change was already answered or replaced by a newer one.",
    });
  if (!input.confirmed) {
    yield* sql`UPDATE kin_profile_changes SET declined_at = ${input.now}
      WHERE org_id = ${input.orgId} AND change_id = ${row.changeId}`;
    return { title: "Not changed", text: "You said no, so Kin stays set up as it was." };
  }
  if ((yield* get(input.orgId)).rev !== row.baseRev)
    return yield* new KinChatError({
      reason: "conflict",
      message:
        "How Kin is set up changed since this card was made, so nothing was changed. Ask for the change again.",
    });
  const { after } = yield* decodeChange(row.patch).pipe(Effect.orDie);
  yield* set(input.orgId, personId, row.baseRev, after);
  yield* sql`UPDATE kin_profile_changes SET applied_at = ${input.now}
    WHERE org_id = ${input.orgId} AND change_id = ${row.changeId}`;
  return {
    title: "Changed",
    text: "Saved. To change it back, ask again or use Settings.",
  };
});
