import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { KinBillRow } from "./kinBills.ts";

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
