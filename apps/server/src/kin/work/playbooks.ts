import { KinChatError, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Playbooks are docs of kind `playbook`: prose the agents read, plus fenced `kin` blocks of
 * declared values. The server reads only those blocks, against the closed list below, so how the
 * company works stays doc text the owner changes in chat. No key can grant authority: who may
 * Confirm or see anything is stored access, never a playbook.
 */

type Unit = "days" | "hours" | "tasks" | "percent";
type KeyDef = {
  readonly unit: Unit;
  readonly min: number;
  readonly max: number;
  readonly default: number;
  /** A playbook filed under one client may set it for that client alone. */
  readonly client?: true;
};

const PLAYBOOK_KEYS = {
  advance_wait_days: { unit: "days", min: 1, max: 90, default: 7, client: true },
  quote_follow_up_days: { unit: "days", min: 1, max: 60, default: 5, client: true },
  due_soon_hours: { unit: "hours", min: 1, max: 336, default: 24 },
  stalled_after_days: { unit: "days", min: 1, max: 60, default: 3 },
  waiting_too_long_days: { unit: "days", min: 1, max: 60, default: 5 },
  milestone_heads_up_days: { unit: "days", min: 1, max: 60, default: 3 },
  // How long after a meeting's time, with no outcome noted, to ask how it went.
  meeting_follow_up_hours: { unit: "hours", min: 1, max: 168, default: 2 },
  project_quiet_days: { unit: "days", min: 1, max: 90, default: 7, client: true },
  overloaded_load: { unit: "tasks", min: 1, max: 100, default: 8 },
  pr_open_too_long_hours: { unit: "hours", min: 1, max: 720, default: 72 },
  review_waiting_hours: { unit: "hours", min: 1, max: 336, default: 24 },
  // Days to pay an invoice issued without a due date, when the client's terms name none.
  payment_due_days: { unit: "days", min: 1, max: 180, default: 15, client: true },
  chase_invoice_after_days: { unit: "days", min: 1, max: 120, default: 10, client: true },
  // Days after a month ends before its missing bank statement is worth a line in the morning brief.
  statement_due_days: { unit: "days", min: 1, max: 60, default: 5 },
  second_reminder_after_days: { unit: "days", min: 1, max: 60, default: 7, client: true },
  client_checkin_days: { unit: "days", min: 1, max: 180, default: 14, client: true },
  client_cold_after_days: { unit: "days", min: 1, max: 365, default: 30, client: true },
  reply_owed_hours: { unit: "hours", min: 1, max: 336, default: 24, client: true },
  renewal_heads_up_days: { unit: "days", min: 1, max: 120, default: 14, client: true },
  // Inside the heads-up, a renewal is only mentioned until this many days before it: then drafted.
  renewal_draft_days: { unit: "days", min: 1, max: 120, default: 7, client: true },
  // How long an open deal goes with no contact, note, stage move or next-step change before it is quiet.
  deal_quiet_days: { unit: "days", min: 1, max: 365, default: 14 },
  // How far under the straight line to its target a goal may fall before it counts as behind.
  goal_behind_percent: { unit: "percent", min: 1, max: 90, default: 20 },
} as const satisfies Record<string, KeyDef>;
export type PlaybookKey = keyof typeof PLAYBOOK_KEYS;
const isKey = (key: string): key is PlaybookKey => Object.hasOwn(PLAYBOOK_KEYS, key);
const clientKey = (key: PlaybookKey) => (PLAYBOOK_KEYS[key] as KeyDef).client === true;

export type PlaybookValues = ReadonlyMap<PlaybookKey, number>;
type Parsed =
  | { readonly _tag: "ok"; readonly values: PlaybookValues }
  | { readonly _tag: "refused"; readonly reason: string };

const FENCE = /^\s*(`{3,}|~{3,})\s*(\S*)\s*$/;
const LINE = /^([a-z][a-z0-9_]*)\s*:\s*(\d+)(?:\s+([a-z]+))?\s*$/;

/** Every `kin` block's values; prose is never read. A key set twice is refused. */
const parseKinBlocks = (body: string): Parsed => {
  const values = new Map<PlaybookKey, number>();
  const lines = body.split("\n");
  let fence: string | undefined;
  let inKin = false;
  let opened = 0;
  for (const [index, raw] of lines.entries()) {
    const marker = FENCE.exec(raw);
    if (fence === undefined) {
      if (marker !== null) {
        fence = marker[1]!;
        inKin = marker[2] === "kin";
        opened = index + 1;
      }
      continue;
    }
    if (marker !== null && marker[2] === "" && marker[1]!.startsWith(fence)) {
      fence = undefined;
      inKin = false;
      continue;
    }
    if (!inKin) continue;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const match = LINE.exec(line);
    if (match === null)
      return refused(
        `line ${index + 1} of the kin block should read "key: number", as in "chase_invoice_after_days: 10"`,
      );
    const [, key, digits, unit] = match;
    if (!isKey(key!))
      return refused(
        `${key} isn't a playbook setting; the settings are ${Object.keys(PLAYBOOK_KEYS).join(", ")}`,
      );
    const def: KeyDef = PLAYBOOK_KEYS[key];
    if (unit !== undefined && unit !== def.unit && `${unit}s` !== def.unit)
      return refused(`${words(key)} is counted in ${def.unit}, not ${unit}`);
    const value = Number(digits);
    if (value < def.min || value > def.max)
      return refused(`${words(key)} must be ${def.min} to ${def.max} ${def.unit}`);
    if (values.has(key)) return refused(`${words(key)} is set twice in this playbook`);
    values.set(key, value);
  }
  if (inKin) return refused(`the kin block opened on line ${opened} is never closed`);
  return { _tag: "ok", values };
};
/** People read refusals too, and clients hide snake_case as tool talk. */
const words = (key: string) => key.replaceAll("_", " ");
const refused = (reason: string): Parsed => ({ _tag: "refused", reason });
const refusal = (reason: string) =>
  new KinChatError({ reason: "invalid_state", message: `${reason}; nothing was changed.` });

type PlaybookRow = {
  readonly recordId: string;
  readonly key: string;
  readonly title: string;
  readonly partyId: string | null;
  readonly sensitive: number;
  readonly body: string;
};

/** Live playbooks (not archived) with their latest text, oldest first. */
const livePlaybooks = (sql: SqlClient.SqlClient, orgId: KinOrgId) =>
  sql<PlaybookRow>`SELECT r.record_id AS "recordId", r.key, r.title, r.party_id AS "partyId",
      r.sensitive, v.body
    FROM kin_records r JOIN kin_doc_versions v ON v.org_id = r.org_id AND v.record_id = r.record_id
    WHERE r.org_id = ${orgId} AND r.register_id = 'docs' AND r.category = 'playbook'
      AND r.state <> 'dropped' AND v.body_kind = 'markdown'
      AND v.version = (SELECT MAX(w.version) FROM kin_doc_versions w
        WHERE w.org_id = r.org_id AND w.record_id = r.record_id)
    ORDER BY r.created_at, LENGTH(r.key), r.key`;

/**
 * Refuses a write that would leave this playbook's blocks invalid. Run inside the write's
 * transaction after it, so a refusal rolls it back and the stored latest version stays valid.
 */
export const guardPlaybook = Effect.fn("KinPlaybooks.guard")(function* (
  orgId: KinOrgId,
  recordId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const all = yield* livePlaybooks(sql, orgId);
  const mine = all.find((row) => row.recordId === recordId);
  if (mine === undefined) return;
  const parsed = parseKinBlocks(mine.body);
  if (parsed._tag === "refused") return yield* refusal(`${mine.key}: ${parsed.reason}`);
  if (mine.partyId !== null)
    for (const key of parsed.values.keys())
      if (!clientKey(key))
        return yield* refusal(
          `${words(key)} is set for the whole company, so it belongs in a company playbook, not one filed under a client`,
        );
  for (const other of all) {
    if (other.recordId === recordId || other.partyId !== mine.partyId) continue;
    const theirs = parseKinBlocks(other.body);
    if (theirs._tag === "refused") continue;
    for (const key of parsed.values.keys())
      if (theirs.values.has(key))
        return yield* refusal(
          `${words(key)} is already set in ${other.key} ${other.title}; change it there, or take it out there first`,
        );
  }
});

export type ThresholdSource =
  | { readonly _tag: "default" }
  | { readonly _tag: "playbook"; readonly key: string; readonly title: string };

/**
 * The value a playbook sets for `key`: the client's own playbook first, then the company's, else
 * the registry default. The pulse's `threshold` calls this; `from` names the governing doc.
 */
export const playbookThreshold = Effect.fn("KinPlaybooks.threshold")(function* (
  orgId: KinOrgId,
  key: PlaybookKey,
  clientId?: string,
) {
  return (yield* playbookThresholds(orgId))(key, clientId);
});

/**
 * `playbookThreshold` for many keys and clients over one read of the playbooks, for a sweep that
 * asks once per client or project.
 */
export const playbookThresholds = Effect.fn("KinPlaybooks.thresholds")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  return thresholdsOf(yield* livePlaybooks(sql, orgId));
});

/**
 * One key's company value and each client playbook's own, from one read: for a query that
 * compares against it in SQL rather than row by row.
 */
export const playbookClientValues = Effect.fn("KinPlaybooks.clientValues")(function* (
  orgId: KinOrgId,
  key: PlaybookKey,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* livePlaybooks(sql, orgId);
  const lookup = thresholdsOf(rows);
  const clients = new Set(rows.flatMap((row) => (row.partyId === null ? [] : [row.partyId])));
  return {
    value: lookup(key).value,
    byClient: Object.fromEntries([...clients].map((id) => [id, lookup(key, id).value])),
  };
});

const thresholdsOf = (playbooks: ReadonlyArray<PlaybookRow>) => {
  const rows = playbooks.map((row) => {
    const parsed = parseKinBlocks(row.body);
    return { row, values: parsed._tag === "ok" ? parsed.values : undefined };
  });
  return (key: PlaybookKey, clientId?: string) => {
    const pick = (party: string | null) => {
      for (const { row, values } of rows) {
        if (row.partyId !== party) continue;
        const value = values?.get(key);
        if (value !== undefined)
          return {
            value,
            from: { _tag: "playbook" as const, key: row.key, title: row.title },
          };
      }
      return undefined;
    };
    const def: KeyDef = PLAYBOOK_KEYS[key];
    const scoped = clientId === undefined || def.client !== true ? undefined : pick(clientId);
    return (
      scoped ??
      pick(null) ?? {
        value: def.default,
        from: { _tag: "default" } as ThresholdSource,
      }
    );
  };
};

const INDEX_MAX = 40;
const LINE_MAX = 160;

/** What a playbook covers, in a line: its "When this applies" text, else its first prose line. */
const coverLine = (body: string) => {
  const lines = body.split("\n").map((line) => line.trim());
  const when = lines.findIndex((line) => /^#+\s*when (this|it) applies/i.test(line));
  const from = when === -1 ? 0 : when + 1;
  const line = lines.slice(from).find((one) => one !== "" && !/^(#|```|~~~|[-*]\s*$)/.test(one));
  return line === undefined ? "" : Array.from(line).slice(0, LINE_MAX).join("");
};

/** One line per live playbook for an owner-only prompt: key, title, what it covers. */
export const playbookIndex = Effect.fn("KinPlaybooks.index")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* livePlaybooks(sql, orgId);
  return rows.slice(0, INDEX_MAX).map((row) => {
    const covers = coverLine(row.body);
    return `${row.key} ${row.title}${row.partyId === null ? "" : " (one client's)"}${covers === "" ? "" : `: ${covers}`}`;
  });
});
