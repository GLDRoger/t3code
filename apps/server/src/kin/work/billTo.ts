import { KinChatError, KinGstin } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { fieldText, parseFields, type FieldValue } from "./lists.ts";

export const BILL_TO_FIELDS = {
  billToName: "Bill to",
  billToAddress: "Billing address",
  billToTaxNumber: "Their tax number",
  billToPlace: "Their place of supply",
  billToEmail: "Their email",
};

export const hasBillTo = (list: string) => list === "invoices" || list === "quotes";

type Fields = Readonly<Record<string, FieldValue | null>>;

const text = (fields: Fields, key: string) => {
  const value = fields[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
};

export const billToNameOf = (fields: Fields) => text(fields, "billToName");

export const billedParty = (
  entry: { readonly registerId: string; readonly fieldsJson: string } | undefined,
  client: { readonly title: string; readonly fieldsJson?: string } | undefined,
  projectClient?: { readonly title: string; readonly fieldsJson?: string },
) => {
  const fields =
    client === undefined && entry !== undefined && hasBillTo(entry.registerId)
      ? parseFields(entry.fieldsJson)
      : {};
  const name = billToNameOf(fields);
  const record = client ?? (name === null ? projectClient : undefined);
  if (record !== undefined) {
    const clientFields = parseFields(record.fieldsJson ?? "{}");
    return {
      name: record.title,
      address: fieldText(clientFields, "address"),
      taxNumber: fieldText(clientFields, "gstin"),
      place: fieldText(clientFields, "placeOfSupply"),
      email: fieldText(clientFields, "email"),
      fromClient: true,
    };
  }
  if (name === null) return undefined;
  return {
    name,
    address: text(fields, "billToAddress"),
    taxNumber: text(fields, "billToTaxNumber"),
    place: text(fields, "billToPlace"),
    email: text(fields, "billToEmail"),
    fromClient: false,
  };
};

export const billToAddress = (fields: Fields) => text(fields, "billToAddress");

const detailKeys = ["billToTaxNumber", "billToPlace", "billToEmail"] as const;
export const clearsBillTo = (patch: Fields) =>
  Object.hasOwn(patch, "billToName") && billToNameOf(patch) === null;

export const clearedBillTo = {
  billToName: null,
  billToAddress: null,
  billToTaxNumber: null,
  billToPlace: null,
  billToEmail: null,
};

const decodeGstin = Schema.decodeEffect(Schema.Struct({ gstin: KinGstin }));
const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

export const validateBillTo = Effect.fn("KinBillTo.validate")(function* (
  key: string | undefined,
  client: { readonly title: string } | undefined,
  patch: Fields,
  name: FieldValue | null | undefined,
  linkingClient: boolean,
) {
  const typedName = billToNameOf({ billToName: name ?? null });
  if (client !== undefined) {
    if (["billToName", ...detailKeys].some((field) => text(patch, field) !== null))
      return yield* invalid(
        `${key ?? "This"} is for ${client.title}: its billing details come from that client. Nothing changed.`,
      );
    if (linkingClient && typedName !== null)
      return yield* invalid(
        `${key} bills ${typedName} by name. Clear that name first to give it a client. Nothing changed.`,
      );
  } else if (
    typedName === null &&
    ["billToAddress", ...detailKeys].some((field) => text(patch, field) !== null)
  ) {
    return yield* invalid("Give the name to bill first (billToName). Nothing changed.");
  }
  const gstin = text(patch, "billToTaxNumber");
  if (gstin !== null)
    yield* decodeGstin({ gstin }).pipe(Effect.mapError((error) => invalid(error.message)));
});

export const billingClientId = (entry: { readonly partyId: string | null } | undefined) =>
  entry?.partyId ?? null;

// SQLite's default trim removes only ASCII spaces. Match the text check in billedParty.
const whitespace =
  " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";

export const billingClientFromProject = (
  sql: SqlClient.SqlClient,
  projectParty: Statement.Fragment,
) => sql`COALESCE(r.party_id, CASE
  WHEN r.register_id IN ('invoices', 'quotes')
    AND json_type(r.fields_json, '$.billToName') = 'text'
    AND trim(json_extract(r.fields_json, '$.billToName'), ${whitespace}) <> ''
  THEN NULL ELSE ${projectParty} END)`;
