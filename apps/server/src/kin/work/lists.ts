import {
  KIN_DOC_KINDS,
  KIN_LISTS_NEVER_TEAM,
  KIN_SENSITIVE_FIELDS,
  KinChatError,
  KinFieldValue,
  type KinMoney,
  type KinRecordState,
  type KinWorkListName,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { withArticle } from "../article.ts";
import { formatMoney } from "./money.ts";

/**
 * The built-in lists and what each allows. Code depends on each, so they are fixed here; the
 * lists people define later (slice 5) get the same shape from configuration.
 */

/**
 * `docs` is Kin's own: its rows are docs, read and written through `docs.ts`. `deals` are written
 * only through `deals.ts`.
 */
export type ListName = KinWorkListName | "docs" | "deals";
type List = {
  readonly name: string;
  readonly prefix: string;
  readonly noun: string;
  readonly states: ReadonlyArray<KinRecordState>;
  readonly categories: ReadonlyArray<string>;
  /** Keys of `fields_json`; anything else is refused. */
  readonly fields: ReadonlyArray<string>;
};

export const WATCHED_NUMBER_FIELDS: ReadonlyArray<string> = [
  "direction",
  "above",
  "below",
  "every",
  "spec",
  "source",
];

export const LISTS: Record<ListName, List> = {
  work: {
    name: "Work",
    prefix: "W",
    noun: "entry",
    states: ["open", "doing", "waiting", "done", "dropped"],
    categories: ["task", "issue", "obligation", "meeting"],
    // The project spine: a milestone's key, S/M/L, why its holder was picked, the doc section it
    // came from with that section's hash then, a meeting's people and place, the holder not
    // told yet that it is theirs, who is on it besides its holder (`person:<id>`, `agent:<id>`),
    // and where a promise was made (`promises.ts`).
    fields: [
      "milestone",
      "size",
      "reason",
      "untold",
      "fromDoc",
      "fromSection",
      "fromHash",
      "attendees",
      "where",
      "from",
      "alsoOn",
    ],
  },
  clients: {
    name: "Clients",
    prefix: "C",
    noun: "client",
    states: ["open", "dropped"],
    // A prospect is a client we haven't sold to yet; the wire calls it a client (`prospect`).
    categories: ["client", "vendor", "prospect"],
    // Tax ids are configuration for invoices; computing tax is not Kin's. `source` is where it
    // came from and `tags` the company's own words for it.
    fields: ["terms", "address", "gstin", "placeOfSupply", "source", "tags"],
  },
  contacts: {
    name: "Contacts",
    prefix: "CT",
    noun: "contact",
    states: ["open", "dropped"],
    categories: [],
    // `emails` and `phones` hold every one, main first, only beside a second (`contactDetails.ts`).
    fields: ["role", "email", "phone", "emails", "phones", "tags"],
  },
  projects: {
    name: "Projects",
    prefix: "P",
    noun: "project",
    states: ["open", "done", "dropped"],
    // None is an ordinary project; a campaign's `audience` is a tag (`tags.ts`).
    categories: ["campaign"],
    // `members` holds `person:<id>` and `agent:<id>`; days are `YYYY-MM-DD`; `noticeDays` a whole
    // number as text.
    fields: [
      "repos",
      "billing",
      "value",
      "startsOn",
      "renewsOn",
      "noticeDays",
      "members",
      "audience",
    ],
  },
  milestones: {
    name: "Milestones",
    prefix: "M",
    noun: "milestone",
    states: ["open", "done", "dropped"],
    categories: [],
    fields: [],
  },
  // The company's own goals: `measure` is a `KinGoalMeasure`, `target` money or a count as text,
  // `current` a manual goal's number, `startsOn` a day; due is the target date (`goals.ts`).
  goals: {
    name: "Goals",
    prefix: "G",
    noun: "goal",
    states: ["open", "done", "dropped"],
    categories: [],
    fields: ["measure", "target", "current", "unit", "startsOn", ...WATCHED_NUMBER_FIELDS],
  },
  // What we hope to win from a client or prospect: done is won, dropped is lost. `stage` is a stage
  // id of the company's own (`deals.ts`), `value` a `KinMoney` in any currency.
  deals: {
    name: "Deals",
    prefix: "DL",
    noun: "deal",
    states: ["open", "done", "dropped"],
    categories: [],
    fields: ["stage", "value", "source", "lostReason", "concerns"],
  },
  docs: {
    name: "Docs",
    prefix: "D",
    noun: "doc",
    // Archived is dropped; a doc is never done. Its category is its kind.
    states: ["open", "dropped"],
    categories: KIN_DOC_KINDS,
    // `home: "company"` files it as the company's own rather than a client's.
    fields: ["home"],
  },
};
export const TEAM_LIST_RESERVED = [...Object.keys(LISTS), ...KIN_LISTS_NEVER_TEAM];

export const listOf = (registerId: string): ListName =>
  registerId in LISTS ? (registerId as ListName) : "work";
/** A list clients older than Docs and Deals know; callers keep docs out of what they return. */
export const workListOf = (registerId: string): KinWorkListName => {
  const list = listOf(registerId);
  return list === "docs" || list === "deals" ? "work" : list;
};
/** The true list, for a client that knows lists newer than `workListOf` reads them as. */
export const listNameOf = (registerId: string) =>
  registerId === "deals" ? { listName: "deals" as const } : {};

/** Which of an entry's own fields are sensitive whatever its label says (design 4.9). */
export const sensitiveFields = (list: ListName): ReadonlyArray<string> =>
  list === "clients"
    ? KIN_SENSITIVE_FIELDS.clients
    : list === "contacts"
      ? KIN_SENSITIVE_FIELDS.contacts
      : list === "projects"
        ? KIN_SENSITIVE_FIELDS.projects
        : [];

export type FieldValue = KinFieldValue;
export type FieldValues = Readonly<Record<string, FieldValue>>;
const FieldsJson = Schema.fromJsonString(Schema.Record(Schema.String, KinFieldValue));
const decodeFields = Schema.decodeUnknownOption(FieldsJson);
export const encodeFieldValues = Schema.encodeEffect(FieldsJson);
export const parseFields = (json: string): FieldValues =>
  Option.getOrElse(decodeFields(json), () => ({}));
export const fieldText = (fields: FieldValues, key: string) => {
  const value = fields[key];
  return typeof value === "string" ? value : null;
};
export const fieldList = (fields: FieldValues, key: string): ReadonlyArray<string> => {
  const value = fields[key];
  return Array.isArray(value) ? (value as ReadonlyArray<string>) : [];
};
/** How a field's value reads in the change log. */
export const shownField = (value: FieldValue | null | undefined) =>
  value === null || value === undefined
    ? null
    : typeof value === "string"
      ? value
      : isMoney(value)
        ? formatMoney(value)
        : value.join(", ");
export const isMoney = (value: FieldValue): value is KinMoney =>
  typeof value === "object" && "currency" in value;

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

/** Refuses a state, category or field the list does not have. */
export const checkFor = (
  list: ListName,
  input: {
    readonly state?: KinRecordState | undefined;
    readonly category?: string | null | undefined;
    readonly fields?: Readonly<Record<string, FieldValue | null>> | undefined;
  },
) => {
  const def = LISTS[list];
  if (input.state !== undefined && !def.states.includes(input.state))
    return invalid(
      `${withArticle(def.noun, "A")} is ${def.states.join(", ")}; ${input.state} is for Work entries.`,
    );
  if (
    input.category !== undefined &&
    input.category !== null &&
    !def.categories.includes(input.category)
  )
    return invalid(
      def.categories.length === 0
        ? `${withArticle(def.noun, "A")} has no category.`
        : `${withArticle(def.noun, "A")}'s kind is ${def.categories.join(" or ")}.`,
    );
  const extra = Object.keys(input.fields ?? {}).filter((key) => !def.fields.includes(key));
  if (extra.length > 0) return invalid(`${withArticle(def.noun, "A")} has no ${extra.join(", ")}.`);
  return undefined;
};
