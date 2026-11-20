import { KinChatError, type KinOrgId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KinRecords, type Writer } from "../work/KinRecords.ts";
import { amountOf, notFound, principal } from "../work/recordRows.ts";

const invalid = (message: string) => new KinChatError({ reason: "invalid_state", message });
const decodeGiven = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** What the quote's latest document was made with; `{}` when it has none. */
export const quotedInputs = Effect.fn("KinQuotes.inputs")(function* (
  orgId: KinOrgId,
  quoteKey: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const quote = yield* (yield* KinRecords).get(orgId, quoteKey);
  if (quote === undefined) return yield* notFound(quoteKey);
  const [job] = yield* sql<{ givenJson: string }>`SELECT given_json AS "givenJson"
    FROM kin_doc_jobs
    WHERE org_id = ${orgId} AND entry_record_id = ${quote.recordId} AND recipe IS NOT NULL
      AND given_json IS NOT NULL AND outcome_json IS NOT NULL
    ORDER BY created_at DESC, worker_id DESC LIMIT 1`;
  const decoded = job === undefined ? undefined : decodeGiven(job.givenJson);
  return decoded?._tag === "Some" ? decoded.value : {};
});

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
  const given = yield* quotedInputs(orgId, quote.key);
  const owner = principal(quote.ownerKind, quote.ownerId);
  if (owner === null) return yield* invalid(`${quote.key} has no owner. Nothing was made.`);
  const amount = amountOf(quote);
  const { row } = yield* records.create(orgId, writer, {
    list: "invoices",
    originKey: `quote:${quote.recordId}`,
    from: quote.recordId,
    title: quote.title,
    owner,
    state: "open",
    ...(quote.partyId === null ? {} : { partyId: quote.partyId }),
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
