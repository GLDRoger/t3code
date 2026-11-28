import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  KinMailRule,
  KinMailRuleCardState,
  KinMailRuleCreateInput,
  KinMailRuleHistory,
  KinMailRuleMatch,
  KinMailRuleRunNow,
} from "./kinMailRules.ts";

const encodeCard = Schema.encodeSync(KinMailRuleCardState);
const decodeCard = Schema.decodeUnknownSync(KinMailRuleCardState);
const encodeRule = Schema.encodeSync(KinMailRule);
const decodeRule = Schema.decodeUnknownSync(KinMailRule);
const valid = Schema.is(KinMailRuleCreateInput);
const isMatch = Schema.is(KinMailRuleMatch);

const filters = { from: [], subjectHas: ["invoice"], withFile: true, classes: ["known_biller"] };

describe("mail rule tap", () => {
  it("rejects out-of-range limits and instructions, ambiguous senders and long phrase lists", () => {
    const input = {
      orgId: "org",
      connectionId: "mail",
      agentId: "finance",
      chatId: "rhea-finance",
      tapId: "tap",
      what: "File the bill.",
      match: filters,
    };
    expect(valid(input)).toBe(true);
    expect(valid({ ...input, monthlyCap: 0 })).toBe(false);
    expect(valid({ ...input, monthlyCap: 1001 })).toBe(false);
    expect(valid({ ...input, what: "x".repeat(2001) })).toBe(false);
    expect(
      isMatch({
        ...filters,
        from: [{ address: "bill@juniper.example", domain: "juniper.example" }],
      }),
    ).toBe(false);
    expect(isMatch({ ...filters, subjectHas: Array(6).fill("invoice") })).toBe(false);
  });
});

it("accepts queued mail rule runs with an event and keeps the earlier results readable", () => {
  const accepts = Schema.is(KinMailRuleRunNow);
  expect(accepts({ status: "queued", arrivalId: "arr_acf1102", eventId: "pulse-cb9831" })).toBe(
    true,
  );
  expect(accepts({ status: "queued", arrivalId: "arr_acf1102" })).toBe(false);
  expect(
    accepts({ status: "no_match", message: "No mail in the last 30 days matches this rule." }),
  ).toBe(true);
  expect(
    accepts({
      status: "not_yet",
      arrivalId: "arr_acf1102",
      message: "Kin can't run mail rules yet. Nothing ran.",
    }),
  ).toBe(true);
});

it("decodes bounded run outcomes and hold reasons while keeping earlier history readable", () => {
  const decode = Schema.decodeUnknownSync(KinMailRuleHistory);
  const row = {
    kind: "mail",
    arrivalId: "arr_acf1102",
    fromAddress: null,
    receivedAt: null,
    noticedAt: 1000,
    state: "woke",
    outcome: null,
    eventId: "pulse-cb9831",
    wakeupId: null,
    settledAt: null,
    refs: null,
  };
  expect(decode({ entries: [row] }).entries).toEqual([row]);
  const ended = { ...row, runOutcome: "raised_card", holdReason: null };
  const held = { ...row, state: "held_paused", runOutcome: "held", holdReason: "setter_demoted" };
  expect(decode({ entries: [ended, held] }).entries).toEqual([ended, held]);
  expect(() => decode({ entries: [{ ...held, holdReason: "raw message" }] })).toThrow();
});

it("round-trips removal time and still lets older card decoders read the decision", () => {
  const { decision, ...fields } = KinMailRuleCardState.fields;
  const { status, ruleId, by } = decision.members[1].fields;
  const oldCard = Schema.Struct({
    ...fields,
    decision: Schema.Union([
      decision.members[0],
      Schema.Struct({ status, ruleId, by }),
      decision.members[2],
      decision.members[3],
    ]),
  });
  const old = {
    mailbox: { connectionId: "mail", label: "Mail" },
    lead: { agentId: "finance", name: "Finance" },
    match: filters,
    fromAscii: [],
    what: "File the bill.",
    monthlyCap: 30,
    contentSha256: "a".repeat(64),
    expiresAt: 1000,
    decision: { status: "on", ruleId: "rule", by: { personId: "rhea", name: "Rhea" } },
  };
  const updated = { ...old, decision: { ...old.decision, removedAt: "2026-11-27T12:00:00.000Z" } };
  expect(encodeCard(decodeCard(old))).toEqual(old);
  expect(encodeCard(decodeCard(updated))).toEqual(updated);
  expect(Schema.decodeUnknownSync(oldCard)(updated)).toEqual(old);
});

it("round-trips a rule's optional last run time", () => {
  const old = {
    orgId: "org",
    connectionId: "mail",
    ruleId: "rule",
    match: filters,
    wordingChanged: false,
    what: "File the bill.",
    agentId: "finance",
    chatId: "rhea-finance",
    saidBy: "rhea",
    setterName: "Rhea",
    state: "on",
    pausedWhy: null,
    monthlyCap: 30,
    month: "2026-11",
    fired: 1,
    atLimit: false,
    lastWakeAt: 1000,
    createdAt: 0,
    updatedAt: 1000,
  };
  const updated = { ...old, lastRanAt: "2026-11-27T12:00:00.000Z" };
  expect(encodeRule(decodeRule(old))).toEqual(old);
  expect(encodeRule(decodeRule(updated))).toEqual(updated);
});
