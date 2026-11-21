import {
  KinChatError,
  type KinImportCheck,
  type KinImportFileInput,
  type KinImportUpload,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_IMPORT_NO_CHOICES,
  createKinImportFiles,
  kinImportBase64,
  kinImportChooseClient,
  kinImportChooseStage,
  kinImportDecisions,
  kinImportNeedsLook,
  kinImportReady,
} from "./kinImport.ts";

// Invented clients only.
const check: KinImportCheck = {
  batch: "fabc",
  rows: 4,
  columns: [],
  mapping: { columns: [] },
  asks: { currency: false, dateFormat: false, dateExamples: [] },
  checked: true,
  will: { prospects: 1, clients: 0, contacts: 0, deals: 1 },
  matched: 1,
  matches: [
    {
      source: "r2",
      name: "Invented Kestrel Freight Ltd",
      key: "C-1",
      existing: "Invented Kestrel Freight",
      by: "email",
      detail: "contact email lars@kestrel.example",
      decision: "same",
      kept: [],
    },
  ],
  decide: [
    {
      source: "r3",
      name: "Invented Lumen Grove (Oslo)",
      rows: 2,
      candidates: [{ key: "C-2", name: "Invented Lumen Grove" }],
      decision: null,
    },
  ],
  stages: [{ value: "Negotiation", rows: 3, decision: null }],
  companyStages: [{ id: "deciding", name: "Deciding" }],
  homeCurrency: "EUR",
  ownersUnknown: 4,
  leftOut: [],
  more: 0,
  notImported: [],
  ready: false,
};

describe("kinImport", () => {
  it("encodes a file's bytes as base64, padding included", () => {
    for (const text of ["", "a", "ab", "abc", "Invented Ambermill, Ørsta\n"]) {
      const bytes = new TextEncoder().encode(text);
      expect(kinImportBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    }
  });

  it("is ready only once every Decide row and unknown stage has a choice, keyed as the host keys them", () => {
    expect(kinImportNeedsLook(check)).toBe(9);
    expect(kinImportReady(check, KIN_IMPORT_NO_CHOICES)).toBe(false);
    const client = kinImportChooseClient(KIN_IMPORT_NO_CHOICES, "r3", "C-2");
    expect(kinImportReady(check, client)).toBe(false);
    const both = kinImportChooseStage(client, "Negotiation", "deciding");
    expect(kinImportReady(check, both)).toBe(true);
    expect(kinImportDecisions(both)).toEqual({
      clients: { r3: "C-2" },
      stages: { negotiation: "deciding" },
    });
    expect(kinImportReady({ ...check, asks: { ...check.asks, currency: true } }, both)).toBe(false);
  });

  it("sends a file once, names it after, and sends it again by itself when the host lost it", async () => {
    const upload: KinImportUpload = { id: "held-0001", hash: "a".repeat(64) };
    const file = { name: "old-crm.csv", data: kinImportBase64(new Uint8Array(2048)) };
    const sent: Array<"bytes" | "held"> = [];
    // A host that holds what it read, until it restarts; an older one never says it holds it.
    const host = { holds: true, has: false };
    const ask = async (input: KinImportFileInput) => {
      sent.push("data" in input ? "bytes" : "held");
      if ("data" in input) host.has = host.holds;
      else if (!host.has)
        return AsyncResult.failure<KinImportUpload | undefined, unknown>(
          Cause.fail(new KinChatError({ reason: "not_found", message: "Gone." })),
        );
      return AsyncResult.success<KinImportUpload | undefined, unknown>(
        host.holds ? upload : undefined,
      );
    };
    const send = createKinImportFiles();
    const check = () => send(file, ask, (held) => held);
    // First read, three mapping changes and the import: the bytes go once.
    for (let index = 0; index < 4; index += 1) await check();
    await send(file, ask, () => null);
    expect(sent).toEqual(["bytes", "held", "held", "held", "held"]);

    // The import let it go; a restart loses it too: either way it goes whole again, unseen.
    sent.length = 0;
    await check();
    await check();
    host.has = false;
    const again = await check();
    expect(AsyncResult.isSuccess(again)).toBe(true);
    expect(sent).toEqual(["bytes", "held", "held", "bytes"]);

    // Another file is sent whole; an older host gets the file every time.
    sent.length = 0;
    await send({ ...file, data: kinImportBase64(new Uint8Array(16)) }, ask, (held) => held);
    host.holds = false;
    await check();
    await check();
    expect(sent).toEqual(["bytes", "bytes", "bytes"]);
  });
});
