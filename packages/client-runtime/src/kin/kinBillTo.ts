import type { KinFieldValue, KinListDefinition, KinRecordKey } from "@t3tools/contracts";

/**
 * Who an invoice or quote with no client record bills: a name typed on the entry itself, in five
 * fields of its own, the same on web and phone. A client record, when there is one, wins.
 */

export const KIN_BILL_TO_NAME = "billToName";
const KIN_BILL_TO_KEYS = [
  KIN_BILL_TO_NAME,
  "billToAddress",
  "billToTaxNumber",
  "billToPlace",
  "billToEmail",
] as const;

export const kinIsBillToField = (key: string) =>
  (KIN_BILL_TO_KEYS as ReadonlyArray<string>).includes(key);

export const KIN_BILL_TO = {
  label: "Bill to",
  byName: "Bill someone else by name",
  pickClient: "Bill a client instead",
  useClient: "Use a client instead",
  name: "Bill to",
  namePlaceholder: "Their name",
  more: "More details",
  address: "Address",
  taxNumber: "Tax number",
  place: "Place",
  email: "Email",
  projectBills: (client: string) => `This project bills ${client}.`,
  noName: "Give the name to bill.",
} as const;

/** The typed name an entry bills, or null when it has none. */
export function kinBillToName(fields: Readonly<Record<string, KinFieldValue>> | undefined) {
  const value = fields?.[KIN_BILL_TO_NAME];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** Who an entry bills, as a person reads it: its client, else its typed name; null for neither. */
export const kinBilledName = (record: {
  readonly party?: { readonly title: string } | undefined;
  readonly fields?: Readonly<Record<string, KinFieldValue>> | undefined;
}) => record.party?.title ?? kinBillToName(record.fields);

/**
 * Whether this host takes a name to bill: it says so, or (a host from before it said) its invoices
 * or quotes list has the field. An older host has neither.
 */
export const kinBillToOffered = (read: {
  readonly lists: ReadonlyArray<Pick<KinListDefinition, "list" | "fields">>;
  readonly billToByName?: boolean | undefined;
}) =>
  read.billToByName === true ||
  read.lists.some(
    (def) =>
      (def.list === "invoices" || def.list === "quotes") &&
      def.fields.some((field) => field.key === KIN_BILL_TO_NAME),
  );

const CLEARED = {
  billToName: null,
  billToAddress: null,
  billToTaxNumber: null,
  billToPlace: null,
  billToEmail: null,
} as const;

/**
 * The fields an edit to one bill-to field sends. Clearing the name clears every detail with it, as
 * the host does, so the page shows it at once.
 */
export function kinBillToFieldPatch(
  key: string,
  value: KinFieldValue | null,
): Readonly<Record<string, KinFieldValue | null>> {
  const blank = value === null || (typeof value === "string" && value.trim() === "");
  if (key === KIN_BILL_TO_NAME && blank) return CLEARED;
  return { [key]: blank ? null : value };
}

/** "Use a client instead": the name and its details cleared and the client set, in one update. */
export const kinUseClientInstead = (party: KinRecordKey) => ({ party, fields: CLEARED });

/** An invoice or quote still a draft: open, with no number given yet. Its bill-to is edited in place. */
export const kinBillToEditable = (item: {
  readonly list?: string | undefined;
  readonly state: string;
  readonly fields?: Readonly<Record<string, KinFieldValue>> | undefined;
}) =>
  (item.list === "invoices" || item.list === "quotes") &&
  item.state === "open" &&
  (typeof item.fields?.number !== "string" || item.fields.number.trim() === "");
