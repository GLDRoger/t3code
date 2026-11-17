import { describe, expect, it } from "vite-plus/test";

import { kinDraftPrefill } from "./kinDraft.ts";

describe("kinDraftPrefill", () => {
  it.each([
    ["an empty box", "", "What is owed on INV-1?", "What is owed on INV-1?"],
    ["a box of spaces", "  \n", "What is owed on INV-1?", "What is owed on INV-1?"],
    [
      "a box with text typed",
      "and the logo files",
      "What is owed on INV-1?",
      "What is owed on INV-1?\n\nand the logo files",
    ],
    [
      "a box already holding the question",
      "What is owed on INV-1?\n\nand the logo files",
      "What is owed on INV-1?",
      "What is owed on INV-1?\n\nand the logo files",
    ],
  ])("into %s keeps what was typed", (_name, typed, prepared, expected) => {
    expect(kinDraftPrefill(typed, prepared)).toBe(expected);
  });
});
