import {
  type KinAgentId,
  KinRoleTags,
  type KinOrgId,
  type MemoryItemHead,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { characterForTurn, characters, colleagueLine } from "./characters.ts";
import { validZone } from "../triggers/quietHold.ts";
import { stillAway, storedWorkHours, workingAt } from "../triggers/quietHours.ts";
import { dayIn } from "../work/money.ts";
import { ownerZone } from "../work/recordRows.ts";
import { describeHours, loads } from "./peopleRead.ts";

const decodeTags = Schema.decodeUnknownOption(Schema.fromJsonString(KinRoleTags));
const ACCESS_WORDS: Record<string, string> = {
  owner: "owner",
  co_owner: "co-owner",
  member: "member",
};
const PEOPLE_CAP = 25;
const LISTED_CAP = 6;

const clip = (text: string, limit: number) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
};

/** Memory items the seat lists: open, valid decisions carrying one of these links. */
const linked = (items: ReadonlyArray<MemoryItemHead>, links: ReadonlyArray<string>) => {
  const wanted = new Set(links.map((link) => link.toLowerCase()));
  return items
    .filter(
      (item) =>
        item.kind === "decision" &&
        item.status === "open" &&
        item.invalid_at === null &&
        item.links.some((link) => wanted.has(link.toLowerCase())),
    )
    .toSorted((a, b) => b.recorded_at.localeCompare(a.recorded_at))
    .slice(0, LISTED_CAP);
};

export type Seat = {
  /** The agent's own character, as this turn may carry it; undefined when it has none. */
  readonly character: string | undefined;
  /** One line per other live agent. */
  readonly colleagues: ReadonlyArray<string>;
  /** The agent's own seat; owner-only turns alone. */
  readonly seat: ReadonlyArray<string>;
  /** One line per person in the company. */
  readonly team: ReadonlyArray<string>;
};

/**
 * Who this agent is and who it works with, compactly, for every turn. A turn others read gets the
 * character's voice without its examples (they may carry figures), and no loads, focus or seat.
 */
/** The day a stamp falls on in the company's zone; a bare day is already one. */
const companyDay = (stamp: string, zone: string) => {
  const at = /^\d{4}-\d{2}-\d{2}$/.test(stamp) ? Number.NaN : Date.parse(stamp);
  return Number.isFinite(at) ? dayIn(at, zone) : stamp.slice(0, 10);
};
/** The lead's own positions, each with the company's day it took it. */
export const positionsLine = (positions: ReadonlyArray<MemoryItemHead>, zone: string) =>
  `- Your positions: ${positions.map((item) => `${JSON.stringify(clip(item.title, 100))} (${companyDay(item.recorded_at, zone)})`).join("; ")}.`;

export const buildSeat = Effect.fn("KinLeadPrompt.seat")(function* (input: {
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly ownerOnly: boolean;
  readonly now: number;
  /** The memory the turn may read, owner-only turns alone. */
  readonly memory: ReadonlyArray<MemoryItemHead> | undefined;
}) {
  const { orgId, agentId, ownerOnly, now } = input;
  const sql = yield* SqlClient.SqlClient;
  const load = ownerOnly ? yield* loads(orgId, now) : undefined;
  const all = yield* characters(orgId);
  const own = all.find((one) => one.agentId === agentId);
  const character = own === undefined ? undefined : characterForTurn(own, ownerOnly);
  const colleagues = all
    .filter((one) => one.agentId !== agentId)
    .map((one) => {
      const held = load?.("agent", one.agentId);
      return `${colleagueLine(one.name, one.body)}${
        held === undefined
          ? ""
          : ` (${held.open} open${held.late > 0 ? `, ${held.late} late` : ""})`
      }`;
    });

  const people = yield* sql<{
    id: string;
    name: string;
    access: string | null;
    roleTags: string;
    timeZone: string | null;
    workHours: string | null;
    talk: string;
    away: string | null;
  }>`SELECT person_id AS id, display_name AS name, access, role_tags_json AS "roleTags",
      time_zone AS "timeZone", work_hours_json AS "workHours", talk_style AS talk,
      away_until AS away
    FROM kin_people p WHERE p.org_id = ${orgId} AND p.removed_at IS NULL
      AND EXISTS (SELECT 1 FROM kin_session_bindings b WHERE b.org_id = p.org_id
        AND b.person_id = p.person_id AND b.revoked_at IS NULL)
    ORDER BY CASE access WHEN 'owner' THEN 0 WHEN 'co_owner' THEN 1 ELSE 2 END, display_name
    LIMIT ${PEOPLE_CAP}`;
  // What each is on now: their newest task in progress that isn't private. Owner-only turns.
  const focus = ownerOnly
    ? new Map(
        (yield* sql<{ id: string; title: string }>`SELECT r.owner_id AS id, r.title
          FROM kin_records r WHERE r.org_id = ${orgId} AND r.register_id = 'work'
            AND r.owner_kind = 'person' AND r.state = 'doing' AND r.sensitive = 0
          ORDER BY r.updated_at ASC`).map((row) => [row.id, row.title]),
      )
    : new Map<string, string>();
  const led = ownerOnly
    ? yield* sql<{ id: string; title: string }>`SELECT owner_id AS id, title FROM kin_records
        WHERE org_id = ${orgId} AND register_id = 'projects' AND owner_kind = 'person'
          AND state NOT IN ('done', 'dropped') ORDER BY lower(title)`
    : [];
  const company = people.some((person) => person.away !== null) ? yield* ownerZone(orgId) : "UTC";
  const team = people.map((person) => {
    const away = stillAway(person.away, validZone(person.timeZone) ?? company, now);
    const tags = decodeTags(person.roleTags);
    const hours = storedWorkHours(person.workHours);
    const held = load?.("person", person.id);
    const leads = led.filter((row) => row.id === person.id).map((row) => row.title);
    const parts = [
      [
        ACCESS_WORDS[person.access ?? "member"] ?? "member",
        ...(tags._tag === "Some" ? tags.value : []),
        ...(leads.length === 0 ? [] : [`leads ${leads.slice(0, 2).join(", ")}`]),
      ].join(", "),
      away ? `away until ${person.away}` : undefined,
      hours === undefined
        ? undefined
        : `${describeHours(hours)}${person.timeZone === null ? "" : ` ${person.timeZone}`}${
            person.timeZone === null || away
              ? ""
              : workingAt(hours, person.timeZone, now)
                ? ", working now"
                : ", off now"
          }`,
      held === undefined
        ? undefined
        : `${held.open} open${held.late > 0 ? `, ${held.late} late` : ""}${held.overloaded ? ", overloaded" : ""}`,
      focus.has(person.id)
        ? `on ${JSON.stringify(clip(focus.get(person.id) ?? "", 60))}`
        : undefined,
      person.talk.trim() === "" ? undefined : `talk: ${JSON.stringify(clip(person.talk, 120))}`,
    ].filter((part) => part !== undefined && part !== "");
    return `- ${JSON.stringify(clip(person.name, 80))}: ${parts.join("; ")}`;
  });

  const self = all.find((one) => one.agentId === agentId)?.name ?? "";
  const seat: Array<string> = [];
  if (ownerOnly) {
    const held = load?.("agent", agentId);
    if (held !== undefined)
      seat.push(
        `- You hold ${held.open} open${held.late > 0 ? `, ${held.late} late` : ""}${held.dueThisWeek > 0 ? `, ${held.dueThisWeek} due this week` : ""}.`,
      );
    const memory = input.memory ?? [];
    const permissions = linked(memory, [`permission:${self}`, "permission:all"]);
    if (permissions.length > 0)
      seat.push(
        `- Standing permissions from the owner: ${permissions.map((item) => JSON.stringify(clip(item.title, 100))).join("; ")}.`,
      );
    const positions = linked(memory, [`position:${self}`]);
    if (positions.length > 0) seat.push(positionsLine(positions, yield* ownerZone(orgId)));
  }
  return { character, colleagues, seat, team } satisfies Seat;
});
