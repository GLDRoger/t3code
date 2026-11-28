import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { KinBillBatchCard, KinBillRow, KinBillsKeepReadInput } from "./kinBills.ts";

const encode = Schema.encodeSync(KinBillRow);
const decode = Schema.decodeUnknownSync(KinBillRow);

it("round-trips both the original-only bill row and one with a preview", () => {
  const old = {
    sha256: "a".repeat(64),
    batchId: "b-000000000000000000000000",
    file: {
      attachmentId: "kin-chat-original",
      name: "bill.png",
      mimeType: "image/png",
      chatId: "rhea-finance",
      messageId: "bill",
    },
    state: "reading",
    read: {},
    addedAt: "2026-11-27T12:00:00.000Z",
  };
  const updated = {
    ...old,
    preview: { ...old.file, attachmentId: "kin-chat-preview-jpg", mimeType: "image/jpeg" },
  };
  expect(encode(decode(old))).toEqual(old);
  expect(encode(decode(updated))).toEqual(updated);
});

it("keeps old cards and keep calls decodable and round-trips the guarded card data", () => {
  const legacy = {
    text: "Reading 1 bill: 0 done.",
    batchId: "b-123",
    status: "reading",
    total: 1,
    done: 0,
    counts: { read: 0, duplicate: 0, unreadable: 0, already: 0 },
    addedBy: "rhea",
  };
  const decodeCard = Schema.decodeUnknownSync(KinBillBatchCard);
  const keep = Schema.decodeUnknownSync(KinBillsKeepReadInput);
  const keepable = { count: 1, revision: "1234567890abcdef12345678" };
  const card = {
    ...legacy,
    totals: [
      { currency: "JPY", categories: [{ category: "No category", amount: "9007199254740993" }] },
    ],
    needs: [{ name: "Photo 2", reason: "no date printed." }],
    needsMore: 0,
    keepable,
  };
  const input = { orgId: "tidewater", batchId: legacy.batchId, clientRequestId: "keep-1" };
  expect(decodeCard(legacy)).toEqual(legacy);
  expect(decodeCard(card)).toEqual(card);
  expect(keep(input)).toEqual(input);
  expect(keep({ ...input, expect: keepable })).toEqual({ ...input, expect: keepable });
});
