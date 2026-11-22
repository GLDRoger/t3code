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
import { wordsOf } from "./words.ts";

/**
 * An agent's change to the company's sections, waiting on the owner's card (`shell_propose` in
 * `mcp.ts`). Its rows live in `kin_profile_changes` under `sc_` ids; the profile's answers skip them.
 */
export const SHELL_CHANGE = "sc_";
export interface AskedSection {
  readonly id: string;
  readonly on?: boolean | undefined;
  readonly name?: string | null | undefined;
  readonly noun?: string | null | undefined;
}
const SectionsJson = Schema.fromJsonString(Schema.Array(KinShellSection));
const encodeSections = Schema.encodeEffect(SectionsJson);
const decodeSections = Schema.decodeUnknownEffect(SectionsJson);
const shown = (word: string) => `“${word}”`;

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

/** Each change, in the shell's order, as the owner's card says it: what it is now beside what it becomes. */
export const shellChangeLines = (
  current: ReadonlyArray<KinShellSection>,
  next: ReadonlyArray<KinShellSection>,
) =>
  next.flatMap((after) => {
    const before = current.find((one) => one.id === after.id);
    const words = wordsOf(after.id);
    if (before === undefined || words === undefined) return [];
    const { title, one } = words;
    const now = (word: string | undefined) => (word === undefined ? "" : ` (now ${shown(word)})`);
    return [
      ...(after.on === before.on
        ? []
        : [`${after.on ? "Turn on" : "Turn off"} ${before.name ?? title}`]),
      ...(after.name === before.name
        ? []
        : [`Call ${title} ${shown(after.name ?? title)}${now(before.name)}`]),
      ...(after.noun === before.noun
        ? []
        : [`Call one ${one} ${shown(after.noun ?? one)}${now(before.noun)}`]),
    ];
  });

/** The change as asked against the shell at `baseRev`; the same one twice is one. */
export const storeShellChange = Effect.fn("KinShellChanges.store")(function* (input: {
  readonly orgId: KinOrgId;
  readonly changeId: string;
  readonly agentId: string;
  readonly wakeupId: string;
  readonly sections: ReadonlyArray<KinShellSection>;
  readonly baseRev: number;
  readonly now: number;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO kin_profile_changes (org_id, change_id, agent_id, wakeup_id, patch_json,
      base_rev, proposed_at)
    VALUES (${input.orgId}, ${input.changeId}, ${input.agentId}, ${input.wakeupId},
      ${yield* encodeSections(input.sections)}, ${input.baseRev}, ${input.now})
    ON CONFLICT (org_id, change_id) DO NOTHING`;
});

/** A newer card replaces every older one still unanswered, which can never be confirmed. Returns their cards. */
export const replaceOlderShellChanges = Effect.fn("KinShellChanges.replaceOlder")(function* (
  orgId: KinOrgId,
  changeId: string,
  now: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const older = yield* sql<{ changeId: string; widgetId: string }>`
    SELECT change_id AS "changeId", widget_id AS "widgetId" FROM kin_profile_changes
    WHERE org_id = ${orgId} AND substr(change_id, 1, 3) = ${SHELL_CHANGE}
      AND change_id != ${changeId} AND widget_id IS NOT NULL
      AND applied_at IS NULL AND declined_at IS NULL
    ORDER BY change_id`;
  if (older.length === 0) return [];
  yield* sql`UPDATE kin_profile_changes SET declined_at = ${now} WHERE org_id = ${orgId}
    AND change_id IN ${sql.in(older.map((row) => row.changeId))}`;
  return older.map((row) => row.widgetId);
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
  const [row] = yield* sql<{ changeId: string; patch: string; baseRev: number; done: number }>`
    SELECT change_id AS "changeId", patch_json AS patch, base_rev AS "baseRev",
      (applied_at IS NOT NULL OR declined_at IS NOT NULL) AS done
    FROM kin_profile_changes
    WHERE org_id = ${input.orgId} AND widget_id = ${input.widgetId}
      AND substr(change_id, 1, 3) = ${SHELL_CHANGE}`;
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
  yield* set(input.orgId, personId, row.baseRev, yield* decodeSections(row.patch));
  yield* sql`UPDATE kin_profile_changes SET applied_at = ${input.now}
    WHERE org_id = ${input.orgId} AND change_id = ${row.changeId}`;
  return {
    title: "Changed",
    text: "Saved. To change it back, ask again or use Settings.",
  };
});
