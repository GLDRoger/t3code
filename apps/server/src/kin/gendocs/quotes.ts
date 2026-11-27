import { KinChatError, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { billedParty, billingClientId } from "../work/billTo.ts";
import { KinRecords, type Writer } from "../work/KinRecords.ts";
import { amountOf, notFound, principal } from "../work/recordRows.ts";
import { entryInputs } from "./entryInputs.ts";

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });

/**
 * An invoice draft made from a quote: its client, project and title, and what the quote's latest
 * document was made with, so the invoice carries the same lines. Once per quote: asking again
 * finds the same draft.
 */
export const invoiceFromQuote = Effect.fn("KinQuotes.invoiceFrom")(function* (
  orgId: KinOrgId,
  writer: Writer,
  quoteKey: string,
) {
  const records = yield* KinRecords;
  const quote = yield* records.get(orgId, quoteKey);
  if (quote === undefined) return yield* notFound(quoteKey);
  if (quote.registerId !== "quotes")
    return yield* invalid(`${quote.key} isn't a quote. Nothing was made.`);
  if (quote.state === "dropped")
    return yield* invalid(`${quote.key} is void, so no invoice is made from it.`);
  const given = yield* entryInputs(orgId, quote.key);
  const owner = principal(quote.ownerKind, quote.ownerId);
  if (owner === null) return yield* invalid(`${quote.key} has no owner. Nothing was made.`);
  const amount = amountOf(quote);
  const partyId = billingClientId(quote);
  const billTo = partyId === null ? billedParty(quote, undefined) : undefined;
  const { row } = yield* records.create(orgId, writer, {
    list: "invoices",
    originKey: `quote:${quote.recordId}`,
    from: quote.recordId,
    title: quote.title,
    owner,
    state: "open",
    ...(partyId === null && billTo === undefined ? {} : { partyId }),
    ...(billTo === undefined
      ? {}
      : {
          fields: {
            billToName: billTo.name,
            billToAddress: billTo.address,
            billToTaxNumber: billTo.taxNumber,
            billToPlace: billTo.place,
            billToEmail: billTo.email,
          },
        }),
    ...(quote.projectId === null ? {} : { projectId: quote.projectId }),
    // Lines make the invoice's total; a quote with none bills its own amount.
    ...(Array.isArray(given.lines) || amount === undefined ? {} : { amount }),
    links: [{ kind: "record", target: quote.recordId, relation: "source", label: quote.key }],
  });
  // The quote names its invoice too, so it can say it was invoiced and open it.
  yield* records.link(orgId, writer, quote.recordId, {
    kind: "record",
    target: row.recordId,
    relation: "relates",
    label: row.key,
  });
  return { entry: row, given };
});
