import { KIN_CONTACT_DETAILS_MAX, KinChatError } from "@t3tools/contracts";

import { fieldList, fieldText, type FieldValue, type FieldValues } from "./lists.ts";

/**
 * A contact's emails and phones. `email` and `phone` stay the main one, read everywhere as
 * before; `emails` and `phones` hold every one in order, main first, only when there are two or
 * more, so a contact with one of each is stored as it always was.
 */
const KINDS = [
  { one: "email", all: "emails", same: (text: string) => text.toLowerCase(), noun: "emails" },
  { one: "phone", all: "phones", same: (text: string) => text, noun: "phone numbers" },
] as const;

const cleaned = (list: ReadonlyArray<unknown>, same: (text: string) => string) => {
  const seen = new Set<string>();
  return list.flatMap((item) => {
    const text = typeof item === "string" ? item.trim() : "";
    if (text === "" || seen.has(same(text))) return [];
    seen.add(same(text));
    return [text];
  });
};

/** Every email or phone stored on a contact, main first. */
export const contactAll = (fields: FieldValues, kind: "email" | "phone"): ReadonlyArray<string> => {
  const all = fieldList(fields, `${kind}s`);
  if (all.length > 0) return all;
  const one = fieldText(fields, kind);
  return one === null ? [] : [one];
};

/**
 * The contact fields to write, from what is stored and what was given: a list wins over the
 * single field, a single one replaces the main one, and clearing it makes the next one main.
 */
export const contactFields = (
  stored: FieldValues,
  given: Readonly<Record<string, FieldValue | null>>,
): Readonly<Record<string, FieldValue | null>> | KinChatError => {
  let out: Record<string, FieldValue | null> = { ...given };
  for (const kind of KINDS) {
    const list = given[kind.all];
    const one = given[kind.one];
    if (list === undefined && one === undefined) continue;
    const before = contactAll(stored, kind.one);
    const wanted = Array.isArray(list)
      ? list
      : list === null
        ? typeof one === "string"
          ? [one]
          : []
        : one === null
          ? before.slice(1)
          : [one, ...before.slice(1)];
    const all = cleaned(wanted, kind.same);
    if (all.length > KIN_CONTACT_DETAILS_MAX)
      return new KinChatError({
        reason: "invalid_state",
        message: `A contact has at most ${KIN_CONTACT_DETAILS_MAX} ${kind.noun}.`,
      });
    out = { ...out, [kind.one]: all[0] ?? null, [kind.all]: all.length > 1 ? all : null };
  }
  return out;
};

/** The sensitive fields a contact has: `emails` and `phones` only where it holds several. */
export const contactSensitive = (keys: ReadonlyArray<string>, fields: FieldValues) =>
  keys.filter((key) => (key !== "emails" && key !== "phones") || fields[key] !== undefined);
