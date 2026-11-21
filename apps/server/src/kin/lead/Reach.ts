import type { KinAgentId, KinOrgId, KinPersonId } from "@t3tools/contracts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous id hash; Digest would add a service.
import * as NodeCrypto from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { accessSql } from "../people/KinAccess.ts";
import { teamAgent } from "./LeadAccess.ts";

// Approvals reach this through KinLevels, so it must not reach the chat service.

/** A person or an agent of one org: either side of a pair that may or may not message. */
export type KinParty =
  | { readonly _tag: "person"; readonly personId: KinPersonId }
  | { readonly _tag: "agent"; readonly agentId: KinAgentId };

export const person = (personId: KinPersonId): KinParty => ({ _tag: "person", personId });
export const agent = (agentId: KinAgentId): KinParty => ({ _tag: "agent", agentId });

const idOf = (party: KinParty): string =>
  party._tag === "person" ? party.personId : party.agentId;
const same = (a: KinParty, b: KinParty) => a._tag === b._tag && idOf(a) === idOf(b);
/** The pair as stored: sorted by (kind, id), so one row holds both ways. */
const ordered = (a: KinParty, b: KinParty) => {
  const x = { kind: a._tag, id: idOf(a) };
  const y = { kind: b._tag, id: idOf(b) };
  return x.kind < y.kind || (x.kind === y.kind && x.id < y.id)
    ? { one: x, other: y }
    : { one: y, other: x };
};

export type Reach = "allowed" | "restricted" | "removed" | "unknown" | "self";

/**
 * What an agent reads when a restricted pair is tried; nothing was sent. `asker` is who to tell,
 * or null when the owner asked, who can lift it.
 */
export const restrictedLine = (name: string, agentName: string, asker?: string | null) =>
  `${name} and ${agentName} can't message each other here, so nothing was sent. ${
    asker === null
      ? "The owner can lift that."
      : `${asker === undefined ? "The owner can lift it" : `Tell ${asker} in one line that the owner can lift it`}. Don't try another way.`
  }`;

export const UNRESTRICTABLE = "Owners and co-owners can message everyone.";
const OWN_AGENT = "An agent's own owner can always message it.";

/**
 * SQL over trusted column names, for `sql.literal`: a live restriction binds this agent and
 * person. It never binds an owner-level person or the agent's own owner.
 */
export const restrictedSql = (org: string, agentId: string, personId: string) =>
  `(EXISTS (SELECT 1 FROM kin_reach_limits rl WHERE rl.org_id = ${org}
      AND rl.one_kind = 'agent' AND rl.one_id = ${agentId}
      AND rl.other_kind = 'person' AND rl.other_id = ${personId} AND rl.lifted_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM kin_people rp WHERE rp.org_id = ${org}
      AND rp.person_id = ${personId} AND ${accessSql("rp")} IN ('owner', 'co_owner'))
    AND NOT EXISTS (SELECT 1 FROM kin_agents ra WHERE ra.org_id = ${org}
      AND ra.agent_id = ${agentId} AND ra.owner_person_id = ${personId}))`;

type Standing =
  | { readonly _tag: "unknown" }
  | {
      readonly _tag: "live" | "gone";
      readonly ownerLevel: boolean;
      readonly owner: string | null;
    };

/** Who a party is now: live, gone (removed or retired), or never of this org. */
const standing = Effect.fn("KinReach.standing")(function* (orgId: KinOrgId, party: KinParty) {
  const sql = yield* SqlClient.SqlClient;
  const [row] =
    party._tag === "person"
      ? yield* sql<{ live: number; ownerLevel: number; owner: null }>`SELECT
            p.removed_at IS NULL AS live,
            ${sql.literal(accessSql("p"))} IN ('owner', 'co_owner') AS "ownerLevel", NULL AS owner
          FROM kin_people p WHERE p.org_id = ${orgId} AND p.person_id = ${party.personId}`
      : yield* sql<{ live: number; ownerLevel: number; owner: string | null }>`SELECT
            a.retired_at IS NULL AS live, 0 AS "ownerLevel",
            a.owner_person_id AS owner
          FROM kin_agents a WHERE a.org_id = ${orgId} AND a.agent_id = ${party.agentId}`;
  const found: Standing =
    row === undefined
      ? { _tag: "unknown" }
      : {
          _tag: row.live === 1 ? "live" : "gone",
          ownerLevel: row.ownerLevel === 1,
          owner: row.owner,
        };
  return found;
});

/** Why this pair may never be restricted, or undefined when it may. */
const exempt = (a: KinParty, b: KinParty, sa: Standing, sb: Standing) => {
  if ((sa._tag !== "unknown" && sa.ownerLevel) || (sb._tag !== "unknown" && sb.ownerLevel))
    return UNRESTRICTABLE;
  const owns = (p: KinParty, s: Standing) =>
    p._tag === "person" && s._tag !== "unknown" && s.owner === p.personId;
  return owns(a, sb) || owns(b, sa) ? OWN_AGENT : undefined;
};

const liveLimit = Effect.fn("KinReach.liveLimit")(function* (
  orgId: KinOrgId,
  a: KinParty,
  b: KinParty,
) {
  const sql = yield* SqlClient.SqlClient;
  const { one, other } = ordered(a, b);
  const rows = yield* sql`SELECT 1 FROM kin_reach_limits WHERE org_id = ${orgId}
      AND one_kind = ${one.kind} AND one_id = ${one.id} AND other_kind = ${other.kind}
      AND other_id = ${other.id} AND lifted_at IS NULL
    LIMIT 1`;
  return rows.length > 0;
});

/**
 * Whether `a` may message `b`, and so `b` may message `a`: both live in the org, not the same,
 * and no live restriction on the pair. Owner-level people and an agent's own owner are never
 * restricted. Read from stored rows only.
 */
export const mayReach = Effect.fn("KinReach.mayReach")(function* (
  orgId: KinOrgId,
  a: KinParty,
  b: KinParty,
) {
  const verdict = (reach: Reach) => reach;
  if (same(a, b)) return verdict("self");
  const sa = yield* standing(orgId, a);
  const sb = yield* standing(orgId, b);
  if (sa._tag === "unknown" || sb._tag === "unknown") return verdict("unknown");
  if (sa._tag === "gone" || sb._tag === "gone") return verdict("removed");
  if (exempt(a, b, sa, sb) !== undefined) return verdict("allowed");
  return verdict((yield* liveLimit(orgId, a, b)) ? "restricted" : "allowed");
});

export const reaches = (orgId: KinOrgId, a: KinParty, b: KinParty) =>
  mayReach(orgId, a, b).pipe(Effect.map((reach) => reach === "allowed"));

/**
 * The agent a notice to `personId` goes through: `agentId` when they may reach each other, else
 * the team agent when it may; null when neither may, so it stays on their own Tasks.
 */
export const carrierFor = Effect.fn("KinReach.carrierFor")(function* (
  orgId: KinOrgId,
  personId: KinPersonId,
  agentId: KinAgentId,
) {
  if (yield* reaches(orgId, person(personId), agent(agentId))) return agentId;
  const team = yield* teamAgent(orgId);
  return team !== null && (yield* reaches(orgId, person(personId), agent(team))) ? team : null;
});

export type LimitChange =
  | { readonly _tag: "changed" | "unchanged" }
  | {
      readonly _tag: "refused";
      readonly reason: "not_allowed" | "not_found";
      readonly message: string;
    };

/**
 * An owner-level person restricts or lifts a pair of a person and someone else, in the caller's
 * transaction. The setter and both parties are checked against the org's rows here; a repeat
 * changes nothing. Agents are all the owner's, so two agents are never a pair to restrict.
 */
export const setLimit = Effect.fn("KinReach.setLimit")(function* (input: {
  readonly orgId: KinOrgId;
  readonly by: KinPersonId;
  readonly a: KinParty;
  readonly b: KinParty;
  readonly restricted: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  const { orgId } = input;
  const result = (change: LimitChange) => change;
  const setter = yield* standing(orgId, person(input.by));
  if (setter._tag !== "live" || !setter.ownerLevel)
    return result({
      _tag: "refused",
      reason: "not_allowed",
      message: "Only the owner or a co-owner can restrict who messages whom.",
    });
  const sa = yield* standing(orgId, input.a);
  const sb = yield* standing(orgId, input.b);
  if (
    sa._tag === "unknown" ||
    sb._tag === "unknown" ||
    same(input.a, input.b) ||
    (input.a._tag === "agent" && input.b._tag === "agent")
  )
    return result({ _tag: "refused", reason: "not_found", message: "No such pair here." });
  const why = exempt(input.a, input.b, sa, sb);
  if (why !== undefined && input.restricted)
    return result({ _tag: "refused", reason: "not_allowed", message: why });
  const now = yield* Clock.currentTimeMillis;
  const { one, other } = ordered(input.a, input.b);
  if (!input.restricted) {
    const lifted = yield* sql`UPDATE kin_reach_limits
      SET lifted_at = ${now}, lifted_by_person_id = ${input.by}
      WHERE org_id = ${orgId} AND one_kind = ${one.kind} AND one_id = ${one.id}
        AND other_kind = ${other.kind} AND other_id = ${other.id} AND lifted_at IS NULL
      RETURNING limit_id`;
    return result({ _tag: lifted.length > 0 ? "changed" : "unchanged" });
  }
  // One row per restriction of the pair, numbered: lifted rows stay as its history.
  const [count] = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM kin_reach_limits
    WHERE org_id = ${orgId} AND one_kind = ${one.kind} AND one_id = ${one.id}
      AND other_kind = ${other.kind} AND other_id = ${other.id}`;
  const limitId = `reach-${NodeCrypto.createHash("sha256")
    .update(`${orgId}:${one.kind}:${one.id}:${other.kind}:${other.id}`)
    .digest("hex")
    .slice(0, 24)}-${(count?.n ?? 0) + 1}`;
  const set = yield* sql`INSERT INTO kin_reach_limits (limit_id, org_id, one_kind, one_id,
      other_kind, other_id, set_by_person_id, set_at)
    VALUES (${limitId}, ${orgId}, ${one.kind}, ${one.id}, ${other.kind}, ${other.id},
      ${input.by}, ${now})
    ON CONFLICT DO NOTHING RETURNING limit_id`;
  return result({ _tag: set.length > 0 ? "changed" : "unchanged" });
});

/** The org's live restrictions, oldest first, each pair as stored. */
export const liveLimits = Effect.fn("KinReach.liveLimits")(function* (orgId: KinOrgId) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    oneKind: "agent" | "person";
    oneId: string;
    otherKind: "agent" | "person";
    otherId: string;
    setBy: KinPersonId;
    setAt: number;
  }>`SELECT one_kind AS "oneKind", one_id AS "oneId", other_kind AS "otherKind",
      other_id AS "otherId", set_by_person_id AS "setBy", set_at AS "setAt"
    FROM kin_reach_limits WHERE org_id = ${orgId} AND lifted_at IS NULL
    ORDER BY set_at, limit_id`;
});
