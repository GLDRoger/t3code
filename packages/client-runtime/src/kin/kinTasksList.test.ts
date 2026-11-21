// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import {
  KinAgentId,
  KinChatId,
  KinMessageId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinWidgetId,
  type KinPulseFact,
  type KinRecord,
  type KinRecordDetail,
  type KinWorkMoveCard,
  type KinWorkRowMove,
  type KinWorkSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { kinMayHaveGoneLine } from "./kinChoicePresentation.ts";
import { kinRecordMove } from "./kinTaskRecord.ts";
import {
  kinNeedsYouCount,
  kinTaskLine,
  kinTaskStep,
  kinTaskStepStatusShown,
  kinTasksByMove,
  kinTasksDealFacts,
  kinTasksDealFactsOf,
  kinTaskFilterProjects,
  kinTasksGroupedBy,
  kinTasksMostUrgent,
  kinTasksTick,
  kinTasksTickedShown,
  kinTasksWithTicked,
  type KinTaskTicked,
} from "./kinTasksList.ts";
import type { KinWorkNotice } from "./kinWorkChanges.ts";
import type { KinWorkNames } from "./kinWork.ts";

// Ambermill, invented: owner Rhea; Meera, Zoya; agents Chief of staff and Finance.
const rhea = { _tag: "person", personId: KinPersonId.make("ambermill-rhea") } as const;
const meera = { _tag: "person", personId: KinPersonId.make("ambermill-meera") } as const;
const zoya = { _tag: "person", personId: KinPersonId.make("ambermill-zoya") } as const;
const chief = { _tag: "agent", agentId: KinAgentId.make("ambermill-chief") } as const;
const names: KinWorkNames = {
  people: new Map([
    [rhea.personId, "Rhea"],
    [meera.personId, "Meera Rao"],
    [zoya.personId, "Zoya"],
  ]),
  agents: new Map([[chief.agentId, "Chief of staff"]]),
  me: rhea.personId,
  owner: rhea.personId,
  zone: "UTC",
};
const asZoya: KinWorkNames = { ...names, me: zoya.personId };
const now = new Date("2026-11-18T09:00:00.000Z");

const row = (key: string, patch: Partial<KinRecord> = {}): KinRecord => ({
  recordId: KinRecordId.make(`rec-${key}`),
  orgId: KinOrgId.make("ambermill"),
  key,
  title: `Invented task ${key}`,
  state: "open",
  waitingOn: null,
  owner: rhea,
  category: null,
  side: "ours",
  dueAt: null,
  dueAllDay: false,
  late: false,
  confirmed: true,
  sensitive: false,
  working: false,
  pullRequest: null,
  rev: 1,
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-01T09:00:00.000Z",
  closedAt: null,
  ...patch,
});
const late = (due: string) => ({ late: true, dueAt: due });
const card = (patch: Partial<KinWorkMoveCard> = {}): KinWorkMoveCard => ({
  kind: "send",
  chatId: KinChatId.make("ambermill-chat"),
  messageId: KinMessageId.make("ambermill-message"),
  widgetId: KinWidgetId.make("ambermill-card"),
  preview: "To accounts@orbit.invalid: October invoice",
  files: [],
  at: "2026-11-18T08:00:00.000Z",
  revision: 2,
  options: [
    { optionId: "cancel", label: "Cancel", kind: "no" },
    { optionId: "confirm", label: "Confirm", kind: "yes" },
  ],
  ...patch,
});
const detail = (patch: Partial<KinRecordDetail>): KinRecordDetail => ({
  ...row("W-1"),
  notes: "",
  source: { chatId: null, messageId: null },
  assignedBy: null,
  assignedAt: null,
  createdBy: rhea,
  links: [],
  changes: [],
  ...patch,
});

describe("whose move a task is (kinRecordMove, the rule Tasks and the record share)", () => {
  it.each([
    ["a draft waits on you about it", detail({ owner: chief, waiting: card() }), true, "needsYou"],
    ["you hold it", detail({ owner: rhea }), true, "needsYou"],
    [
      "it waits on you",
      detail({ owner: meera, state: "waiting", waitingOn: rhea }),
      true,
      "needsYou",
    ],
    [
      "you hold it and it waits on you",
      detail({ state: "waiting", waitingOn: rhea }),
      true,
      "needsYou",
    ],
    [
      "someone holds it and it waits on them",
      detail({ owner: meera, createdBy: meera, state: "waiting", waitingOn: meera }),
      true,
      "rest",
    ],
    [
      "you hold it and it waits on someone",
      detail({ state: "waiting", waitingOn: meera }),
      true,
      "waiting",
    ],
    [
      "you hold it, it waits on someone, and it is late",
      detail({ state: "waiting", waitingOn: meera, ...late("2026-11-10T00:00:00.000Z") }),
      true,
      "needsYou",
    ],
    ["you asked someone", detail({ owner: meera }), true, "waiting"],
    [
      "you asked someone and it is late",
      detail({ owner: meera, ...late("2026-11-10T00:00:00.000Z") }),
      true,
      "needsYou",
    ],
    ["someone else's own", detail({ owner: meera, createdBy: meera }), true, "rest"],
    [
      "an agent's suggestion, for the owner level",
      detail({ owner: chief, createdBy: chief, confirmed: false }),
      true,
      "needsYou",
    ],
    [
      "an agent's suggestion, for a teammate",
      detail({ owner: chief, createdBy: chief, confirmed: false }),
      false,
      "rest",
    ],
    ["closed", detail({ state: "done" }), true, null],
  ] as const)("%s", (_name, item, ownerLevel, expected) => {
    expect(kinRecordMove(item, names, ownerLevel)).toBe(expected);
  });
});

describe("kinTasksByMove", () => {
  const groups = (items: ReturnType<typeof kinTasksByMove>) =>
    items.map((item) =>
      item.type === "heading"
        ? `${item.title} ${item.count ?? "-"}`
        : item.type === "task"
          ? item.key
          : item.type,
    );

  it("places and orders rows itself on an older host: late, then soonest due, then no date", () => {
    const records = [
      row("A"),
      row("B", { dueAt: "2026-11-20T00:00:00.000Z" }),
      row("C", late("2026-11-15T00:00:00.000Z")),
      row("D", { owner: meera, givenBy: rhea }),
      row("E", { owner: zoya }),
      row("F", late("2026-11-12T00:00:00.000Z")),
    ];
    expect(
      groups(
        kinTasksByMove({
          records,
          moves: new Map(),
          counts: null,
          needsYou: null,
          ownerLevel: true,
          names,
          read: true,
        }),
      ),
    ).toEqual([
      "Needs you -",
      "F",
      "C",
      "B",
      "A",
      "Waiting on others -",
      "D",
      "Rest of the team -",
      "E",
    ]);
  });

  it("keeps the host's order and counts, says all clear, and ends with Done", () => {
    const records = [row("D", { owner: meera }), row("E", { owner: zoya })];
    const moves = new Map<string, KinWorkRowMove>([
      ["D", { key: "D", group: "waiting" }],
      ["E", { key: "E", group: "rest" }],
    ]);
    const counts = { needsYou: 0, waiting: 60, rest: 1, doneRecently: 16 };
    expect(
      groups(
        kinTasksByMove({
          records,
          moves,
          counts,
          needsYou: 0,
          ownerLevel: true,
          names,
          read: true,
        }),
      ),
    ).toEqual([
      "Needs you 0",
      "clear",
      "Waiting on others 60",
      "D",
      "Rest of the team 1",
      "E",
      "done",
    ]);
    // Nothing read yet, as offline before the first answer: no group, so not all clear either.
    expect(
      kinTasksByMove({
        records: [],
        moves: new Map(),
        counts: null,
        needsYou: null,
        ownerLevel: true,
        names,
        read: false,
      }),
    ).toEqual([]);
  });

  it("gives a teammate their projects and the line on what they see", () => {
    const moves = new Map<string, KinWorkRowMove>([["K", { key: "K", group: "rest" }]]);
    const counts = { needsYou: 2, waiting: 0, rest: 1, doneRecently: 0 };
    expect(
      groups(
        kinTasksByMove({
          records: [row("K", { owner: chief })],
          moves,
          counts,
          needsYou: 2,
          ownerLevel: false,
          names: asZoya,
          read: true,
        }),
      ),
    ).toEqual(["Needs you 2", "Your projects 1", "K", "foot"]);
  });
});

describe("a ticked row stays in its place while its Undo can be reached", () => {
  const moves = new Map<string, KinWorkRowMove>([
    ["A", { key: "A", group: "needsYou" }],
    ["B", { key: "B", group: "needsYou" }],
    ["C", { key: "C", group: "needsYou" }],
  ]);
  const counts = { needsYou: 3, waiting: 0, rest: 0, doneRecently: 0 };
  const listed = (records: ReadonlyArray<KinRecord>) =>
    kinTasksByMove({ records, moves, counts, needsYou: 3, ownerLevel: true, names, read: true });
  const shape = (items: ReturnType<typeof listed>) =>
    items.flatMap((item) =>
      item.type === "task"
        ? [
            `${item.key}:${item.record.state}${item.ticked ? "~" : ""}${item.first ? "^" : ""}${item.last ? "$" : ""}`,
          ]
        : [],
    );
  const done = (record: KinRecord): KinRecord => ({ ...record, state: "done" });
  const notice: KinWorkNotice = {
    key: "A",
    kind: "saved",
    text: "Marked done.",
    undo: { type: "state", state: "open", waitingOn: null },
  };

  it("holds a ticked row under the line it sat under once the host drops it, then lets it go", () => {
    const before = listed([row("A"), row("B"), row("C")]);
    const first = kinTasksTick({
      held: [],
      items: before,
      key: "B",
      action: { type: "state", state: "done" },
      notice: null,
    });
    expect(first.undo).toBe(false);
    // The host's next read leaves B out: without the hold, C would slide up under the thumb.
    const after = listed([row("A"), row("C")]);
    expect(shape(after)).toEqual(["A:open^", "C:open$"]);
    const held = kinTasksTickedShown(first.ticked, { pending: {} }, { ...notice, key: "B" });
    expect(shape(kinTasksWithTicked(after, held, done))).toEqual(["A:open^", "B:done~", "C:open$"]);
    // A second quick tick holds both, each in its own place.
    const second = kinTasksTick({
      held,
      items: kinTasksWithTicked(after, held, done),
      key: "C",
      action: { type: "state", state: "done" },
      notice: null,
    });
    const both = kinTasksTickedShown(second.ticked, { pending: { C: { state: "done" } } }, null);
    expect(shape(kinTasksWithTicked(listed([row("A")]), both, done))).toEqual([
      "A:open^",
      "B:done~",
      "C:done~$",
    ]);
    // The Undo bar went: nothing is held, and the rows leave together.
    expect(kinTasksTickedShown(second.ticked, { pending: {} }, null)).toEqual([]);
  });

  it("puts a row the host still lists as it is, and drops one whose line has gone", () => {
    const before = listed([row("A"), row("B")]);
    const ticked = kinTasksTick({
      held: [],
      items: before,
      key: "B",
      action: { type: "state", state: "done" },
      notice: null,
    }).ticked;
    expect(shape(kinTasksWithTicked(listed([row("A"), done(row("B"))]), ticked, done))).toEqual([
      "A:open^",
      "B:done~$",
    ]);
    const orphan: ReadonlyArray<KinTaskTicked<KinRecord>> = ticked.map((one) => ({
      ...one,
      after: "gone",
    }));
    expect(shape(kinTasksWithTicked(listed([row("A")]), orphan, done))).toEqual(["A:open^$"]);
  });

  it("takes the Undo when the held row is ticked again, and nothing else is an undo", () => {
    const items = listed([row("A")]);
    const reopen = { type: "state", state: "open" } as const;
    expect(kinTasksTick({ held: [], items, key: "A", action: reopen, notice }).undo).toBe(true);
    expect(kinTasksTick({ held: [], items, key: "C", action: reopen, notice }).undo).toBe(false);
    expect(
      kinTasksTick({ held: [], items, key: "A", action: reopen, notice: { ...notice, undo: null } })
        .undo,
    ).toBe(false);
  });
});

describe("kinTasksDealFacts", () => {
  const fact = (
    sense: KinPulseFact["sense"],
    key: string,
    actor: KinPulseFact["actor"],
    patch: Partial<KinPulseFact> = {},
  ): KinPulseFact => ({
    sense,
    family: "work",
    key: `${sense}:${key}`,
    subject: { kind: "record", key, title: `Invented ${key}` },
    scope: { clientKey: "C-1", clientTitle: "Corran Tiles" },
    since: DateTime.makeUnsafe(Date.UTC(2026, 10, 16, 9)),
    consequence: `Invented ${key} for Corran Tiles has no next step.`,
    actor,
    sensitive: false,
    wake: "sweep",
    handled: null,
    ...patch,
  });
  const pulseOf = (...facts: ReadonlyArray<KinPulseFact>) => ({
    asOf: DateTime.makeUnsafe(now.getTime()),
    total: facts.length,
    facts,
  });
  const owner = { _tag: "owner" } as const;
  const everything = pulseOf(
    fact("deal_no_next_step", "DL-1", zoya),
    fact("deal_quiet", "DL-2", zoya),
    fact("deal_date_passed", "DL-3", rhea),
    fact("deal_no_next_step", "C-4", owner),
    fact("deal_quiet", "DL-5", zoya, {
      handled: {
        by: zoya,
        at: DateTime.makeUnsafe(Date.UTC(2026, 10, 17)),
        until: null,
        note: null,
      },
    }),
    fact("task_late", "W-9", zoya),
    fact("client_quiet", "C-1", owner),
  );
  const keys = (rows: ReturnType<typeof kinTasksDealFacts>) => rows.map((one) => one.factKey);

  it("lists a person's own deal and prospect facts, and the owner's own and those that fall to him", () => {
    expect(
      keys(kinTasksDealFacts({ ownerLevel: false, names: asZoya, now, pulse: everything })),
    ).toEqual(["deal_no_next_step:DL-1", "deal_quiet:DL-2"]);
    expect(keys(kinTasksDealFacts({ ownerLevel: true, names, now, pulse: everything }))).toEqual([
      "deal_date_passed:DL-3",
      "deal_no_next_step:C-4",
    ]);
    // A deal with no next step carries "What's next?"; a prospect's opens the prospect.
    const [deal] = kinTasksDealFacts({ ownerLevel: false, names: asZoya, now, pulse: everything });
    expect(deal).toMatchObject({ whatsNext: "DL-1", open: { type: "record", key: "DL-1" } });
    const prospect = kinTasksDealFacts({ ownerLevel: true, names, now, pulse: everything })[1];
    expect(prospect).toMatchObject({ whatsNext: null, open: { type: "record", key: "C-4" } });
  });

  it("drops a fact once it clears, and has none while the pulse loads", () => {
    expect(kinTasksDealFacts({ ownerLevel: false, names: asZoya, now, pulse: pulseOf() })).toEqual(
      [],
    );
    expect(kinTasksDealFacts({ ownerLevel: true, names, now, pulse: null })).toEqual([]);
    expect(kinTasksDealFacts({ ownerLevel: true, names, now })).toEqual([]);
    // Needs you counts them beside the tasks, as the badge does.
    const counts = { needsYou: 3, waiting: 0, rest: 0, doneRecently: 0 };
    const dealFacts = kinTasksDealFactsOf(everything, {
      ownerLevel: false,
      me: asZoya.me,
    }).length;
    expect(kinNeedsYouCount({ counts, dealFacts })).toBe(5);
    expect(kinNeedsYouCount({ counts: null, dealFacts })).toBeNull();
  });

  it("puts them first under Needs you, so it is not all clear", () => {
    const facts = kinTasksDealFacts({ ownerLevel: false, names: asZoya, now, pulse: everything });
    const items = kinTasksByMove({
      records: [row("K", { owner: zoya })],
      moves: new Map([["K", { key: "K", group: "needsYou" }]]),
      counts: { needsYou: 0, waiting: 0, rest: 0, doneRecently: 0 },
      needsYou: 3,
      ownerLevel: false,
      names: asZoya,
      facts,
      read: true,
    });
    expect(
      items.map((item) =>
        item.type === "fact"
          ? `${item.key} ${item.first} ${item.last}`
          : item.type === "task"
            ? `${item.key} ${item.first} ${item.last}`
            : item.type,
      ),
    ).toEqual([
      "heading",
      "deal_no_next_step:DL-1 true false",
      "deal_quiet:DL-2 false false",
      "K false true",
      "foot",
    ]);
    const alone = kinTasksByMove({
      records: [],
      moves: new Map(),
      counts: { needsYou: 0, waiting: 0, rest: 0, doneRecently: 0 },
      needsYou: 1,
      ownerLevel: false,
      names: asZoya,
      facts: facts.slice(0, 1),
      read: true,
    });
    expect(alone.map((item) => item.type)).toEqual(["heading", "fact", "foot"]);
  });
});

describe("kinTaskStep", () => {
  it.each([
    [
      "a draft: Approve and send taps its Confirm",
      row("A", {
        owner: chief,
        party: {
          recordId: KinRecordId.make("c"),
          key: "C-1",
          title: "Orbit Dental",
          kind: "client",
        },
      } as Partial<KinRecord>),
      { key: "A", group: "needsYou", card: card() },
      { kind: "send", approveId: "confirm", to: "Orbit Dental", gone: null },
    ],
    [
      "a draft whose earlier try may have gone: only Review, which holds the tick, and why",
      row("M", { owner: chief }),
      {
        key: "M",
        group: "needsYou",
        card: card({ mayHaveGone: { tryId: "ask-1", at: "2026-11-18T07:00:00.000Z" } }),
      },
      {
        kind: "send",
        approveId: null,
        to: null,
        gone: kinMayHaveGoneLine("2026-11-18T07:00:00.000Z", now),
      },
    ],
    [
      "a question: its first three options",
      row("Q", { owner: chief }),
      {
        key: "Q",
        group: "needsYou",
        card: card({
          kind: "question",
          options: ["Tue", "Thu", "Fri", "Mon"].map((label) => ({ optionId: label, label })),
        }),
      },
      { kind: "question", options: ["Tue", "Thu", "Fri"] },
    ],
    [
      "late with a person you asked: Nudge by first name, with their last word",
      row("N", { owner: meera, can: undefined, ...late("2026-11-15T00:00:00.000Z") }),
      { key: "N", group: "needsYou", said: "Waiting on the clinic.", nudgedAt: now.toISOString() },
      { kind: "nudge", name: "Meera", line: "Meera: “Waiting on the clinic.”", nudged: true },
    ],
    [
      "late with an agent: nothing to nudge",
      row("G", { owner: chief, ...late("2026-11-15T00:00:00.000Z") }),
      { key: "G", group: "needsYou" },
      null,
    ],
    [
      "only waiting on others: no step",
      row("W", { owner: meera }),
      { key: "W", group: "waiting" },
      null,
    ],
    [
      "handed back to you: who, and why in their words",
      row("B", { handedBack: { by: meera, at: "2026-11-18T08:30:00.000Z" } }),
      { key: "B", group: "needsYou", handedBackNote: "The clinic wants Zoya on it." },
      { kind: "told", line: "Meera handed this back: “The clinic wants Zoya on it.”" },
    ],
    [
      "handed back to you with no words: who",
      row("C", { handedBack: { by: zoya, at: "2026-11-18T08:30:00.000Z" } }),
      { key: "C", group: "needsYou" },
      { kind: "told", line: "Zoya handed this back" },
    ],
    [
      "yours, and someone asked today where it stands",
      row("D", { ...late("2026-11-15T00:00:00.000Z") }),
      { key: "D", group: "needsYou", askedBy: meera.personId },
      { kind: "told", line: "Meera asked where this stands" },
    ],
    [
      "yours, nothing told: no step",
      row("E", { ...late("2026-11-15T00:00:00.000Z") }),
      { key: "E", group: "needsYou" },
      null,
    ],
  ] as const)("%s", (_name, record, move, expected) => {
    const step = kinTaskStep(record, move as KinWorkRowMove, names, now);
    if (expected === null) return expect(step).toBeNull();
    expect(step?.kind).toBe(expected.kind);
    if (step?.kind === "send" && "approveId" in expected) {
      expect(step.approve?.optionId ?? null).toBe(expected.approveId);
      expect(step.to).toBe(expected.to);
      expect(step.mayHaveGone).toBe(expected.gone);
    }
    if (step?.kind === "question" && "options" in expected)
      expect(step.options.map((option) => option.label)).toEqual(expected.options);
    if (step?.kind === "told" && "line" in expected) expect(step.line).toBe(expected.line);
    if (step?.kind === "nudge" && "name" in expected)
      expect({ name: step.name, line: step.line, nudged: step.nudged }).toEqual({
        name: expected.name,
        line: expected.line,
        nudged: expected.nudged,
      });
  });
});

describe("kinTaskStepStatusShown", () => {
  it("keeps a step's outcome only while the row still offers the card it answered", () => {
    const sent = { kind: "done", text: "Sent to Orbit Dental", widgetId: "w-1" } as const;
    const step = (widgetId: string) =>
      kinTaskStep(
        row("A", { owner: chief }),
        { key: "A", group: "needsYou", card: card({ widgetId: KinWidgetId.make(widgetId) }) },
        names,
        now,
      );
    expect(kinTaskStepStatusShown(sent, step("w-1"))).toBe(sent);
    expect(kinTaskStepStatusShown(sent, null)).toBe(sent);
    // The send failed and the same mail came back on a fresh card: the row offers that one.
    expect(kinTaskStepStatusShown(sent, step("w-2"))).toBeNull();
    const busy = { kind: "busy", id: "confirm" } as const;
    expect(kinTaskStepStatusShown(busy, step("w-2"))).toBe(busy);
  });
});

describe("kinTaskLine", () => {
  it.each([
    ["late is one red word", row("A", late("2026-11-15T09:00:00.000Z")), "late", "3 days late", ""],
    [
      "an agent at work says so",
      row("B", {
        owner: chief,
        state: "doing",
        dueAt: "2026-11-19T23:59:59.000Z",
        dueAllDay: true,
      }),
      "working",
      "Working on it",
      "Due tomorrow",
    ],
    ["no date says so", row("C"), null, null, "No date"],
    [
      "waiting names who it waits on",
      row("D", {
        state: "waiting",
        waitingOn: zoya,
        dueAt: "2026-11-24T23:59:59.000Z",
        dueAllDay: true,
      }),
      null,
      null,
      "Waiting on Zoya · Due Tue, Nov 24",
    ],
  ] as const)("%s", (_name, record, tone, text, rest) => {
    const line = kinTaskLine(record, names, now);
    expect(line.lead?.tone ?? null).toBe(tone);
    expect(line.lead?.text ?? null).toBe(text);
    expect(line.rest).toBe(rest);
  });
});

describe("a person's page and the project filter", () => {
  it("lists a person's five most urgent open tasks in Tasks' own order", () => {
    const rows = [
      row("W-1"),
      row("W-2", { dueAt: "2026-11-25T09:00:00.000Z" }),
      row("W-3", late("2026-11-16T09:00:00.000Z")),
      row("W-4", { dueAt: "2026-11-20T09:00:00.000Z" }),
      row("W-5", { state: "done", ...late("2026-11-10T09:00:00.000Z") }),
      row("W-6", late("2026-11-12T09:00:00.000Z")),
      row("W-7", { createdAt: "2026-10-01T09:00:00.000Z" }),
    ];
    expect(kinTasksMostUrgent(rows, 5).map((one) => one.key)).toEqual([
      "W-6",
      "W-3",
      "W-4",
      "W-2",
      "W-7",
    ]);
  });

  it("offers a teammate every project of a task they see, not only the ones they are on", () => {
    const theirs = { key: "P-1", title: "Lumen booking app" } as const;
    const other = { recordId: KinRecordId.make("p-2"), key: "P-2", title: "Kin" } as const;
    const rows = [
      row("W-1", { owner: zoya, project: { recordId: KinRecordId.make("p-1"), ...theirs } }),
      row("W-2", { owner: zoya, project: other }),
      row("W-3", { owner: zoya, project: other }),
      row("W-4", { owner: zoya }),
    ];
    expect(kinTaskFilterProjects([theirs], rows)).toEqual([theirs, { key: "P-2", title: "Kin" }]);
    expect(kinTaskFilterProjects([theirs], [rows[0]!])).toEqual([theirs]);
  });
});

describe("kinNeedsYouCount", () => {
  it("is Tasks' own count, null until it arrives", () => {
    const counts = { needsYou: 4, waiting: 0, rest: 0, doneRecently: 0 };
    expect(kinNeedsYouCount({ counts })).toBe(4);
    expect(kinNeedsYouCount({ counts: null })).toBeNull();
  });
});

describe("kinTasksGroupedBy", () => {
  it("groups by project with the summary's counts, and tasks in none last", () => {
    const project = { recordId: KinRecordId.make("p"), key: "P-1", title: "Kestrel onboarding" };
    const summary = {
      projects: [{ project, open: 3, late: 0, health: null }],
      owners: [],
    } as unknown as KinWorkSummary;
    const items = kinTasksGroupedBy({
      records: [
        row("A"),
        row("B", { project, dueAt: "2026-11-25T00:00:00.000Z" }),
        row("C", { project, ...late("2026-11-10T00:00:00.000Z") }),
      ],
      groupBy: "project",
      summary,
      names,
      now,
    });
    expect(
      items.map((item) =>
        item.type === "heading" ? `${item.title} ${item.count ?? "-"}` : item.key,
      ),
    ).toEqual(["Kestrel onboarding 3", "C", "B", "Not in a project -", "A"]);
  });
});
