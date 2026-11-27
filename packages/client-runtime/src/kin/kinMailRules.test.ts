import {
  KinChatError,
  kinMailRuleAscii,
  kinMailRuleMatchLine,
  kinRpcAccess,
  type KinAgentId,
  type KinChatId,
  type KinMailRule,
  type KinMailRuleCardState,
  type KinMailRuleHistory,
  type KinMailRulePreview,
  type KinOrgId,
  type KinPersonId,
  type KinWidget,
  type KinWidgetsActInput,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { kinPermission } from "./kinAccess.ts";
import {
  KIN_MAIL_RULES,
  KIN_MAIL_RULE_METHODS,
  createKinMailRuleCardActions,
  kinMailRuleActions,
  kinMailRuleBreaks,
  kinMailRuleCardView,
  kinMailRuleHistoryRows,
  kinMailRuleListsAfterTurnOn,
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
    // A host with the run ledger says why each mail was held and what each run did.
    [
      { state: "held_paused" as const, holdReason: "paused" as const, runOutcome: "held" as const },
      "Held: the rule was paused",
      "attention",
    ],
    [
      {
        state: "held_paused" as const,
        holdReason: "removed" as const,
        runOutcome: "held" as const,
      },
      "Held: the rule was removed",
      "attention",
    ],
    [
      {
        state: "held_paused" as const,
        holdReason: "setter_left" as const,
        runOutcome: "held" as const,
      },
      "Held: the person who set it up left the team",
      "attention",
    ],
    [
      {
        state: "held_paused" as const,
        holdReason: "setter_demoted" as const,
        runOutcome: "held" as const,
      },
      "Held: the person who set it up is no longer an owner or co-owner",
      "attention",
    ],
    [
      {
        state: "held_paused" as const,
        holdReason: "mailbox_unavailable" as const,
        runOutcome: "held" as const,
      },
      "Held: the mailbox was no longer connected",
      "attention",
    ],
    [
      {
        state: "held_paused" as const,
        holdReason: "destination_unavailable" as const,
        runOutcome: "held" as const,
      },
      "Held: its lead or chat was no longer available",
      "attention",
    ],
    [
      {
        state: "held_paused" as const,
        holdReason: "wording_changed" as const,
        runOutcome: "held" as const,
      },
      "Held: the rule was changed outside Kin",
      "attention",
    ],
    [
      {
        state: "held_paused" as const,
        holdReason: "monthly_limit" as const,
        runOutcome: "held" as const,
      },
      "Held: limit reached",
      "attention",
    ],
    [
      {
        state: "held_paused" as const,
        holdReason: "sender_unverified" as const,
        runOutcome: "held" as const,
      },
      "Held: sender not verified",
      "attention",
    ],
    [{ runOutcome: "posted_message" as const }, "Ran: the lead answered in the rule's chat", "ok"],
    [
      { outcome: "draft" as const, runOutcome: "raised_card" as const },
      "Ran: a card waits for a tap",
      "ok",
    ],
    [{ outcome: "nothing" as const, runOutcome: "nothing" as const }, "Nothing needed doing", "ok"],
    [{ runOutcome: null, holdReason: null }, "Running", "ok"],
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

  it("says a queued run plainly; the host's queued answer carries ids and no sentence", () => {
    expect(
      kinMailRuleRunNowAnswer({
        status: "queued",
        arrivalId: "arr_01JDCXG1",
        eventId: "evt_01JDCXG2",
      }),
    ).toEqual({
      text: "Queued. The lead answers in the chat where this rule's runs post.",
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

describe("kinMailRuleCardView: a lead's proposal card in chat", () => {
  const EXPIRES = Date.UTC(2026, 10, 28, 12, 0);
  const cardState = (overrides: Partial<KinMailRuleCardState> = {}): KinMailRuleCardState => ({
    mailbox: { connectionId: MAILBOX, label: "Accounts" },
    lead: { agentId: FINANCE, name: "Finance" },
    match: {
      from: [{ domain: "junipercold.example" }, { address: "Billing@Bücher.example" }],
      subjectHas: ["invoice"],
      withFile: true,
      classes: null,
    },
    fromAscii: ["junipercold.example", "billing@xn--bcher-kva.example"],
    what: "File the bill under Juniper Cold Chain\nand tell me the amount.",
    monthlyCap: 30,
    contentSha256: "9f".repeat(32),
    expiresAt: EXPIRES,
    decision: { status: "proposed" },
    ...overrides,
  });
  const cardWidget = (
    state: unknown = cardState(),
    overrides: Partial<Pick<KinWidget, "closedAt" | "revision">> = {},
  ) =>
    ({
      orgId: ORG,
      chatId: "chat_01JDCXC8D2E4F6G8H0J2K4M6N8",
      widgetId: "wid_01JDCXK2M4P6R8T0V2X4Z6B8D0",
      messageId: "msg_01JDCXK3N5Q7S9U1W3Y5A7C9E1",
      widgetClass: "native",
      type: "mail_rule",
      revision: 1,
      state,
      source: null,
      feed: null,
      awaiting: [],
      pinnedAt: null,
      closedAt: null,
      updatedAt: "2026-11-27T12:00:00.000Z",
      ...overrides,
    }) as unknown as KinWidget;
  const view = (
    widget: KinWidget,
    options: {
      readonly nowMs?: number;
      readonly ownerLevel?: boolean;
      readonly readOnly?: boolean;
    } = {},
  ) => kinMailRuleCardView(widget, { nowMs: NOW, words: WORDS, ...options });
  const BUTTONS = [
    { id: "turn_on", label: "Turn on" },
    { id: "not_now", label: "Not now" },
  ];

  it("shows the mailbox, the match in plain words, the lead, the limit and the words whole", () => {
    expect(view(cardWidget())).toEqual({
      orgId: ORG,
      widgetId: "wid_01JDCXK2M4P6R8T0V2X4Z6B8D0",
      revision: 1,
      connectionId: MAILBOX,
      eyebrow: "Mail rule",
      title:
        "From junipercold.example or Billing@Bücher.example (billing@xn--bcher-kva.example), subject has “invoice”, with a file",
      facts: [
        { label: "Mailbox", value: "Accounts" },
        { label: "Lead", value: "Finance" },
        { label: "Monthly limit", value: "Runs at most 30 times a month" },
      ],
      whatLabel: "What the lead is asked to do",
      what: "File the bill under Juniper Cold Chain\nand tell me the amount.",
      status: "Nothing runs until Turn on is tapped. The card is open until 28 Nov, 12:00.",
      actions: BUTTONS,
      accessibilityLabel:
        "Mail rule: From junipercold.example or Billing@Bücher.example (billing@xn--bcher-kva.example), subject has “invoice”, with a file. Mailbox: Accounts. Lead: Finance. Monthly limit: Runs at most 30 times a month. What the lead is asked to do: File the bill under Juniper Cold Chain and tell me the amount. Nothing runs until Turn on is tapped. The card is open until 28 Nov, 12:00.",
    });
  });

  it("shows the IDNA spelling the host sent, not one this device works out", () => {
    const card = view(
      cardWidget(
        cardState({
          match: {
            from: [{ domain: "bücher.example" }],
            subjectHas: [],
            withFile: null,
            classes: null,
          },
          fromAscii: ["xn--bcher-kva.example"],
        }),
      ),
    );
    expect(card?.title).toBe("From bücher.example (xn--bcher-kva.example)");
    const odd = view(
      cardWidget(
        cardState({
          match: {
            from: [{ domain: "bücher.example" }],
            subjectHas: [],
            withFile: null,
            classes: null,
          },
          fromAscii: ["xn--host-spelling.example"],
        }),
      ),
    );
    expect(odd?.title).toBe("From bücher.example (xn--host-spelling.example)");
  });

  it("keeps a long instruction whole and makes hidden characters visible", () => {
    const what = `${"Check the bill against the purchase order and ".repeat(40)}tell me.`;
    expect(view(cardWidget(cardState({ what })))?.what).toBe(what);
    const sneaky = view(
      cardWidget(
        cardState({
          what: "Reply that we got it\u202E.lla ti dnes\u200B\r\nthen file it.",
          match: { from: [], subjectHas: ["inv\u200Boice"], withFile: null, classes: null },
          fromAscii: [],
        }),
      ),
    );
    expect(sneaky?.what).toBe("Reply that we got it[U+202E].lla ti dnes[U+200B]\nthen file it.");
    expect(sneaky?.title).toBe("Subject has “inv[U+200B]oice”");
  });

  it.each([
    ["the owner level", { ownerLevel: true }, BUTTONS],
    ["a viewer whose level isn't known yet (the host decides)", {}, BUTTONS],
    ["a viewer below the owner level", { ownerLevel: false }, []],
    ["a viewer who may only read the chat", { ownerLevel: true, readOnly: true }, []],
  ] as const)("offers Turn on and Not now to %s", (_who, options, actions) => {
    expect(view(cardWidget(), options)?.actions).toEqual(actions);
  });

  it.each([
    [
      "turned on, with when",
      cardWidget(cardState({ decision: { status: "on", ruleId: RULE } }), {
        closedAt: "2026-11-27T09:15:00.000Z",
        revision: 2,
      }),
      "Turned on 27 Nov, 09:15.",
    ],
    [
      "not now, with when",
      cardWidget(cardState({ decision: { status: "dismissed" } }), {
        closedAt: "2026-11-27T09:15:00.000Z",
        revision: 2,
      }),
      "Not now was tapped 27 Nov, 09:15, so nothing was turned on.",
    ],
    [
      "expired without an answer",
      cardWidget(cardState({ expiresAt: NOW })),
      "This card expired, so nothing was turned on. Ask the lead for a new one.",
    ],
    [
      "closed without an answer",
      cardWidget(cardState(), { closedAt: "2026-11-27T09:15:00.000Z" }),
      "This card closed, so nothing was turned on.",
    ],
    [
      "replaced by a newer card",
      cardWidget(cardState({ decision: { status: "replaced" } }), {
        closedAt: "2026-11-27T09:15:00.000Z",
        revision: 2,
      }),
      "A newer card replaced this one, so nothing was turned on.",
    ],
  ] as const)("settles %s, with no buttons", (_state, widget, status) => {
    const card = view(widget, { ownerLevel: true });
    expect(card?.status).toBe(status);
    expect(card?.actions).toEqual([]);
    expect(card?.accessibilityLabel.endsWith(status)).toBe(true);
  });

  it("draws nothing from a state it can't read", () => {
    expect(view(cardWidget({ ...cardState(), what: "" }))).toBeNull();
    expect(view(cardWidget({ mailbox: "Accounts" }))).toBeNull();
  });

  it("names the Settings lists to read again once a rule is turned on", () => {
    const card = view(cardWidget());
    expect(card === null ? [] : kinMailRuleListsAfterTurnOn(card)).toEqual([
      { orgId: ORG, connectionId: MAILBOX },
      { orgId: ORG },
    ]);
  });
});

describe("createKinMailRuleCardActions: a tap posts once, through the card's action queue", () => {
  type Reply = { ok: true } | { ok: false; cause: unknown };
  const CARD = {
    widgetId: "wid_01JDCXK2M4P6R8T0V2X4Z6B8D0",
    revision: 3,
  } as const;
  const setup = (respond: (call: number) => Promise<Reply>) => {
    const posted: KinWidgetsActInput[] = [];
    const turnedOn: string[] = [];
    let id = 0;
    const act = createKinMailRuleCardActions({
      newId: () => `client-${++id}`,
      post: (input) => {
        posted.push(input);
        return respond(posted.length);
      },
      onTurnedOn: () => turnedOn.push("lists"),
    });
    return { posted, turnedOn, act };
  };
  const ok = () => Promise.resolve({ ok: true } as const);
  const dropped = () => Promise.reject(new Error("socket hang up ECONNRESET"));
  const refused = (reason: "widget_changed" | "not_allowed" | "invalid_state", message: string) =>
    Promise.resolve({ ok: false, cause: new KinChatError({ reason, message }) } as const);

  it.each(["turn_on", "not_now"] as const)(
    "%s posts one action with no value",
    async (actionId) => {
      const { posted, turnedOn, act } = setup(ok);
      expect(await act(CARD as never, actionId)).toEqual({
        revision: 3,
        notice: null,
        holding: true,
      });
      expect(posted).toEqual([{ ...CARD, actionId, clientActionId: "client-1" }]);
      expect(turnedOn).toEqual(actionId === "turn_on" ? ["lists"] : []);
    },
  );

  it("posts a double tap once, Turn on and Not now together included", async () => {
    let release: (value: { ok: true }) => void = () => undefined;
    const { posted, act } = setup(() => new Promise((resolve) => (release = resolve)));
    const first = act(CARD as never, "turn_on");
    expect(await act(CARD as never, "turn_on")).toBeNull();
    expect(await act(CARD as never, "not_now")).toBeNull();
    release({ ok: true });
    await first;
    expect(posted).toHaveLength(1);
  });

  it("retries a dropped send with the same id, so the host takes it once", async () => {
    const replies = [dropped, ok];
    const { posted, turnedOn, act } = setup((call) => replies[call - 1]!());
    const failed = await act(CARD as never, "turn_on");
    expect(failed?.notice?.kind).toBe("error");
    expect(failed?.holding).toBe(false);
    expect(turnedOn).toEqual([]);
    await act(CARD as never, "turn_on");
    expect(posted.map((input) => input.clientActionId)).toEqual(["client-1", "client-1"]);
    expect(turnedOn).toEqual(["lists"]);
  });

  it.each([
    [
      "widget_changed",
      "This mail rule card no longer matches what Kin showed, so nothing was turned on.",
      { kind: "stale", holding: true },
    ],
    [
      "widget_changed",
      "This mail rule card has expired, so ask for a new one.",
      { kind: "stale", holding: true },
    ],
    [
      "not_allowed",
      "Only the owner or a co-owner can answer this mail rule card.",
      { kind: "error", holding: false },
    ],
    [
      "invalid_state",
      "This company mailbox is no longer connected.",
      { kind: "error", holding: false },
    ],
  ] as const)(
    "a %s refusal says the host's sentence verbatim: %s",
    async (reason, message, shown) => {
      const { turnedOn, act } = setup(() => refused(reason, message));
      expect(await act(CARD as never, "turn_on")).toEqual({
        revision: 3,
        notice: { kind: shown.kind, text: message },
        holding: shown.holding,
      });
      expect(turnedOn).toEqual([]);
    },
  );
});
