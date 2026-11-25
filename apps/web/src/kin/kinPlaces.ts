import { kinIsDealKey } from "@t3tools/client-runtime/kin/kinDeals";
import { kinInMoney } from "@t3tools/client-runtime/kin/kinMoney";
import type { KinClientsTab } from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  KinAgentId,
  KinBillBatchId,
  KinDocSectionId,
  KinListId,
  KinPersonId,
  KinRecordKey,
  KinWidgetId,
  type KinMessageLinkTarget,
  type KinSearchKind,
} from "@t3tools/contracts";
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

type KinRecordKind = Extract<KinMessageLinkTarget, { readonly _tag: "record" }>["kind"];

/**
 * The page and search that open a record, from a message link, a notice or a search hit alike.
 * A deal opens on Clients' Deals tab, whatever kind it came as.
 */
export function kinRecordPlace(to: { readonly kind: KinRecordKind; readonly key: KinRecordKey }) {
  if ((to.kind === "entry" || to.kind === "task") && kinIsDealKey(to.key))
    return { to: KIN_PLACE_PATH.clients, search: { tab: "deals" as const, task: to.key } };
  switch (to.kind) {
    case "client":
      return { to: KIN_PLACE_PATH.clients, search: { client: to.key } };
    case "project":
      return { to: KIN_PLACE_PATH.clients, search: { project: to.key } };
    case "doc":
      return { to: KIN_PLACE_PATH.docs, search: { doc: to.key } };
    case "entry":
      return { to: KIN_PLACE_PATH.money, search: { task: to.key } };
    case "task":
      return { to: KIN_PLACE_PATH.tasks, search: { task: to.key } };
  }
}

const SEARCH_HIT_RECORD: Record<Exclude<KinSearchKind, "memory">, KinRecordKind> = {
  work: "task",
  contacts: "task",
  clients: "client",
  projects: "project",
  docs: "doc",
  invoices: "entry",
  quotes: "entry",
  expenses: "entry",
  receipts: "entry",
};

/** Where a search hit opens, at the doc section found; null for memory, which opens in Settings. */
export function kinSearchHitPlace(hit: {
  readonly kind: KinSearchKind;
  readonly key: KinRecordKey;
  readonly section: { readonly id: string } | null;
  readonly clientKey: KinRecordKey | null;
}) {
  if (hit.kind === "memory") return null;
  // A contact has no page of its own: its client's opens.
  if (hit.kind === "contacts" && hit.clientKey !== null)
    return kinRecordPlace({ kind: "client", key: hit.clientKey });
  const place = kinRecordPlace({ kind: SEARCH_HIT_RECORD[hit.kind], key: hit.key });
  return place.to === KIN_PLACE_PATH.docs && hit.section !== null
    ? { ...place, search: { ...place.search, section: hit.section.id } }
    : place;
}

/**
 * Where a place's Search Work sends a hit: a deal to where it lives, unless that is the tab
 * searched from; null for the rest, which open over the place searched from.
 */
export function kinSearchDialogPlace(
  from: { readonly place: KinPlace; readonly tab: KinClientsTab },
  hit: Parameters<typeof kinSearchHitPlace>[0],
) {
  const home = kinSearchHitPlace(hit);
  if (home === null || !("tab" in home.search)) return null;
  return from.place === "clients" && from.tab === home.search.tab ? null : home;
}

/**
 * The record open beside a place's list: a client, project, list, the coming dates, the
 * subscriptions, bills added in bulk (one batch, or every batch for null), or a doc.
 */
export type KinRecordWhere =
  | { readonly party: KinRecordKey }
  | { readonly project: KinRecordKey }
  | { readonly list: KinListId }
  | { readonly dates: true }
  | { readonly subscriptions: true }
  | { readonly bills: KinBillBatchId | null }
  | KinDocWhere;

export interface KinPlaceSearch {
  /** The open task, shown over whatever else is open. */
  task?: KinRecordKey;
  list?: KinListId;
  client?: KinRecordKey;
  project?: KinRecordKey;
  dates?: true;
  subscriptions?: true;
  /** Bills added in bulk: one batch's list, or `true` for every batch. */
  bills?: KinBillBatchId | true;
  /** The open doc: the version read, the section arrived at, or the versions compared. */
  doc?: KinRecordKey;
  v?: number;
  /** The long draft card the doc was opened from (`KinDocWhere.card`). */
  card?: KinWidgetId;
  section?: string;
  changes?: number;
  from?: number;
  history?: true;
  /** A dialog open over the place, so Back closes it. */
  open?: KinPlaceDialog;
  /** The Clients place's Deals or Projects tab; its Clients tab is the place with no tab named. */
  tab?: "deals" | "projects";
  /** Tasks opens narrowed to what this person holds, as their page's "See all in Tasks" asks. */
  person?: KinPersonId;
}

/** `import` is Clients' Import a file, which opens in the place itself. */
export type KinPlaceDialog = "new" | "search" | "import";

/** An agent's page, open over whatever Kin page is under it. */
export interface KinAgentSearch {
  agent?: KinAgentId;
}

const isAgent = Schema.is(KinAgentId);
export const validateKinAgentSearch = (raw: Record<string, unknown>): KinAgentSearch =>
  isAgent(raw.agent) ? { agent: raw.agent } : {};

/** The address with an agent's page open over it; Settings closes as it opens. */
export const withKinAgentPage = <T extends object>(search: T, agent: KinAgentId) => {
  const { settings: _closed, ...rest } = search as T & { readonly settings?: unknown };
  return { ...rest, agent };
};

const isKey = Schema.is(KinRecordKey);
const isPerson = Schema.is(KinPersonId);
const isList = Schema.is(KinListId);
const isSection = Schema.is(KinDocSectionId);
const isCard = Schema.is(KinWidgetId);
const isBatch = Schema.is(KinBillBatchId);
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
    // `?bills` with no value is every batch, as `bills=true` is.
    ...(raw.bills === true || raw.bills === ""
      ? { bills: true }
      : isBatch(raw.bills)
        ? { bills: raw.bills }
        : {}),
    ...(isKey(raw.doc) ? { doc: raw.doc } : {}),
    ...(v === undefined ? {} : { v }),
    ...(isCard(raw.card) ? { card: raw.card } : {}),
    ...(isSection(raw.section) ? { section: raw.section } : {}),
    ...(changes === undefined ? {} : { changes }),
    ...(from === undefined ? {} : { from }),
    ...(raw.history === true ? { history: true } : {}),
    ...(raw.open === "new" || raw.open === "search" || raw.open === "import"
      ? { open: raw.open }
      : {}),
    ...(raw.tab === "projects" || raw.tab === "deals" ? { tab: raw.tab } : {}),
    ...(isPerson(raw.person) ? { person: raw.person } : {}),
  };
}

export function kinRecordOf(search: KinPlaceSearch): KinRecordWhere | null {
  if (search.doc !== undefined)
    return {
      doc: search.doc,
      ...(search.v === undefined ? {} : { version: search.v }),
      ...(search.card === undefined ? {} : { card: search.card }),
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
  // The router lays the raw search under the validated one: a value it dropped is still here.
  if (search.bills === true) return { bills: null };
  if (isBatch(search.bills)) return { bills: search.bills };
  return null;
}

export function kinSearchOf(record: KinRecordWhere | null): KinPlaceSearch {
  if (record === null) return {};
  if ("party" in record) return { [CLIENT]: record.party };
  if ("project" in record) return { project: record.project };
  if ("list" in record) return { list: record.list };
  if ("dates" in record) return { dates: true };
  if ("subscriptions" in record) return { subscriptions: true };
  if ("bills" in record) return { bills: record.bills ?? true };
  return {
    doc: record.doc,
    ...(record.version === undefined ? {} : { v: record.version }),
    ...(record.card === undefined ? {} : { card: record.card }),
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

/** The address with a task open over what the place shows, or closed; nothing else changes. */
export function kinTaskAddress(place: KinPlace, search: KinPlaceSearch, task: KinRecordKey | null) {
  return {
    to: KIN_PLACE_PATH[place],
    search: {
      ...kinSearchOf(kinRecordOf(search)),
      ...(place === "clients" && search.tab !== undefined ? { tab: search.tab } : {}),
      ...(task === null ? {} : { task }),
    },
  };
}

/** The place a record lives in, for a link that names only the record. */
export function kinPlaceOfRecord(record: KinRecordWhere | null): KinPlace {
  if (record === null) return "tasks";
  if ("party" in record || "project" in record) return "clients";
  if ("dates" in record || "subscriptions" in record || "bills" in record) return "money";
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
  if (show === "projects") return { place: "clients", search: { ...kept, tab: "projects" } };
  const place: KinPlace =
    show === "clients"
      ? "clients"
      : show === "money"
        ? "money"
        : show === "docs" || show === "lists"
          ? "docs"
          : "tasks";
  return { place, search: kept };
}
