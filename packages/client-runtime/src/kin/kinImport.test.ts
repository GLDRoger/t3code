import type { KinImportCheck } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  KIN_IMPORT_NO_CHOICES,
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
});
