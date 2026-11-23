import type { KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

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

export const billedParty = (
  entry: { readonly registerId: string; readonly fieldsJson: string } | undefined,
  client: { readonly title: string; readonly fieldsJson?: string } | undefined,
) => {
  if (client !== undefined) {
    const fields = parseFields(client.fieldsJson ?? "{}");
    return {
      name: client.title,
      address: fieldText(fields, "address"),
      taxNumber: fieldText(fields, "gstin"),
      place: fieldText(fields, "placeOfSupply"),
      email: fieldText(fields, "email"),
      fromClient: true,
    };
  }
  if (entry === undefined || !hasBillTo(entry.registerId)) return undefined;
  const fields = parseFields(entry.fieldsJson);
  const name = text(fields, "billToName");
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

export const billToRefusal = (
  key: string | undefined,
  client: { readonly title: string } | undefined,
  patch: Fields,
  fields: Fields,
  linkingClient: boolean,
) => {
  const name = text(fields, "billToName");
  if (client !== undefined) {
    if (["billToName", ...detailKeys].some((field) => text(patch, field) !== null))
      return `${key ?? "This"} is for ${client.title}: its billing details come from that client. Nothing changed.`;
    if (linkingClient && name !== null)
      return `${key} bills ${name} by name. Clear that name first to give it a client. Nothing changed.`;
  } else if (
    name === null &&
    ["billToAddress", ...detailKeys].some((field) => text(fields, field) !== null)
  ) {
    return "Give the name to bill first (billToName). Nothing changed.";
  }
  return undefined;
};

export const billingClientId = Effect.fn("KinBillTo.clientId")(function* (
  orgId: KinOrgId,
  entry: { readonly partyId: string | null; readonly projectId: string | null },
) {
  if (entry.partyId !== null || entry.projectId === null) return entry.partyId;
  const sql = yield* SqlClient.SqlClient;
  const [project] = yield* sql<{ partyId: string | null }>`SELECT party_id AS "partyId"
    FROM kin_records WHERE org_id = ${orgId} AND record_id = ${entry.projectId}`;
  return project?.partyId ?? null;
});
