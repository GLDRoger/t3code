import { KIN_TAGS_MAX, KinChatError, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import type { FieldValue, ListName } from "./lists.ts";
import { crmSeenBy, type KinViewer } from "./teamView.ts";

/**
 * Tags are the company's own words on clients, prospects and contacts; a campaign's audience is
 * one. They are cleaned once, here, on every write: trimmed, matched without regard to case, and
 * kept in the spelling the company used first.
 */

const TAGGED = ["clients", "contacts"] as const;

/** What two tags are compared by: their case never makes them two. */
const tagFold = (tag: string) => tag.trim().normalize("NFC").toLowerCase();

/**
 * Every tag on the clients and contacts this viewer sees and every campaign audience, oldest use
 * first, repeats included.
 */
const used = Effect.fn("KinTags.used")(function* (orgId: KinOrgId, viewer: KinViewer) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ tag: string }>`SELECT tag FROM (
      SELECT t.value AS tag, r.created_at AS at, r.record_id AS id, t.key AS n
      FROM kin_records r, json_each(r.fields_json, '$.tags') t
      WHERE r.org_id = ${orgId} AND r.register_id IN ${sql.in(TAGGED)} AND t.type = 'text'
        AND ${crmSeenBy(sql, viewer)}
      UNION ALL
      SELECT json_extract(r.fields_json, '$.audience'), r.created_at, r.record_id, 0
      FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'projects'
        AND r.category = 'campaign' AND json_type(r.fields_json, '$.audience') = 'text'
        AND ${crmSeenBy(sql, viewer)})
    ORDER BY at, id, n`;
  return rows.map((row) => row.tag);
});

/** Each tag in use by this viewer's sight once, folded to the spelling first used. */
export const companyTags = Effect.fn("KinTags.company")(function* (
  orgId: KinOrgId,
  viewer: KinViewer,
) {
  const spelled = new Map<string, string>();
  for (const tag of yield* used(orgId, viewer)) {
    const fold = tagFold(tag);
    if (fold !== "" && !spelled.has(fold)) spelled.set(fold, tag.trim());
  }
  return spelled;
});

/** Every stored spelling of this tag, so a filter finds one written before tags were cleaned. */
export const spellingsOf = Effect.fn("KinTags.spellings")(function* (
  orgId: KinOrgId,
  tag: string,
  viewer: KinViewer,
) {
  const fold = tagFold(tag);
  const all = new Set((yield* used(orgId, viewer)).filter((one) => tagFold(one) === fold));
  all.add(tag.trim());
  return [...all];
});

const tooMany = new KinChatError({
  reason: "invalid_state",
  message: `A client, prospect or contact has at most ${KIN_TAGS_MAX} tags.`,
});

/**
 * The fields to write with their tags cleaned: each tag once, in the company's first spelling,
 * at most `KIN_TAGS_MAX`, none clearing them. A project's `audience` is spelled the same way.
 * Spellings come from the whole company, so a tag is one tag whoever writes it.
 */
export const cleanTags = Effect.fn("KinTags.clean")(function* (
  orgId: KinOrgId,
  list: ListName | string,
  fields: Readonly<Record<string, FieldValue | null>> | undefined,
) {
  if (fields === undefined) return fields;
  const tags = (TAGGED as ReadonlyArray<string>).includes(list) ? fields.tags : undefined;
  const audience = list === "projects" ? fields.audience : undefined;
  if (!Array.isArray(tags) && typeof audience !== "string") return fields;
  const spelled = yield* companyTags(orgId, { _tag: "ownerLevel" });
  const spell = (tag: string) => spelled.get(tagFold(tag)) ?? tag.trim();
  if (typeof audience === "string")
    return { ...fields, audience: audience.trim() === "" ? null : spell(audience) };
  const seen = new Set<string>();
  const cleaned = (tags as ReadonlyArray<string>).flatMap((tag) => {
    const fold = tagFold(tag);
    if (fold === "" || seen.has(fold)) return [];
    seen.add(fold);
    return [spell(tag)];
  });
  if (cleaned.length > KIN_TAGS_MAX) return yield* tooMany;
  return { ...fields, tags: cleaned.length === 0 ? null : cleaned };
});
