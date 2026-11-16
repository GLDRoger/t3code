import { kinInMoney } from "@t3tools/client-runtime/kin/kinMoney";
import { KinDocSectionId, KinListId, KinRecordKey } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { KinDocWhere } from "./KinDocPage";

/** Kin's work, each reached straight from the sidebar. There is no hub page above them. */
export type KinPlace = "tasks" | "money" | "clients" | "docs";

export const KIN_PLACE_PATH = {
  tasks: "/kin/$environmentId/$orgId/tasks",
  money: "/kin/$environmentId/$orgId/money",
  clients: "/kin/$environmentId/$orgId/clients",
  docs: "/kin/$environmentId/$orgId/docs",
} as const satisfies Record<KinPlace, string>;

/** The record open beside a place's list: a client, project, list, the coming dates, the subscriptions, or a doc. */
export type KinRecordWhere =
  | { readonly party: KinRecordKey }
  | { readonly project: KinRecordKey }
  | { readonly list: KinListId }
  | { readonly dates: true }
  | { readonly subscriptions: true }
  | KinDocWhere;

export interface KinPlaceSearch {
  /** The open task, shown over whatever else is open. */
  task?: KinRecordKey;
  list?: KinListId;
  client?: KinRecordKey;
  project?: KinRecordKey;
  dates?: true;
  subscriptions?: true;
  /** The open doc: the version read, the section arrived at, or the versions compared. */
  doc?: KinRecordKey;
  v?: number;
  section?: string;
  changes?: number;
  from?: number;
  history?: true;
  /** A dialog open over the place, so Back closes it. */
  open?: KinPlaceDialog;
}

export type KinPlaceDialog = "new" | "search";

const isKey = Schema.is(KinRecordKey);
const isList = Schema.is(KinListId);
const isSection = Schema.is(KinDocSectionId);
const versionOf = (raw: unknown) => {
  const version = Number(raw);
  return Number.isSafeInteger(version) && version > 0 ? version : undefined;
};
// The address says "client"; reading it by name keeps it apart from an RPC client in lint's eyes.
const CLIENT = "client";

export function validateKinPlaceSearch(raw: Record<string, unknown>): KinPlaceSearch {
  const v = versionOf(raw.v);
  const changes = versionOf(raw.changes);
  const from = versionOf(raw.from);
  return {
    ...(isKey(raw.task) ? { task: raw.task } : {}),
    ...(isList(raw.list) ? { list: raw.list } : {}),
    ...(isKey(raw[CLIENT]) ? { client: raw[CLIENT] } : {}),
    ...(isKey(raw.project) ? { project: raw.project } : {}),
    ...(raw.dates === true ? { dates: true } : {}),
    ...(raw.subscriptions === true ? { subscriptions: true } : {}),
    ...(isKey(raw.doc) ? { doc: raw.doc } : {}),
    ...(v === undefined ? {} : { v }),
    ...(isSection(raw.section) ? { section: raw.section } : {}),
    ...(changes === undefined ? {} : { changes }),
    ...(from === undefined ? {} : { from }),
    ...(raw.history === true ? { history: true } : {}),
    ...(raw.open === "new" || raw.open === "search" ? { open: raw.open } : {}),
  };
}

export function kinRecordOf(search: KinPlaceSearch): KinRecordWhere | null {
  if (search.doc !== undefined)
    return {
      doc: search.doc,
      ...(search.v === undefined ? {} : { version: search.v }),
      ...(search.section === undefined ? {} : { section: search.section }),
      ...(search.changes === undefined
        ? {}
        : {
            changes: {
              to: search.changes,
              ...(search.from === undefined ? {} : { from: search.from }),
            },
          }),
      ...(search.history === true ? { history: true } : {}),
    };
  if (search[CLIENT] !== undefined) return { party: search[CLIENT] };
  if (search.project !== undefined) return { project: search.project };
  if (search.list !== undefined) return { list: search.list };
  if (search.dates === true) return { dates: true };
  if (search.subscriptions === true) return { subscriptions: true };
  return null;
}

export function kinSearchOf(record: KinRecordWhere | null): KinPlaceSearch {
  if (record === null) return {};
  if ("party" in record) return { [CLIENT]: record.party };
  if ("project" in record) return { project: record.project };
  if ("list" in record) return { list: record.list };
  if ("dates" in record) return { dates: true };
  if ("subscriptions" in record) return { subscriptions: true };
  return {
    doc: record.doc,
    ...(record.version === undefined ? {} : { v: record.version }),
    ...(record.section === undefined ? {} : { section: record.section }),
    ...(record.changes === undefined
      ? {}
      : {
          changes: record.changes.to,
          ...(record.changes.from === undefined ? {} : { from: record.changes.from }),
        }),
    ...(record.history === true ? { history: true } : {}),
  };
}

/** The place a record lives in, for a link that names only the record. */
export function kinPlaceOfRecord(record: KinRecordWhere | null): KinPlace {
  if (record === null) return "tasks";
  if ("party" in record || "project" in record) return "clients";
  if ("dates" in record || "subscriptions" in record) return "money";
  if ("list" in record) return kinInMoney(record) ? "money" : "docs";
  return "docs";
}

/**
 * Where an old Work address lands: the place its open record lives in, else the place that took
 * over the part it showed (projects sit under clients, dates in money, lists among docs).
 */
export function kinPlaceOfWork(search: KinPlaceSearch & { readonly show?: unknown }): {
  readonly place: KinPlace;
  readonly search: KinPlaceSearch;
} {
  const { show, ...rest } = search;
  const kept =
    show === "dates" && kinRecordOf(rest) === null ? { ...rest, dates: true as const } : rest;
  const record = kinRecordOf(kept);
  if (record !== null) return { place: kinPlaceOfRecord(record), search: kept };
  const place: KinPlace =
    show === "projects" || show === "clients"
      ? "clients"
      : show === "money"
        ? "money"
        : show === "docs" || show === "lists"
          ? "docs"
          : "tasks";
  return { place, search: kept };
}
