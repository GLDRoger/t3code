import type { KinOrgId, MemoryItemHead } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { TurnAudience } from "../lead/Audience.ts";
import { entropy, secretExceptions, secretRules } from "./secretScan.ts";

type Labelled = { readonly id: string; readonly sensitive?: MemoryItemHead["sensitive"] };

/** What the database says about who may know an item, beside the item's own file. */
export interface StoredLabels {
  /** Marked sensitive since, whatever the file says (`hold`). */
  readonly held: ReadonlySet<string>;
  /** The nightly pass's label for an item whose file has none (`classify`). */
  readonly classified: ReadonlyMap<string, boolean>;
}

/**
 * Whether an item is for the owner alone: held, else what its file says, else what the nightly
 * pass decided, and an item nobody has labelled at all is sensitive.
 */
export const isSensitive = (item: Labelled, labels: StoredLabels) =>
  labels.held.has(item.id) || (item.sensitive ?? labels.classified.get(item.id) ?? true);

/**
 * The one check for whether a memory item may reach a turn. A turn only the owner reads sees
 * everything; any other turn sees only what is not sensitive.
 */
export const reaches = (audience: TurnAudience, item: Labelled, labels: StoredLabels) =>
  audience === "owner_only" || !isSensitive(item, labels);

export const storedLabels = Effect.fn("KinSensitivity.storedLabels")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ itemId: string; heldAt: number | null; classified: number | null }>`
    SELECT item_id AS "itemId", held_at AS "heldAt", classified FROM kin_memory_labels
    WHERE org_id = ${orgId} ORDER BY item_id`;
  return {
    held: new Set(rows.filter((row) => row.heldAt !== null).map((row) => row.itemId)),
    classified: new Map(
      rows.flatMap((row) =>
        row.classified === null ? [] : [[row.itemId, row.classified === 1] as const],
      ),
    ),
  } satisfies StoredLabels;
});

/** The items of `items` that may reach a turn read by `audience`, by `reaches`. */
export const reaching = Effect.fn("KinSensitivity.reaching")(function* <A extends Labelled>(
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

/** The owner let the team know it: from here its file decides. */
export const release = Effect.fn("KinSensitivity.release")(function* (
  orgId: KinOrgId,
  itemId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE kin_memory_labels SET held_at = NULL
    WHERE org_id = ${orgId} AND item_id = ${itemId}`;
});

/** Records the nightly pass's labels, once per item: a later pass never changes one. */
export const classify = Effect.fn("KinSensitivity.classify")(function* (
  orgId: KinOrgId,
  labels: ReadonlyMap<string, boolean>,
) {
  const sql = yield* SqlClient.SqlClient;
  for (const [itemId, sensitive] of labels)
    yield* sql`INSERT INTO kin_memory_labels (org_id, item_id, classified)
      VALUES (${orgId}, ${itemId}, ${sensitive ? 1 : 0})
      ON CONFLICT (org_id, item_id) DO UPDATE
        SET classified = COALESCE(classified, excluded.classified)`;
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

const SENSITIVE_PATTERNS = [
  // Money: a currency sign or code beside a number, or a number with a money word.
  /(?:[$€£¥₹]|\b(?:rs\.?|inr|usd|eur|gbp|aed|sgd)\s?)\d/i,
  /\b\d[\d,.]*\s?(?:lakhs?|lacs?|crores?|rupees|dollars|euros|pounds|usd|inr|eur|gbp|aed|sgd)\b/i,
  // Bank details: IBAN and IFSC shapes, an account number, or any long run of digits.
  /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/,
  /\b[A-Z]{4}0[A-Z0-9]{6}\b/,
  /\b(?:a\/c|acct|account)\b[^.\n]{0,24}\d{6,}/i,
  /\b\d{9,18}\b/,
  // Access: credentials, and where they are kept or how to get in.
  /\b(?:passwords?|passcodes?|passphrases?|credentials?|log-?ins?|tokens?)\b/i,
  /\b(?:api|deploy|ssh|private|signing|encryption|access|secret|service|licen[cs]e)[\s_-]?keys?\b/i,
  /\b(?:vault|keychain|1password|bitwarden|lastpass|secrets? manager)\b/i,
];

/**
 * Text the server labels sensitive whatever the lead said: amounts, bank details, and anything
 * about credentials or where they are kept. It only ever makes an item more sensitive.
 */
export const mustBeSensitive = (text: string) =>
  SENSITIVE_PATTERNS.some((pattern) => pattern.test(text)) ||
  Array.from(withoutLinks(text).matchAll(KEY_SHAPED)).some(
    ([token]) => !commitHash.test(token) && mixed(token),
  );
