import {
  KinChatError,
  kinRpcAccess,
  type KinAgentId,
  type KinChatId,
  type KinMailRule,
  type KinMailRuleHistory,
  type KinMailRulePreview,
  type KinOrgId,
  type KinPersonId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { kinPermission } from "./kinAccess.ts";
import {
  KIN_MAIL_RULES,
  KIN_MAIL_RULE_METHODS,
  kinMailRuleActions,
  kinMailRuleAscii,
  kinMailRuleBreaks,
  kinMailRuleHistoryRows,
  kinMailRuleMatchLine,
  kinMailRulePageView,
  kinMailRulePermissions,
  kinMailRulePreviewView,
  kinMailRuleRowView,
  kinMailRuleResumeSend,
  kinMailRuleRunNowAnswer,
  kinMailRulesRead,
  kinMailRuleState,
  kinMailRuleWhatShort,
} from "./kinMailRules.ts";

const ORG = "org_01JDCX7M4T3F9QZ8N2RVK6WB5H" as KinOrgId;
const FINANCE = "agt_01JDCX9P2W7R4KQ5M8T3V6YB1N" as KinAgentId;
const SALES = "agt_01JDCXA4N6B2C8D1E5F7G9H3JK" as KinAgentId;
const RHEA = "per_01JDCX5R8H2E3A9B7C4D6F1G0J" as KinPersonId;
const MAILBOX = "con_01JDCXB3M5N7P9Q2R4S6T8V0WX";
const RULE = "rule_9b1c4e7a2d5f8c3b6e9a1d4f7c2b5e8a3d6f9c1b4e7a2d5f8c3b6e9a1d4f7c2b";
const NOW = Date.UTC(2026, 10, 27, 12, 0);
const NOV_24_0942 = Date.UTC(2026, 10, 24, 9, 42);
const NOV_26_1042 = Date.UTC(2026, 10, 26, 10, 42);
const WORDS = { zone: "UTC", locale: "en-GB" } as const;
const LEADS = [
  { agentId: FINANCE, name: "Finance" },
  { agentId: SALES, name: "Sales", retired: true },
] as const;

const makeRule = (overrides: Partial<KinMailRule> = {}): KinMailRule => ({
  orgId: ORG,
  connectionId: MAILBOX,
  ruleId: RULE,
  match: {
    from: [{ domain: "junipercold.example" }],
    subjectHas: [],
    withFile: true,
    classes: null,
  },
  wordingChanged: false,
  what: "File the bill under Juniper Cold Chain and tell me the amount.",
  agentId: FINANCE,
  chatId: "chat_01JDCXC8D2E4F6G8H0J2K4M6N8" as KinChatId,
  saidBy: RHEA,
  setterName: "Rhea",
  state: "on",
  pausedWhy: null,
  monthlyCap: 30,
  month: "2026-11",
  fired: 12,
  atLimit: false,
  lastWakeAt: NOV_26_1042,
  createdAt: NOV_24_0942,
  updatedAt: NOV_24_0942,
  ...overrides,
});

describe("kinMailRuleAscii", () => {
  it("shows the punycode a look-alike domain becomes, and leaves an ASCII one as it is", () => {
    expect(kinMailRuleAscii("bücher.example")).toBe("xn--bcher-kva.example");
    // Cyrillic і in place of the Latin i.
    expect(kinMailRuleAscii("junіper.example")).toBe("xn--junper-rvf.example");
    expect(kinMailRuleAscii("例え.テスト")).toBe("xn--r8jz45g.xn--zckzah");
    expect(kinMailRuleAscii("JuniperCold.Example")).toBe("junipercold.example");
  });
});

describe("kinMailRuleMatchLine: what a rule matches, in plain words", () => {
  const line = (match: Partial<NonNullable<KinMailRule["match"]>>) =>
    kinMailRuleMatchLine({ from: [], subjectHas: [], withFile: null, classes: null, ...match });

  it.each([
    [
      { from: [{ domain: "junipercold.example" }], withFile: true },
      "From junipercold.example, with a file",
    ],
    [
      { from: [{ address: "orders@junipercold.example" }, { domain: "tidewater.example" }] },
      "From orders@junipercold.example or tidewater.example",
    ],
    [
      {
        from: [
          { address: "a@one.example" },
          { address: "b@two.example" },
          { domain: "three.example" },
        ],
      },
      "From a@one.example, b@two.example or three.example",
    ],
    [{ subjectHas: ["invoice", "bill"] }, "Subject has “invoice” or “bill”"],
    [{ from: [{ domain: "bücher.example" }] }, "From bücher.example (xn--bcher-kva.example)"],
    [
      { classes: ["automated_notice", "known_biller"] },
      "Only automated notices or mail from a sender whose bill was filed before",
    ],
    [{}, "Any mail to this mailbox"],
    [
      {
        from: [{ domain: "junipercold.example" }],
        subjectHas: ["invoice"],
        withFile: true,
        classes: ["client"],
      },
      "From junipercold.example, subject has “invoice”, with a file, only mail from a known contact",
    ],
  ] as const)("%j reads %s", (match, expected) => {
    expect(line(match)).toBe(expected);
  });

  it("says a rule whose words changed matches nothing it will act on", () => {
    expect(kinMailRuleMatchLine(null)).toBe(KIN_MAIL_RULES.changedTitle);
  });
});

describe("kinMailRuleState: the state → sentence table", () => {
  const state = (overrides: Partial<KinMailRule>) =>
    kinMailRuleState(makeRule(overrides), { leads: LEADS, words: WORDS });

  it.each([
    [{}, { label: "On", tone: "ok", detail: null, needsLead: false }],
    [
      { atLimit: true, fired: 30 },
      {
        label: "At its limit",
        tone: "attention",
        detail: "Held until 1 Dec: its monthly limit.",
        needsLead: false,
      },
    ],
    [
      { atLimit: true, fired: 30, month: "2026-12" },
      {
        label: "At its limit",
        tone: "attention",
        detail: "Held until 1 Jan: its monthly limit.",
        needsLead: false,
      },
    ],
    [
      { state: "paused", pausedWhy: "person" },
      {
        label: "Paused",
        tone: "quiet",
        detail: "Paused by the owner or a co-owner.",
        needsLead: false,
      },
    ],
    [
      { state: "paused", pausedWhy: "left", setterName: "Meera" },
      {
        label: "Paused",
        tone: "quiet",
        detail: "Paused because Meera left the team.",
        needsLead: false,
      },
    ],
    [
      { state: "paused", pausedWhy: "left", setterName: "" },
      {
        label: "Paused",
        tone: "quiet",
        detail: "Paused because the person who set it up left the team.",
        needsLead: false,
      },
    ],
    [
      { state: "paused", pausedWhy: "mailbox" },
      {
        label: "Paused",
        tone: "quiet",
        detail: "Paused because this mailbox was disconnected.",
        needsLead: false,
      },
    ],
    [
      { state: "paused", pausedWhy: "agent", agentId: SALES },
      {
        label: "Paused",
        tone: "quiet",
        detail: "Paused because Sales was retired. Choose a lead to resume it.",
        needsLead: true,
      },
    ],
    [
      { state: "paused", pausedWhy: "person", agentId: SALES },
      {
        label: "Paused",
        tone: "quiet",
        detail: "Paused by the owner or a co-owner.",
        needsLead: true,
      },
    ],
    [
      { wordingChanged: true, match: null },
      {
        label: "Won't run",
        tone: "error",
        detail:
          "This mail rule was changed outside Kin, so it won't run. Remove it and set it up again.",
        needsLead: false,
      },
    ],
    [
      { state: "proposed" },
      {
        label: "Not on yet",
        tone: "quiet",
        detail: "It waits for a tap on Turn on in chat.",
        needsLead: false,
      },
    ],
  ] as const)("%j", (overrides, expected) => {
    expect(state(overrides)).toEqual(expected);
  });
});

describe("kinMailRuleRowView: one line per rule under its mailbox", () => {
  it("says what it matches, which lead does what, this month's runs and the last run", () => {
    expect(kinMailRuleRowView(makeRule(), { leads: LEADS, now: NOW, words: WORDS })).toEqual({
      ruleId: RULE,
      title: "From junipercold.example, with a file",
      does: "Finance: File the bill under Juniper Cold Chain and tell me the amount.",
      counts: "12 of 30 this month · last ran 26 Nov, 10:42",
      state: { label: "On", tone: "ok", detail: null, needsLead: false },
    });
  });

  it("says a rule that never ran hasn't, and names a lead it can't find plainly", () => {
    const row = kinMailRuleRowView(
      makeRule({ lastWakeAt: null, fired: 0, agentId: "agt_gone" as KinAgentId }),
      { leads: LEADS, now: NOW, words: WORDS },
    );
    expect(row.counts).toBe("0 of 30 this month · hasn't run yet");
    expect(row.does.startsWith("A lead no longer here: ")).toBe(true);
  });

  it("shortens long words on the list at a word edge; the rule's page has them whole", () => {
    const what = `${"Check the bill against the purchase order and ".repeat(5)}tell me.`;
    const short = kinMailRuleWhatShort(what);
    expect(short.length).toBeLessThanOrEqual(141);
    expect(short.endsWith("…")).toBe(true);
    expect(what.startsWith(short.slice(0, -1))).toBe(true);
    expect(short.slice(0, -1).endsWith(" ")).toBe(false);
    expect(kinMailRuleWhatShort("File it.")).toBe("File it.");
  });
});

describe("kinMailRulePageView: one rule's page", () => {
  it("lays out the filters, the words whole, who set it and when, and the limit", () => {
    const view = kinMailRulePageView(
      makeRule({
        match: {
          from: [{ address: "orders@junipercold.example" }, { domain: "junіper.example" }],
          subjectHas: ["invoice"],
          withFile: null,
          classes: ["client", "automated_file"],
        },
      }),
      { leads: LEADS, mailbox: "billing@tidewater.example", now: NOW, words: WORDS },
    );
    expect(view.facts).toEqual([
      { label: "Mailbox", value: "billing@tidewater.example" },
      {
        label: "From",
        value: "orders@junipercold.example or junіper.example (xn--junper-rvf.example)",
      },
      { label: "Subject has", value: "“invoice”" },
      { label: "With a file", value: "Not needed" },
      {
        label: "Kinds of mail",
        value: "Mail from a known contact or automated mail with a file",
      },
      { label: "Lead", value: "Finance" },
      { label: "Set by", value: "Rhea" },
      { label: "Created", value: "24 Nov" },
      { label: "Monthly limit", value: "Runs at most 30 times a month · 12 this month" },
    ]);
    expect(view.what).toBe("File the bill under Juniper Cold Chain and tell me the amount.");
  });

  it("says any sender, subject or kind when a filter is left out", () => {
    const view = kinMailRulePageView(
      makeRule({ match: { from: [], subjectHas: [], withFile: true, classes: null } }),
      { leads: LEADS, mailbox: "billing@tidewater.example", now: NOW, words: WORDS },
    );
    expect(view.facts.slice(1, 5)).toEqual([
      { label: "From", value: "Anyone" },
      { label: "Subject has", value: "Any subject" },
      { label: "With a file", value: "Yes" },
      { label: "Kinds of mail", value: "Any kind" },
    ]);
  });

  it("shows no filters for a rule whose words changed, only that it won't run", () => {
    const view = kinMailRulePageView(makeRule({ wordingChanged: true, match: null }), {
      leads: LEADS,
      mailbox: "billing@tidewater.example",
      now: NOW,
      words: WORDS,
    });
    expect(view.facts.map((fact) => fact.label)).toEqual([
      "Mailbox",
      "Lead",
      "Set by",
      "Created",
      "Monthly limit",
    ]);
  });
});

describe("mail rule permissions: owner level sees and acts, a teammate sees nothing", () => {
  it("guards every RPC Settings calls at owner level, and calls no create", () => {
    for (const method of Object.values(KIN_MAIL_RULE_METHODS))
      expect(kinRpcAccess(method), method).toBe("owner_level");
    expect(Object.values(KIN_MAIL_RULE_METHODS)).not.toContain("kin.mailRules.create");
  });

  it.each([
    ["owner", "granted"],
    ["co_owner", "granted"],
    ["member", "refused"],
  ] as const)("%s's list permission is %s", (kind, expected) => {
    expect(
      kinPermission({
        sessionKnown: true,
        scopesGranted: true,
        kind,
        access: kinRpcAccess(KIN_MAIL_RULE_METHODS.list),
        failed: false,
      }),
    ).toBe(expected);
  });

  const all = {
    pause: true,
    resume: true,
    remove: true,
    history: true,
    preview: true,
    runNow: true,
  };
  it.each([
    [
      "granted",
      all,
      {
        visible: true,
        ready: true,
        pause: true,
        resume: true,
        remove: true,
        history: true,
        preview: true,
        runNow: true,
      },
    ],
    [
      "unknown",
      all,
      {
        visible: true,
        ready: false,
        pause: false,
        resume: false,
        remove: false,
        history: false,
        preview: false,
        runNow: false,
      },
    ],
    [
      "refused",
      all,
      {
        visible: false,
        ready: false,
        pause: false,
        resume: false,
        remove: false,
        history: false,
        preview: false,
        runNow: false,
      },
    ],
    [
      "granted",
      { ...all, remove: false, runNow: false },
      {
        visible: true,
        ready: true,
        pause: true,
        resume: true,
        remove: false,
        history: true,
        preview: true,
        runNow: false,
      },
    ],
  ] as const)("list %s with %j", (list, commands, expected) => {
    expect(kinMailRulePermissions({ list, ...commands })).toEqual(expected);
  });

  const granted = kinMailRulePermissions({ list: "granted", ...all });
  it.each([
    [
      {},
      {
        pause: true,
        resume: false,
        remove: true,
        open: true,
        runNow: true,
        preview: true,
        history: true,
      },
    ],
    [
      { state: "paused" as const, pausedWhy: "person" as const },
      {
        pause: false,
        resume: true,
        remove: true,
        open: true,
        runNow: true,
        preview: true,
        history: true,
      },
    ],
    [
      { atLimit: true },
      {
        pause: true,
        resume: false,
        remove: true,
        open: true,
        runNow: true,
        preview: true,
        history: true,
      },
    ],
    [
      { wordingChanged: true, match: null },
      {
        pause: true,
        resume: false,
        remove: true,
        open: true,
        runNow: false,
        preview: false,
        history: false,
      },
    ],
    [
      { wordingChanged: true, match: null, state: "paused" as const, pausedWhy: "person" as const },
      {
        pause: false,
        resume: false,
        remove: true,
        open: true,
        runNow: false,
        preview: false,
        history: false,
      },
    ],
  ])("a rule %j offers %j", (overrides, expected) => {
    expect(kinMailRuleActions(makeRule(overrides), granted)).toEqual(expected);
  });

  it("offers nothing on a rule while the viewer's level is not known", () => {
    const unknown = kinMailRulePermissions({ list: "unknown", ...all });
    expect(Object.values(kinMailRuleActions(makeRule(), unknown)).some(Boolean)).toBe(false);
  });
});

describe("kinMailRulesRead: loading, empty, error and an older server", () => {
  const rules = { rules: [makeRule()] };
  it.each([
    ["refused", AsyncResult.success(rules), { _tag: "absent" }],
    ["unknown", AsyncResult.initial(), { _tag: "loading" }],
    ["granted", AsyncResult.initial(), { _tag: "loading" }],
    ["granted", AsyncResult.success({ rules: [] }), { _tag: "empty" }],
    ["granted", AsyncResult.success(rules), { _tag: "ready", rules: rules.rules }],
    [
      "granted",
      AsyncResult.failure(Cause.die("Unknown request tag: kin.mailRules.list")),
      { _tag: "absent" },
    ],
    [
      "granted",
      AsyncResult.failure(Cause.die(new Error("Unknown request tag: kin.mailRules.list"))),
      { _tag: "absent" },
    ],
    [
      "granted",
      AsyncResult.failure(
        Cause.fail(
          new KinChatError({
            reason: "not_allowed",
            message: "Only the owner or a co-owner can manage mail rules.",
          }),
        ),
      ),
      { _tag: "absent" },
    ],
    [
      "granted",
      AsyncResult.failure(
        Cause.fail(
          new KinChatError({
            reason: "unavailable",
            message: "Kin couldn't load or save mail rules. Try again.",
          }),
        ),
      ),
      {
        _tag: "failed",
        text: "Couldn't load mail rules. Kin isn't answering right now. Try again in a moment.",
      },
    ],
    [
      "failed",
      AsyncResult.initial(),
      {
        _tag: "failed",
        text: "Couldn't load mail rules. Check your connection to the server and try again.",
      },
    ],
  ] as const)("list %s, read %j", (permission, result, expected) => {
    expect(kinMailRulesRead(permission, result as Parameters<typeof kinMailRulesRead>[1])).toEqual(
      expected,
    );
  });

  it("keeps the rules it has while a read again is waiting", () => {
    expect(kinMailRulesRead("granted", AsyncResult.success(rules, { waiting: true }))).toEqual({
      _tag: "ready",
      rules: rules.rules,
    });
  });
});

describe("kinMailRuleHistoryRows: what matched, when, and what happened", () => {
  type Entry = KinMailRuleHistory["entries"][number];
  const mail = (overrides: Partial<Extract<Entry, { kind: "mail" }>>): Entry => ({
    kind: "mail",
    arrivalId: "arr_01JDCXD5E7F9G1H3J5K7M9N1P3",
    fromAddress: "orders@junipercold.example",
    receivedAt: NOV_26_1042,
    noticedAt: NOV_26_1042 + 60_000,
    state: "woke",
    outcome: null,
    eventId: "evt_01JDCXE2F4G6H8J0K2M4N6P8Q0",
    wakeupId: null,
    settledAt: null,
    refs: null,
    ...overrides,
  });
  const row = (entry: Entry) => kinMailRuleHistoryRows([entry], { now: NOW, words: WORDS })[0];

  it.each([
    [{}, "Running", "ok"],
    [{ settledAt: NOV_26_1042 + 120_000 }, "Ran", "ok"],
    [{ outcome: "draft" as const }, "Drafted a reply; the card waits for you", "ok"],
    [
      { outcome: "task" as const, refs: { records: [{ list: "tasks", key: "W-3" }] } },
      "Made task W-3",
      "ok",
    ],
    [{ outcome: "task" as const }, "Made a task", "ok"],
    [
      { outcome: "filed" as const, refs: { records: [{ list: "expenses", key: "EXP-12" }] } },
      "Filed EXP-12",
      "ok",
    ],
    [{ outcome: "filed" as const, refs: { records: "not a list" } }, "Filed it", "ok"],
    [{ outcome: "nothing" as const }, "Nothing needed doing", "ok"],
    [{ state: "batched" as const }, "Joined a run with mail from the same 10 minutes", "ok"],
    [{ state: "held_cap" as const, eventId: null }, "Held: limit reached", "attention"],
    [
      { state: "held_unverified" as const, eventId: null },
      "Held: sender not verified",
      "attention",
    ],
    [{ state: "held_paused" as const, eventId: null }, "Held: paused", "attention"],
  ] as const)("%j says %s", (overrides, happened, tone) => {
    expect(row(mail(overrides))).toEqual({
      key: "arr_01JDCXD5E7F9G1H3J5K7M9N1P3",
      title: "orders@junipercold.example",
      detail: `26 Nov, 10:42 · ${happened}`,
      tone,
    });
  });

  it("names a sender it has no address for, and dates by when Kin noticed it if need be", () => {
    expect(row(mail({ fromAddress: null, receivedAt: null }))).toMatchObject({
      title: "Unknown sender",
      detail: "26 Nov, 10:43 · Running",
    });
  });

  it("shows a blind stretch so it isn't passed off as quiet", () => {
    expect(
      row({
        kind: "gap",
        arrivalId: "arr_gap01JDCXF",
        from: NOV_24_0942,
        to: NOV_26_1042,
      }),
    ).toEqual({
      key: "arr_gap01JDCXF",
      title: "Kin couldn't see mail between 24 Nov, 09:42 and 26 Nov, 10:42",
      detail: null,
      tone: "attention",
    });
  });
});

describe("kinMailRulePreviewView: which recent mail would have matched", () => {
  const preview = (overrides: Partial<KinMailRulePreview> = {}): KinMailRulePreview => ({
    matches: [
      {
        arrivalId: "arr_01JDCXG1",
        fromAddress: "orders@junipercold.example",
        receivedAt: NOV_26_1042,
        subject: "Invoice INV/26-27/004",
        state: "match",
      },
      {
        arrivalId: "arr_01JDCXG2",
        fromAddress: "orders@junipercold.example",
        receivedAt: NOV_24_0942,
        subject: null,
        state: "held_cap",
      },
      {
        arrivalId: "arr_01JDCXG3",
        fromAddress: null,
        receivedAt: null,
        subject: null,
        state: "held_unverified",
      },
    ],
    subjectCheckLimit: null,
    partial: false,
    ...overrides,
  });

  it("lists each match with what would have happened; nothing runs", () => {
    expect(kinMailRulePreviewView(preview(), { now: NOW, words: WORDS })).toEqual({
      rows: [
        {
          key: "arr_01JDCXG1",
          title: "orders@junipercold.example",
          detail: "26 Nov, 10:42 · Invoice INV/26-27/004 · Would have run",
          tone: "ok",
        },
        {
          key: "arr_01JDCXG2",
          title: "orders@junipercold.example",
          detail: "24 Nov, 09:42 · Would have waited: monthly limit",
          tone: "attention",
        },
        {
          key: "arr_01JDCXG3",
          title: "Unknown sender",
          detail: "Would have been held: sender not verified",
          tone: "attention",
        },
      ],
      empty: null,
      note: null,
    });
  });

  it.each([
    [{ subjectCheckLimit: 200 as const }, "Subject words checked on the latest 200."],
    [
      { subjectCheckLimit: 200 as const, partial: true },
      "Subject words checked on the latest 200, so older mail may be missing.",
    ],
  ])("says how far subject words were checked: %j", (overrides, note) => {
    expect(kinMailRulePreviewView(preview(overrides), { now: NOW, words: WORDS }).note).toBe(note);
  });

  it("says when nothing would have matched", () => {
    expect(kinMailRulePreviewView(preview({ matches: [] }), { now: NOW, words: WORDS })).toEqual({
      rows: [],
      empty: "No mail in the last 30 days would have matched.",
      note: null,
    });
  });
});

describe("kinMailRuleRunNowAnswer", () => {
  it("shows the host's own sentence for each answer, so a later answer just works", () => {
    expect(
      kinMailRuleRunNowAnswer({
        status: "not_yet",
        arrivalId: "arr_01JDCXG1",
        message: "Kin can't run mail rules yet. Nothing ran.",
      }),
    ).toEqual({ text: "Kin can't run mail rules yet. Nothing ran.", ran: false });
    expect(
      kinMailRuleRunNowAnswer({
        status: "no_match",
        message: "No mail in the last 30 days matches this rule.",
      }),
    ).toEqual({ text: "No mail in the last 30 days matches this rule.", ran: false });
    // An answer a later host adds, such as a queued run.
    expect(
      kinMailRuleRunNowAnswer({
        status: "queued",
        message: "Finance is on it; its reply comes in your chat.",
      } as never),
    ).toEqual({ text: "Finance is on it; its reply comes in your chat.", ran: true });
    expect(kinMailRuleRunNowAnswer({ status: "queued", message: " " } as never)).toEqual({
      text: KIN_MAIL_RULES.runNowDone,
      ran: true,
    });
  });
});

describe("kinMailRuleBreaks: addresses never cut, broken only after @ and .", () => {
  it.each([
    [
      "From orders@junipercold.example or tidewater.example",
      ["From orders@", "junipercold.", "example or tidewater.", "example"],
    ],
    ["Paused by the owner or a co-owner.", ["Paused by the owner or a co-owner."]],
    ["Filed it. Then tell me", ["Filed it. Then tell me"]],
  ])("%s", (text, parts) => {
    expect(kinMailRuleBreaks(text)).toEqual(parts);
    expect(kinMailRuleBreaks(text).join("")).toBe(text);
  });
});

describe("kinMailRuleResumeSend: the viewer's own chat with the lead, then Resume", () => {
  const CHAT = "chat_01JDCXH7J9K1M3N5P7Q9R1S3T5" as KinChatId;
  const paused = makeRule({ state: "paused", pausedWhy: "person" });

  it("opens the chat first, then resumes with a fresh tap that makes the viewer its setter", async () => {
    const calls: Array<unknown> = [];
    const outcome = await kinMailRuleResumeSend({
      rule: paused,
      agentId: FINANCE,
      newId: () => "tap_01JDCXJ2K4M6N8P0Q2R4S6T8V0",
      online: () => true,
      openChat: async (input) => {
        calls.push(["chat", input]);
        return AsyncResult.success({ chatId: CHAT });
      },
      resume: async (input) => {
        calls.push(["resume", input]);
        return AsyncResult.success(makeRule({ saidBy: RHEA }));
      },
    });
    expect(outcome).toEqual({ ok: true });
    expect(calls).toEqual([
      ["chat", { orgId: ORG, agentId: FINANCE }],
      [
        "resume",
        {
          orgId: ORG,
          ruleId: RULE,
          agentId: FINANCE,
          chatId: CHAT,
          tapId: "tap_01JDCXJ2K4M6N8P0Q2R4S6T8V0",
        },
      ],
    ]);
  });

  it("resumes nothing when the chat can't open, and says the host's reason", async () => {
    let resumed = false;
    const outcome = await kinMailRuleResumeSend({
      rule: paused,
      agentId: FINANCE,
      newId: () => "tap_x",
      online: () => true,
      openChat: async () =>
        AsyncResult.failure(
          Cause.fail(
            new KinChatError({
              reason: "invalid_state",
              message: "Choose an active lead and your direct chat with that lead.",
            }),
          ),
        ),
      resume: async () => {
        resumed = true;
        return AsyncResult.success(makeRule());
      },
    });
    expect(resumed).toBe(false);
    expect(outcome).toEqual({
      ok: false,
      problem: "Choose an active lead and your direct chat with that lead.",
    });
  });

  it("sends nothing while offline", async () => {
    let sent = false;
    const outcome = await kinMailRuleResumeSend({
      rule: paused,
      agentId: FINANCE,
      newId: () => "tap_x",
      online: () => false,
      openChat: async () => {
        sent = true;
        return AsyncResult.success({ chatId: CHAT });
      },
      resume: async () => AsyncResult.success(makeRule()),
    });
    expect(sent).toBe(false);
    expect(outcome).toEqual({ ok: false, problem: "You're offline. Try again when you're back." });
  });
});
