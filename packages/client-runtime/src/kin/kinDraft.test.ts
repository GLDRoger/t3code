import { describe, expect, it } from "vite-plus/test";

import { kinAskDraft, kinDraftGoesWith, kinDraftKey, kinDraftPrefill } from "./kinDraft.ts";

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

describe("kinAskDraft", () => {
  const launch = { doc: "Launch plan" };
  const pricing = { doc: "Pricing" };
  it.each([
    // typed, the Ask's question and doc, text after, doc after
    ["a Tasks Ask after a Docs Ask left a doc", "", "Is T-4 late?", null, "Is T-4 late?", null],
    ["a Docs Ask after another Docs Ask", "", null, pricing, "", pricing],
    ["a Docs Ask over a Tasks Ask's text", "Is T-4 late?", null, launch, "Is T-4 late?", launch],
    [
      "typed text stays under the new question",
      "and the logo",
      "Is T-4 late?",
      null,
      "Is T-4 late?\n\nand the logo",
      null,
    ],
  ] as const)("%s", (_, typed, question, ref, text, after) => {
    expect(kinAskDraft(typed, { question, ref })).toEqual({ text, ref: after });
  });

  it.each([
    // typed, the line the last Ask readied, the new Ask's line, text after
    [
      "a new line replaces an untouched earlier one",
      "Here is the bank statement: ",
      "Here is the bank statement: ",
      "Add a subscription: ",
      "Add a subscription: ",
    ],
    [
      "words typed after the earlier line stay",
      "Here is the bank statement: March",
      "Here is the bank statement: ",
      "Add a subscription: ",
      "Add a subscription: \n\nHere is the bank statement: March",
    ],
    [
      "a box emptied since stays empty under the new line",
      "",
      "Log an expense: ",
      "Add a subscription: ",
      "Add a subscription: ",
    ],
  ] as const)("%s", (_, typed, readied, question, text) => {
    expect(kinAskDraft(typed, { question, ref: null, readied })).toEqual({ text, ref: null });
  });
});

describe("kinDraftGoesWith", () => {
  it.each([
    ["its own host's chat", kinDraftKey("env-a", "org-1", "chat-1"), "env-a", true],
    [
      "another host's chat, same org and chat ids",
      kinDraftKey("env-b", "org-1", "chat-1"),
      "env-a",
      false,
    ],
    ["a host whose id starts the same", kinDraftKey("env-ab", "org-1", "chat-1"), "env-a", false],
  ])("removing a host takes %s: %s", (_name, key, removed, goes) => {
    expect(kinDraftGoesWith(key, removed)).toBe(goes);
  });
});
