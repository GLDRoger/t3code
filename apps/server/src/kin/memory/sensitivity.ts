// @effect-diagnostics-next-line nodeBuiltinImport:off -- `reaches` compares content fingerprints synchronously.
import * as NodeCrypto from "node:crypto";

import {
  KinMemoryItemId,
  MemoryItemKind,
  type KinOrgId,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import type { TurnAudience } from "../lead/Audience.ts";
import { entropy, secretExceptions, secretRules } from "./secretScan.ts";

/** What a shared turn may receive of an item's head: these fields, as they are, and no others. */
export const SHARED_HEAD_FIELDS = ["id", "kind", "title", "what", "links", "shared_from"] as const;
/**
 * Head fields a shared turn never receives: dates, provenance, ids, routing and free-form extras.
 * Every head field is on one of the two lists, so a new field is never shared by accident.
 */
export const NEVER_SHARED_FIELDS = [
  "orgId",
  "path",
  "status",
  "due",
  "chat",
  "source_event",
  "on_due",
  "on",
  "every",
  "owner",
  "tz",
  "quiet_hours",
  "recorded_at",
  "valid_from",
  "invalid_at",
  "superseded_by",
  "review_by",
  "source",
  "said_by",
  "trust",
  "sensitive",
  "shared_by",
] as const satisfies ReadonlyArray<keyof MemoryItemHead>;

/** A teammate's attribution, by the names kept when it was said; never their person or chat id. */
const SharedFrom = Schema.Struct({ name: Schema.String, chat_name: Schema.String });
/** What a shared search returns of an item: its projection without the body. */
export const SharedHead = Schema.Struct({
  id: KinMemoryItemId,
  kind: MemoryItemKind,
  title: Schema.String,
  what: Schema.optional(Schema.String),
  links: Schema.Array(Schema.String),
  from: Schema.optional(SharedFrom),
});
/** Everything a shared turn may receive of an item, and exactly what an authorisation covers. */
export const SharedItem = Schema.Struct({ ...SharedHead.fields, body: Schema.String });
export type SharedItem = typeof SharedItem.Type;

type Projected = Pick<MemoryItemHead, (typeof SHARED_HEAD_FIELDS)[number]>;
interface Labelled extends Pick<Projected, "kind" | "title" | "links"> {
  readonly id: string;
  readonly what?: string | undefined;
  readonly shared_from?: Projected["shared_from"] | undefined;
  readonly sensitive?: boolean | undefined;
  readonly invalid_at?: string | null | undefined;
  readonly superseded_by?: string | null | undefined;
}
/** An item as a turn would read it: its head and body. */
export interface Shown {
  readonly head: Labelled;
  readonly body: string;
}

/**
 * Who let the team know an item, from stored rows: the owner's own message that wrote it, his
 * setting or confirmation on the Memory screen, or a teammate's own words. Older rows may say
 * `owner_label`, which chat no longer grants.
 */
export type Sharing = "owner_message" | "owner_setting" | "owner_confirmed" | "teammate";

/** The one projection every shared-turn surface returns, built from the fixed field list above. */
export const shareable = ({ head, body }: Shown): SharedItem => ({
  id: KinMemoryItemId.make(head.id),
  kind: head.kind,
  title: head.title,
  ...(head.what === undefined ? {} : { what: head.what }),
  links: [...head.links],
  ...(head.shared_from === undefined
    ? {}
    : { from: { name: head.shared_from.name, chat_name: head.shared_from.chat_name } }),
  body,
});
/** The projection's words as plain text, for the backstops that look for secrets and money. */
export const contentOf = (item: Shown) => {
  const shared = shareable(item);
  return [
    shared.title,
    shared.what ?? "",
    shared.body,
    ...shared.links,
    ...(shared.from === undefined ? [] : [shared.from.name, shared.from.chat_name]),
  ].join("\n");
};
/**
 * Over a canonical encoding of the projection, so the words authorised are the words returned.
 * Any change to them, by anyone, ends the authorisation that covered the old ones.
 */
export const fingerprint = (item: Shown) => {
  const shared = shareable(item);
  const canonical = JSON.stringify([
    "kin-shared-v2",
    shared.id,
    shared.kind,
    shared.title,
    shared.what ?? null,
    shared.links,
    shared.from === undefined ? null : [shared.from.name, shared.from.chat_name],
    shared.body,
  ]);
  return NodeCrypto.createHash("sha256").update(canonical).digest("hex");
};

/** What the database says about who may know an item. The item's own file never decides it. */
export interface StoredLabels {
  /** Marked sensitive since, whatever else is recorded (`hold`). */
  readonly held: ReadonlySet<string>;
  /** The content an owner authorisation, or a teammate's own message, let the team know. */
  readonly shared: ReadonlyMap<string, string>;
  /** The nightly pass's one look at an item its file had no label for (`classify`). */
  readonly classified: ReadonlyMap<string, boolean>;
  /**
   * Open suggestions that the team could know an item, for the owner to confirm: the content
   * suggested (null when only an earlier version recorded none) and the revision it came in at.
   */
  readonly suggested: ReadonlyMap<
    string,
    { readonly content: string | null; readonly rev: number }
  >;
}

/**
 * What the item's labels say, for keeping a label on a rewrite: held, else its file, else the
 * nightly pass, and unlabelled is sensitive. Never enough on its own to let the team know it.
 */
export const isSensitive = (
  item: Pick<Labelled, "id" | "sensitive">,
  labels: Pick<StoredLabels, "held" | "classified">,
) => labels.held.has(item.id) || (item.sensitive ?? labels.classified.get(item.id) ?? true);

/** The team may know it: a stored authorisation of exactly this content, not held, not marked. */
const teamCanKnow = (item: Shown, labels: StoredLabels) =>
  !labels.held.has(item.head.id) &&
  item.head.sensitive !== true &&
  labels.shared.get(item.head.id) === fingerprint(item);

/**
 * The one check for whether a memory item may reach a turn: an owner-only turn sees everything,
 * any other only what a stored authorisation lets the team know, and only while it still holds.
 * What the team may know is company knowledge, not chat history: every shared turn reads it,
 * whatever chat it came from or joined.
 */
export const reaches = (audience: TurnAudience, item: Shown, labels: StoredLabels) =>
  audience === "owner_only" ||
  (teamCanKnow(item, labels) &&
    (item.head.invalid_at ?? null) === null &&
    (item.head.superseded_by ?? null) === null);

export type Visibility = "only_owner" | "team" | "suggested";
/** What the owner sees: the team knows it, it was suggested for the team, or it is theirs alone. */
export const visibility = (item: Shown, labels: StoredLabels): Visibility => {
  if (teamCanKnow(item, labels)) return "team";
  const suggestion = labels.suggested.get(item.head.id);
  return suggestion !== undefined &&
    !labels.held.has(item.head.id) &&
    item.head.sensitive !== true &&
    suggestion.content === fingerprint(item)
    ? "suggested"
    : "only_owner";
};

/**
 * Binds each suggestion that recorded no content (an earlier version's) to the words `items`
 * hold now, the first time the owner is shown them, at a fresh revision so no earlier listing's
 * yes takes it; it is suggested, and confirmable, only as those words from then on. Returns the
 * labels as stored after.
 */
export const bindSuggestions = Effect.fn("KinSensitivity.bindSuggestions")(function* (
  orgId: KinOrgId,
  items: ReadonlyArray<Shown>,
  labels: StoredLabels,
) {
  const sql = yield* SqlClient.SqlClient;
  const counts = new Map<string, number>();
  for (const { head } of items) counts.set(head.id, (counts.get(head.id) ?? 0) + 1);
  let bound = false;
  for (const item of items) {
    const suggestion = labels.suggested.get(item.head.id);
    if (suggestion?.content !== null || counts.get(item.head.id) !== 1) continue;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO kin_memory_label_revisions (org_id, revision) VALUES (${orgId}, 1)
          ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1`;
        yield* sql`UPDATE kin_memory_labels SET suggested_content = ${fingerprint(item)},
            suggested_rev = (SELECT revision FROM kin_memory_label_revisions
              WHERE org_id = ${orgId})
          WHERE org_id = ${orgId} AND item_id = ${item.head.id}
            AND suggested_content IS NULL AND suggested_rev = ${suggestion.rev}`;
      }),
    );
    bound = true;
  }
  return bound ? yield* storedLabels(orgId) : labels;
});

export const storedLabels = Effect.fn("KinSensitivity.storedLabels")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    itemId: string;
    heldAt: number | null;
    classified: number | null;
    sharedContent: string | null;
    sharedHow: string | null;
    suggestedContent: string | null;
    suggestedRev: number | null;
  }>`
    SELECT item_id AS "itemId", held_at AS "heldAt", classified,
      shared_content AS "sharedContent", shared_how AS "sharedHow",
      suggested_content AS "suggestedContent", suggested_rev AS "suggestedRev"
    FROM kin_memory_labels WHERE org_id = ${orgId} ORDER BY item_id`;
  return {
    held: new Set(rows.filter((row) => row.heldAt !== null).map((row) => row.itemId)),
    shared: new Map(
      rows.flatMap((row) =>
        row.sharedContent === null || row.sharedHow === null
          ? []
          : [[row.itemId, row.sharedContent] as const],
      ),
    ),
    classified: new Map(
      rows.flatMap((row) =>
        row.classified === null ? [] : [[row.itemId, row.classified === 1] as const],
      ),
    ),
    suggested: new Map(
      rows.flatMap((row) =>
        row.suggestedRev === null
          ? []
          : [[row.itemId, { content: row.suggestedContent, rev: row.suggestedRev }] as const],
      ),
    ),
  } satisfies StoredLabels;
});

/** The items of `items` that may reach a turn read by `audience`, by `reaches`. */
export const reaching = Effect.fn("KinSensitivity.reaching")(function* <A extends Shown>(
  orgId: KinOrgId,
  audience: TurnAudience,
  items: ReadonlyArray<A>,
) {
  if (audience === "owner_only") return items;
  const labels = yield* storedLabels(orgId);
  return items.filter((item) => reaches(audience, item, labels));
});

/** Sensitive from now, ahead of the item's file. */
export const hold = Effect.fn("KinSensitivity.hold")(function* (orgId: KinOrgId, itemId: string) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`INSERT INTO kin_memory_labels (org_id, item_id, held_at)
    VALUES (${orgId}, ${itemId}, ${now})
    ON CONFLICT (org_id, item_id) DO UPDATE SET held_at = COALESCE(held_at, excluded.held_at)`;
});

/**
 * The team may know `content` of the item, from here until anyone changes it. Callers settle
 * `how` from stored rows (`Sharing`). Ends any hold and any open suggestion.
 */
export const authorise = Effect.fn("KinSensitivity.authorise")(function* (
  orgId: KinOrgId,
  itemId: string,
  content: string,
  how: Sharing,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = yield* Clock.currentTimeMillis;
  yield* sql`INSERT INTO kin_memory_labels (org_id, item_id, shared_content, shared_how, shared_at)
    VALUES (${orgId}, ${itemId}, ${content}, ${how}, ${now})
    ON CONFLICT (org_id, item_id) DO UPDATE SET held_at = NULL,
      shared_content = excluded.shared_content, shared_how = excluded.shared_how,
      shared_at = excluded.shared_at, suggested_content = NULL, suggested_rev = NULL`;
});

/**
 * Something other than the owner said the team could know `content`: the owner is asked, and
 * until they confirm it stays theirs alone. Nothing to ask when the team already knows it.
 */
export const suggest = Effect.fn("KinSensitivity.suggest")(function* (
  orgId: KinOrgId,
  itemId: string,
  content: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const [current] = yield* sql<{ shared: string | null; suggested: string | null }>`
    SELECT shared_content AS shared, suggested_content AS suggested FROM kin_memory_labels
    WHERE org_id = ${orgId} AND item_id = ${itemId} ORDER BY item_id`;
  if (current?.shared === content || current?.suggested === content) return;
  yield* sql`INSERT INTO kin_memory_label_revisions (org_id, revision) VALUES (${orgId}, 1)
    ON CONFLICT (org_id) DO UPDATE SET revision = revision + 1`;
  yield* sql`INSERT INTO kin_memory_labels (org_id, item_id, suggested_content, suggested_rev)
    VALUES (${orgId}, ${itemId}, ${content},
      (SELECT revision FROM kin_memory_label_revisions WHERE org_id = ${orgId}))
    ON CONFLICT (org_id, item_id) DO UPDATE SET
      suggested_content = excluded.suggested_content, suggested_rev = excluded.suggested_rev`;
});

/**
 * Records the nightly pass's look at items no file labelled, once per item: a later pass never
 * changes one. "The team can know it" is only ever a suggestion, of the content it read.
 */
export const classify = Effect.fn("KinSensitivity.classify")(function* (
  orgId: KinOrgId,
  labels: ReadonlyMap<string, { readonly sensitive: boolean; readonly content: string }>,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const [itemId, { sensitive, content }] of labels) {
    const inserted = yield* sql`INSERT INTO kin_memory_labels (org_id, item_id, classified)
      VALUES (${orgId}, ${itemId}, ${sensitive ? 1 : 0})
      ON CONFLICT (org_id, item_id) DO UPDATE SET classified = excluded.classified
        WHERE kin_memory_labels.classified IS NULL
      RETURNING item_id`;
    if (inserted.length > 0 && !sensitive) yield* suggest(orgId, itemId, content);
  }
});

const withoutLinks = (text: string) => text.replace(/\bhttps?:\/\/\S+/gi, " ");
const KEY_SHAPED = /(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/=-]{20,}(?![A-Za-z0-9_+/=-])/g;
const mixed = (token: string) =>
  /[a-z]/.test(token) && /[A-Z]/.test(token) && /\d/.test(token) && entropy(token) >= 4;
const commitHash = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

/**
 * Text that holds an actual secret: a known key or token shape, a private key block, or a long
 * random-looking string. Memory never stores one; the lead says where it is kept instead.
 */
export const looksLikeSecret = (text: string) => {
  for (const [id, pattern] of secretRules) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const secret = match[1] ?? match[0];
    const exception = secretExceptions[id];
    if (
      exception !== undefined &&
      ((exception.minEntropy !== undefined && entropy(secret) < exception.minEntropy) ||
        exception.secret?.some((allowed) => allowed.test(secret)) ||
        exception.match?.some((allowed) => allowed.test(match[0])))
    )
      continue;
    return true;
  }
  return Array.from(withoutLinks(text).matchAll(KEY_SHAPED)).some(
    ([token]) => token.length >= 32 && !commitHash.test(token) && mixed(token),
  );
};

const CURRENCY_CODES = "inr|usd|cad|aud|nzd|sgd|hkd|eur|gbp|chf|jpy|cny|aed|sar|qar|zar";
const MONEY_WORDS = `rupees?|dollars?|euros?|pounds?|dirhams?|bucks|lakhs?|lacs?|crores?|${CURRENCY_CODES}`;
const NUMBER_WORDS =
  "one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|lakhs?|lacs?|crores?";
// A key's known prefix, then its characters with spaces or separators put between them.
const KEY_PREFIX =
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|glpat|xox[abprs]|whsec)\s*[-_]\s*(?:[A-Za-z0-9]+\s*[-_]\s*)?[A-Za-z0-9](?:[\s._-]{0,3}[A-Za-z0-9]){5,}/i;
const SENSITIVE_PATTERNS = [
  // Money: a currency sign or code beside a number, or a number with a money word, in digits or words.
  new RegExp(`(?:[$€£¥₹]|\\b(?:rs|${CURRENCY_CODES})\\.?)\\s?\\d`, "i"),
  new RegExp(`\\b\\d[\\d,.]*\\s?(?:k\\s)?(?:${MONEY_WORDS})\\b`, "i"),
  new RegExp(`\\b(?:(?:${NUMBER_WORDS})[\\s-]+(?:and[\\s-]+)?)+(?:${MONEY_WORDS})\\b`, "i"),
  new RegExp(`(?:[$€£¥₹]|\\b(?:rs|${CURRENCY_CODES})\\.?)\\s?(?:${NUMBER_WORDS})\\b`, "i"),
  // Bank details: IBAN and IFSC shapes, an account number, or any long run of digits.
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/,
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/,
  /\b(?:a\/c|acct|account)\b[^.\n]{0,24}\d{6,}/i,
  /\b\d{9,18}\b/,
  // Access: credentials, and where they are kept or how to get in.
  /\b(?:passwords?|passcodes?|passphrases?|credentials?|log-?ins?|tokens?)\b/i,
  /\b(?:api|deploy|ssh|private|signing|encryption|access|secret|service|licen[cs]e)[\s_-]?keys?\b/i,
  /\b(?:vault|keychain|1password|bitwarden|lastpass|secrets? manager)\b/i,
  // Key shapes, also with their characters spaced or split apart.
  KEY_PREFIX,
  /\b(?:AKIA|ASIA)(?:[\s-]?[A-Z0-9]){16}\b/,
  /\bAIza(?:[\s-]?[0-9A-Za-z_]){30,}/,
];

/**
 * Text the server labels sensitive whatever the lead said: amounts, bank details, and anything
 * about credentials or where they are kept. It only ever makes an item more sensitive, and is a
 * net under the rule that only a stored authorisation lets the team know anything.
 */
export const mustBeSensitive = (text: string) =>
  SENSITIVE_PATTERNS.some((pattern) => pattern.test(text)) ||
  Array.from(withoutLinks(text).matchAll(KEY_SHAPED)).some(
    ([token]) => !commitHash.test(token) && mixed(token),
  );
