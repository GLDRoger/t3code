import {
  KIN_SENSITIVE_FIELDS,
  KinChatError,
  type KinRecordState,
  type KinWorkListName,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The built-in lists and what each allows. Code depends on all five, so they are fixed here; the
 * lists people define later (slice 5) get the same shape from configuration.
 */

/** `docs` is Kin's own: its rows are docs, read and written through `docs.ts`. */
export type ListName = KinWorkListName | "docs";
type List = {
  readonly name: string;
  readonly prefix: string;
  readonly noun: string;
  readonly states: ReadonlyArray<KinRecordState>;
  readonly categories: ReadonlyArray<string>;
  /** Keys of `fields_json`; anything else is refused. */
  readonly fields: ReadonlyArray<string>;
};

export const LISTS: Record<ListName, List> = {
  work: {
    name: "Work",
    prefix: "W",
    noun: "entry",
    states: ["open", "doing", "waiting", "done", "dropped"],
    categories: ["task", "issue", "obligation"],
    fields: [],
  },
  clients: {
    name: "Clients",
    prefix: "C",
    noun: "client",
    states: ["open", "dropped"],
    categories: ["client", "vendor"],
    fields: ["terms"],
  },
  contacts: {
    name: "Contacts",
    prefix: "CT",
    noun: "contact",
    states: ["open", "dropped"],
    categories: [],
    fields: ["role", "email", "phone"],
  },
  projects: {
    name: "Projects",
    prefix: "P",
    noun: "project",
    states: ["open", "done", "dropped"],
    categories: [],
    fields: ["repos"],
  },
  docs: {
    name: "Docs",
    prefix: "D",
    noun: "doc",
    // Archived is dropped; a doc is never done.
    states: ["open", "dropped"],
    categories: [],
    fields: [],
  },
};

export const listOf = (registerId: string): ListName =>
  registerId in LISTS ? (registerId as ListName) : "work";
/** A list clients older than Docs know; callers keep docs out of what they return. */
export const workListOf = (registerId: string): KinWorkListName => {
  const list = listOf(registerId);
  return list === "docs" ? "work" : list;
};

/** Which of an entry's own fields are sensitive whatever its label says (design 4.9). */
export const sensitiveFields = (list: ListName): ReadonlyArray<string> =>
  list === "clients"
    ? KIN_SENSITIVE_FIELDS.clients
    : list === "contacts"
      ? KIN_SENSITIVE_FIELDS.contacts
      : [];

export type FieldValue = string | ReadonlyArray<string>;
export type FieldValues = Readonly<Record<string, FieldValue>>;
const FieldsJson = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Array(Schema.String)])),
);
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
  return Array.isArray(value) ? value : [];
};
/** How a field's value reads in the change log. */
export const shownField = (value: FieldValue | null | undefined) =>
  value === null || value === undefined
    ? null
    : typeof value === "string"
      ? value
      : value.join(", ");

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
      `A ${def.noun} is ${def.states.join(", ")}; ${input.state} is for Work entries.`,
    );
  if (
    input.category !== undefined &&
    input.category !== null &&
    !def.categories.includes(input.category)
  )
    return invalid(
      def.categories.length === 0
        ? `A ${def.noun} has no category.`
        : `A ${def.noun}'s kind is ${def.categories.join(" or ")}.`,
    );
  const extra = Object.keys(input.fields ?? {}).filter((key) => !def.fields.includes(key));
  if (extra.length > 0) return invalid(`A ${def.noun} has no ${extra.join(", ")}.`);
  return undefined;
};
