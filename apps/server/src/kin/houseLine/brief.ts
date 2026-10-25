/**
 * Heir brief. Sections stay in a fixed order and every list is sorted, so two
 * builds from the same rows are the same bytes. No clocks or counters are added
 * here; the per-task text belongs after this brief.
 */

import { regnalLabel } from "./roman.ts";

const KIN_BRIEF_NOTE_LIMIT = 20;

export interface KinBriefWill {
  readonly willId: string;
  readonly crowningId: string;
  readonly houseName: string;
  readonly regnalNumber: number;
  readonly body: string;
}

export interface KinBriefNote {
  readonly id: string;
  readonly body: string;
  readonly at: string;
}

export interface KinBriefSource {
  readonly houseName: string;
  readonly agentMapPath: string | null;
  readonly family: ReadonlyArray<KinBriefWill>;
  readonly court: ReadonlyArray<KinBriefWill>;
  readonly houseWills: ReadonlyArray<KinBriefWill>;
  readonly notes: ReadonlyArray<KinBriefNote>;
}

export function assembleHouseLineBrief(source: KinBriefSource): string {
  const family = sortWills(source.family.filter((will) => will.houseName === source.houseName));
  const familyCrowns = new Set(family.map((will) => will.crowningId));
  const court = latestByHouse(
    source.court.filter((will) => will.houseName !== source.houseName),
  ).sort((left, right) => compareByte(left.houseName, right.houseName));
  const houseWills = sortWills(
    source.houseWills.filter((will) => !familyCrowns.has(will.crowningId)),
  );
  const notes = [...source.notes]
    .sort((left, right) => compareByte(right.at, left.at) || compareByte(left.id, right.id))
    .slice(0, KIN_BRIEF_NOTE_LIMIT);
  const readFirst = [
    ...family.map((will) => `will:${will.willId}`),
    ...notes.map((note) => `note:${note.id}`),
  ];

  const sections = [
    [
      "Start here",
      `Agent map: ${source.agentMapPath ?? "none"}`,
      "Read first:",
      block(readFirst),
    ].join("\n"),
    ["Your family", renderWills(family)].join("\n"),
    ["The court", renderCourt(court)].join("\n"),
    ["House wills and notes", "Wills:", renderWills(houseWills), "Notes:", renderNotes(notes)].join(
      "\n",
    ),
  ];
  return `${sections.join("\n\n")}\n`;
}

function renderWills(wills: ReadonlyArray<KinBriefWill>): string {
  if (wills.length === 0) return "(none)";
  return wills
    .map((will) => `${regnalLabel(will.houseName, will.regnalNumber)}\n${will.body}`)
    .join("\n\n");
}

function renderCourt(wills: ReadonlyArray<KinBriefWill>): string {
  if (wills.length === 0) return "(none)";
  return wills
    .map((will) => `${regnalLabel(will.houseName, will.regnalNumber)}\n${will.body}`)
    .join("\n\n");
}

function renderNotes(notes: ReadonlyArray<KinBriefNote>): string {
  if (notes.length === 0) return "(none)";
  return notes.map((note) => `note:${note.id}\n${note.body}`).join("\n\n");
}

function sortWills(wills: ReadonlyArray<KinBriefWill>): Array<KinBriefWill> {
  return [...wills].sort(
    (left, right) =>
      right.regnalNumber - left.regnalNumber || compareByte(left.crowningId, right.crowningId),
  );
}

function latestByHouse(wills: ReadonlyArray<KinBriefWill>): Array<KinBriefWill> {
  const byHouse = new Map<string, KinBriefWill>();
  for (const will of wills) {
    const current = byHouse.get(will.houseName);
    if (
      current === undefined ||
      will.regnalNumber > current.regnalNumber ||
      (will.regnalNumber === current.regnalNumber && will.crowningId < current.crowningId)
    ) {
      byHouse.set(will.houseName, will);
    }
  }
  return [...byHouse.values()];
}

function block(lines: ReadonlyArray<string>): string {
  return lines.length === 0 ? "(none)" : lines.join("\n");
}

function compareByte(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
