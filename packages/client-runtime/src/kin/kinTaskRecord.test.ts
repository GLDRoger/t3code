// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import {
  EnvironmentId,
  KinAgentId,
  KinListId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type KinRecordCan,
  type KinRecordChange,
  type KinRecordComment,
  type KinRecordDetail,
  KinChatId,
  KinMessageId,
  KinWidgetId,
  KIN_CODING_AGENT_UNNAMED,
  KIN_DISMISSED_FIELD,
  KIN_TAKEN_DEFAULT_FIELD,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinBriefBy,
  kinNextStep,
  kinRecordAskedBy,
  kinRecordChip,
  kinTaskActivity,
  kinTaskControls,
  kinTaskOrigin,
  kinRecordHeld,
  kinTaskPeopleRows,
  kinTaskWith,
  kinTaskWithChoices,
} from "./kinTaskRecord.ts";
import { kinWorkItemView, type KinWorkNames } from "./kinWork.ts";

const rhea = { _tag: "person", personId: KinPersonId.make("ambermill-rhea") } as const;
const meera = { _tag: "person", personId: KinPersonId.make("ambermill-meera") } as const;
const zoya = { _tag: "person", personId: KinPersonId.make("ambermill-zoya") } as const;
const chief = { _tag: "agent", agentId: KinAgentId.make("ambermill-chief") } as const;
const finance = { _tag: "agent", agentId: KinAgentId.make("ambermill-finance") } as const;
const names: KinWorkNames = {
  people: new Map([
    [rhea.personId, "Rhea"],
    [meera.personId, "Meera"],
    [zoya.personId, "Zoya"],
  ]),
  agents: new Map([
    [chief.agentId, "Chief of staff"],
    [finance.agentId, "Finance"],
  ]),
  me: rhea.personId,
  owner: rhea.personId,
  zone: "UTC",
};
const asZoya: KinWorkNames = { ...names, me: zoya.personId };
const now = new Date("2026-11-18T09:00:00.000Z");
const host = EnvironmentId.make("ambermill-host");
const place = { environmentId: host, isKnownEnvironment: () => true };
const ownerCan: KinRecordCan = {
  states: ["open", "doing", "waiting", "done", "dropped"],
  edit: true,
  party: true,
  project: true,
  clearProject: true,
  give: true,
  takeBack: true,
  mark: true,
  unmark: true,
  share: true,
  confirm: true,
};
const readOnly: KinRecordCan = {
  ...ownerCan,
  states: [],
  edit: false,
  give: false,
  takeBack: false,
  confirm: false,
};

const task = (patch: Partial<KinRecordDetail> = {}): KinRecordDetail => ({
  recordId: KinRecordId.make("rec-29"),
  orgId: KinOrgId.make("ambermill"),
  key: "T-29",
  title: "Rewrite the appointment reminder texts",
  state: "open",
  waitingOn: null,
  owner: meera,
  category: null,
  side: "ours",
  dueAt: null,
  dueAllDay: false,
  late: false,
  confirmed: true,
  sensitive: false,
  working: false,
  pullRequest: null,
  rev: 4,
  createdAt: "2026-11-09T09:00:00.000Z",
  updatedAt: "2026-11-15T09:00:00.000Z",
  closedAt: null,
  notes: "",
  source: { chatId: null, messageId: null },
  assignedBy: rhea,
  assignedAt: "2026-11-09T09:00:00.000Z",
  createdBy: rhea,
  links: [],
  changes: [],
  seq: 4,
  can: ownerCan,
  ...patch,
});

const change = (
  patch: Partial<KinRecordChange> & Pick<KinRecordChange, "seq">,
): KinRecordChange => ({
  at: "2026-11-10T09:00:00.000Z",
  by: rhea,
  via: "owner",
  kind: "updated",
  fields: [],
  ...patch,
});

const comment = (
  patch: Partial<KinRecordComment> & Pick<KinRecordComment, "seq">,
): KinRecordComment => ({
  commentId: `c-${patch.seq}`,
  at: "2026-11-10T09:30:00.000Z",
  by: rhea,
  body: "Invented note",
  files: [],
  ...patch,
});

const stepOf = (item: KinRecordDetail, who = names, can = { change: true, give: true }) =>
  kinNextStep({
    item,
    view: kinWorkItemView(item, who, now, 50, place),
    names: who,
    now,
    ...can,
  });

describe("kinNextStep", () => {
  it("asks the owner to keep an agent's suggestion, and shows a teammate no buttons", () => {
    const item = task({ owner: finance, createdBy: finance, confirmed: false });
    expect(stepOf(item)).toMatchObject({
      kind: "suggested",
      who: { name: "Finance", avatar: { kind: "agent" } },
      line: "suggested this task",
      acts: [{ id: "keep" }, { id: "decline" }],
      note: null,
    });
    expect(
      stepOf({ ...item, can: readOnly }, asZoya, { change: false, give: false }),
    ).toMatchObject({
      kind: "suggested",
      acts: [],
      note: "Nothing needed from you yet.",
    });
  });

  it("says an agent is on it and that nothing is needed, with its latest update time", () => {
    const item = task({
      owner: chief,
      state: "doing",
      changes: [change({ seq: 3, by: chief, at: "2026-11-18T08:40:00.000Z" }), change({ seq: 2 })],
    });
    expect(stepOf(item)).toMatchObject({
      kind: "agent",
      who: { name: "Chief of staff" },
      line: "is on it",
      when: expect.stringMatching(/^updated /),
      words: null,
      note: "Nothing needed from you yet.",
      acts: [],
    });
    // Its latest note standing is its last word; someone else's, or a removed one, is not.
    const noted = {
      ...item,
      comments: [
        comment({ seq: 1, by: chief, body: "Drafted the first two texts." }),
        comment({ seq: 2, by: chief, body: "", removed: { at: item.createdAt, by: rhea } }),
        comment({ seq: 3, by: rhea, body: "Keep them short." }),
      ],
    };
    expect(stepOf(noted).words).toBe("Drafted the first two texts.");
  });

  it("puts a draft waiting in a chat first, opened where it is", () => {
    const waiting = {
      kind: "send" as const,
      chatId: KinChatId.make("chief-chat"),
      messageId: KinMessageId.make("card-message"),
      widgetId: KinWidgetId.make("card"),
      preview: "To clinic@example.invalid: New reminder texts",
      files: [],
      at: "2026-11-18T08:00:00.000Z",
    };
    const step = stepOf(task({ owner: rhea, waiting }));
    expect(step.waiting).toEqual(waiting);
    expect(step.acts.map((act) => [act.id, act.label])).toEqual([
      ["openWaiting", "Open the draft"],
      ["done", "Mark done"],
    ]);
    expect(stepOf(task({ waiting: { ...waiting, kind: "question" } })).acts[0]?.label).toBe(
      "Open the question",
    );
  });

  it("offers to hand late work held by someone else on, without a nudge the host can't send", () => {
    const item = task({ late: true, dueAt: "2026-11-15T23:59:59.000Z", dueAllDay: true });
    const step = stepOf(item);
    expect(step).toMatchObject({ kind: "late", who: { name: "Meera" }, note: null });
    expect(step.line).toMatch(/^has this\. It was due .+\.$/);
    expect(step.acts.map((act) => act.id)).toEqual(["give"]);
    expect(stepOf(item, names, { change: true, give: false }).acts).toEqual([]);
  });

  it("tells the giver a holder who is away hears of it when back, on that day", () => {
    expect(stepOf(task())).toMatchObject({ kind: "held", note: "Nothing needed from you yet." });
    expect(stepOf(task({ toldWhenBack: "2026-11-23" }))).toMatchObject({
      kind: "held",
      who: { name: "Meera" },
      line: "has this",
      note: "Meera is away until Mon Nov 23, so they'll be told when they're back.",
    });
  });

  it.each([
    // Waiting on the reader is theirs to do, never a pause: no "Waiting on you" anywhere.
    {
      who: "the person it waits on, who holds it",
      item: task({ owner: zoya, state: "waiting", waitingOn: zoya }),
      names: asZoya,
      chip: "Yours to do",
      step: { kind: "yours", line: "have this", note: "Yours to do." },
    },
    {
      who: "the person it waits on, who holds it, with the agent's reason and a brief",
      item: task({
        owner: zoya,
        state: "waiting",
        waitingOn: zoya,
        reason: "Needs your sign-off on the price",
        notes: "Send the quote to the clinic.",
      }),
      names: asZoya,
      chip: "Yours to do",
      step: {
        kind: "yours",
        words: "Send the quote to the clinic.",
        note: "Yours to do: Needs your sign-off on the price",
      },
    },
    {
      who: "the person it waits on, who doesn't hold it",
      item: task({ state: "waiting", waitingOn: zoya, can: readOnly }),
      names: asZoya,
      chip: "Yours to do",
      step: { kind: "held", line: "has this", note: "Yours to do." },
    },
    {
      who: "the person an agent's task waits on",
      item: task({ owner: chief, state: "waiting", waitingOn: zoya, can: readOnly }),
      names: asZoya,
      chip: "Yours to do",
      step: { kind: "agent", line: "is on it", note: "Yours to do." },
    },
    {
      who: "the person a late task waits on",
      item: task({
        state: "waiting",
        waitingOn: zoya,
        can: readOnly,
        late: true,
        dueAt: "2026-11-15T23:59:59.000Z",
        dueAllDay: true,
      }),
      names: asZoya,
      // Due the 15th, read the 18th: three calendar days, as Money counts days overdue.
      chip: "3 days late",
      step: { kind: "late", note: "Yours to do." },
    },
    {
      who: "a third person, on a task waiting on its own holder",
      item: task({ owner: zoya, state: "waiting", waitingOn: zoya }),
      names,
      chip: "Waiting on Zoya",
      step: { kind: "held", line: "has this", note: "Nothing needed from you yet." },
    },
    {
      who: "a third person, on a task waiting on someone else",
      item: task({ state: "waiting", waitingOn: zoya }),
      names,
      chip: "Waiting on Zoya",
      step: { kind: "held", line: "is waiting on Zoya", note: "Nothing needed from you yet." },
    },
  ])("on a waiting task, tells $who what it waits on, once", ({ item, names: who, chip, step }) => {
    const view = kinWorkItemView(item, who, now, 50, place);
    expect(kinRecordChip(item, view, who, now).label).toBe(chip);
    expect(
      stepOf(item, who, { change: item.can?.edit === true, give: item.can?.give === true }),
    ).toMatchObject(step);
  });

  it("offers Reopen on a done task, naming who finished it", () => {
    const item = task({
      state: "done",
      owner: zoya,
      closedAt: "2026-11-14T10:00:00.000Z",
      changes: [
        change({
          seq: 5,
          by: zoya,
          at: "2026-11-14T10:00:00.000Z",
          fields: [{ field: "state", from: "doing", to: "done" }],
        }),
      ],
    });
    expect(stepOf(item)).toMatchObject({
      kind: "closed",
      who: { name: "Zoya" },
      line: "finished this",
      acts: [{ id: "reopen", label: "Reopen" }],
    });
    expect(stepOf({ ...item, can: readOnly }, names, { change: true, give: true }).acts).toEqual(
      [],
    );
    // Its last note, whoever wrote it, is what it came to.
    const result = {
      ...item,
      comments: [comment({ seq: 1, by: meera, body: "Sent to the clinic." })],
    };
    expect(stepOf(result).words).toBe("Sent to the clinic.");
  });

  it("gives the holder Mark done and the way back to whoever gave it", () => {
    const item = task({ owner: rhea, assignedBy: meera, createdBy: meera });
    expect(stepOf(item)).toMatchObject({
      kind: "yours",
      acts: [{ id: "done" }, { id: "handBack", label: "Hand back to Meera" }],
    });
  });

  it("shows the holder the brief on top, and why it came only while there is no brief", () => {
    const why = task({ owner: rhea, reason: "Owner's ask; Dev leads the booking app" });
    expect(stepOf(why).words).toBe("Owner's ask; Dev leads the booking app");
    expect(stepOf({ ...why, notes: "Book two pilot clinics for the beta." }).words).toBe(
      "Book two pilot clinics for the beta.",
    );
  });

  it("quotes the words a task came back with", () => {
    const item = task({
      owner: rhea,
      handedBack: { by: meera, at: "2026-11-17T09:00:00.000Z" },
      reason: "The clinic wants to approve the wording first.",
    });
    expect(stepOf(item)).toMatchObject({
      kind: "handedBack",
      who: { name: "Meera" },
      line: "handed this back",
      acts: [{ id: "done" }, { id: "give" }],
    });
  });
});

describe("kinTaskWith", () => {
  it("offers x to whoever may change it, Leave to the reader, + until ten, and marks who is gone", () => {
    const people = (who: ReturnType<typeof kinTaskWith>) =>
      who.people.map((one) => [one.name, one.status, one.act]);
    const shown = kinTaskWith({
      item: { alsoOn: [zoya, rhea, finance] },
      names: { ...names, retired: new Set([finance.agentId]) },
      edit: true,
      change: true,
      joined: [rhea.personId, meera.personId],
    });
    expect(people(shown)).toEqual([
      ["Zoya", "No access", "remove"],
      ["You", null, "leave"],
      ["Finance", "Retired", "remove"],
    ]);
    expect([shown.add, shown.full]).toEqual([true, null]);
    // Someone who may not change the task reads it; Leave is still theirs.
    const reader = kinTaskWith({
      item: { alsoOn: [zoya, rhea] },
      names,
      edit: false,
      change: true,
    });
    expect(people(reader)).toEqual([
      ["Zoya", null, null],
      ["You", null, "leave"],
    ]);
    expect([reader.add, reader.full]).toEqual([false, null]);
    // Ten is all a task takes: + goes and one quiet line says why.
    const ten = Array.from({ length: 10 }, (_, index) => ({
      _tag: "person" as const,
      personId: KinPersonId.make(`ambermill-${index}`),
    }));
    const full = kinTaskWith({ item: { alsoOn: ten }, names, edit: true, change: true });
    expect([full.add, full.full]).toEqual([false, "10 are on it, the most a task takes."]);
    // The picker leaves out its holder and whoever is on it already.
    const row = (principal: typeof rhea | typeof meera | typeof chief) => ({
      key: principal._tag === "agent" ? principal.agentId : principal.personId,
      principal,
      name: "",
      avatar: { kind: "person" as const, seed: "" },
      current: false,
    });
    const choices = kinTaskWithChoices(
      { leads: [row(chief)], people: [row(rhea), row(meera)] },
      { owner: meera, alsoOn: [rhea] },
    );
    expect([...choices.leads, ...choices.people].map((one) => one.principal)).toEqual([chief]);
  });
});

describe("kinTaskPeopleRows", () => {
  const rows = (item: KinRecordDetail, who = names, give = true) => {
    const view = kinWorkItemView(item, who, now, 50, place);
    const shown = kinTaskWith({ item, names: who, edit: view.can.edit, change: true });
    return kinTaskPeopleRows({ item, view, names: who, give, with: shown });
  };
  it("opens the hand-over from Held by only for a reader who may give it", () => {
    expect(rows(task()).held).toMatchObject({ name: "Meera", opens: true });
    expect(rows(task({ owner: rhea })).held).toMatchObject({ name: "Rhea (you)", opens: true });
    expect(rows(task({ owner: chief })).held).toMatchObject({ name: "Chief of staff" });
    // A member who is not on it reads who has it, with nothing to press.
    expect(rows(task({ can: readOnly }), asZoya).held.opens).toBe(false);
    expect(rows(task(), names, false).held.opens).toBe(false);
    const retired = { ...names, retired: new Set([chief.agentId]) };
    expect(rows(task({ owner: chief }), retired).held.name).toBe("Chief of staff (retired)");
    // A company list's entry is given by the same rule: its holder or owner level, never a member.
    const entry = task({ key: "BK-3", list: KinListId.make("bookings"), owner: zoya });
    const held = (item: KinRecordDetail, who: KinWorkNames) =>
      kinRecordHeld({
        item,
        view: kinWorkItemView(item, who, now, 50, place),
        names: who,
        give: true,
      });
    expect(held(entry, asZoya)).toMatchObject({ name: "Zoya (you)", opens: true });
    expect(held({ ...entry, can: readOnly }, asZoya).opens).toBe(false);
  });

  it("says who else is on it, Add someone when nobody, and opens only what the reader may do", () => {
    expect(rows(task()).with).toEqual({ value: "Add someone", opens: "add" });
    expect(rows(task({ alsoOn: [zoya] })).with).toEqual({ value: "Zoya", opens: "menu" });
    expect(rows(task({ alsoOn: [zoya, chief] })).with?.value).toBe("Zoya and Chief of staff");
    expect(rows(task({ alsoOn: [zoya, chief, finance] })).with?.value).toBe("Zoya and 2 more");
    // A reader who may not change it: nobody on it says nothing; someone on it is plain text.
    expect(rows(task({ can: readOnly }), asZoya).with).toBeNull();
    expect(rows(task({ can: readOnly, alsoOn: [meera] }), asZoya).with).toEqual({
      value: "Meera",
      opens: null,
    });
    // On it themselves, they may still leave.
    expect(rows(task({ can: readOnly, alsoOn: [zoya] }), asZoya).with).toEqual({
      value: "You",
      opens: "menu",
    });
  });
});

describe("kinTaskOrigin", () => {
  it("says who asked and how it reached its holder, in one line", () => {
    // Rhea asked her chief of staff, who gave it to Meera.
    const throughAgent = task({
      changes: [
        change({
          seq: 2,
          by: chief,
          via: "lead",
          fields: [{ field: "owner", from: "agent:ambermill-chief", to: "person:ambermill-meera" }],
        }),
      ],
      assignedAt: "2026-11-17T09:00:00.000Z",
    });
    expect(kinTaskOrigin(throughAgent, names, now)).toBe(
      "Asked by you · given to Meera through Chief of staff · Nov 17",
    );
    expect(kinTaskOrigin(throughAgent, asZoya, now)).toBe(
      "Asked by Rhea · given to Meera through Chief of staff · Nov 17",
    );
    // An agent that gave it on its own is named as the giver.
    expect(kinTaskOrigin(task({ owner: zoya, assignedByAgent: chief.agentId }), names, now)).toBe(
      "Asked by you · Chief of staff gave it to Zoya · Nov 9",
    );
    // Someone else gave what another person asked for.
    expect(
      kinTaskOrigin(task({ owner: zoya, assignedBy: meera, askedBy: rhea.personId }), asZoya, now),
    ).toBe("Asked by Rhea · Meera gave it to you · Nov 9");
    // Your own task, made for yourself: only who asked.
    expect(kinTaskOrigin(task({ owner: rhea, assignedBy: null }), names, now)).toBe("Asked by you");
    // Handed back, it says so.
    expect(
      kinTaskOrigin(
        task({ owner: rhea, handedBack: { by: meera, at: "2026-11-17T09:00:00.000Z" } }),
        names,
        now,
      ),
    ).toBe("Asked by you · handed back by Meera · Nov 17");
    // An agent's own suggestion names no person.
    expect(
      kinTaskOrigin(task({ owner: chief, createdBy: chief, assignedBy: null }), names, now),
    ).toBeNull();
  });
});

describe("kinTaskControls", () => {
  const memberHolds: KinRecordCan = {
    ...readOnly,
    states: ["open", "waiting", "done", "dropped"],
    edit: true,
    give: true,
  };
  const controls = (
    item: KinRecordDetail,
    who: KinWorkNames,
    can: { change: boolean; give: boolean },
  ) => {
    const view = kinWorkItemView(item, who, now, 50, place);
    const step = kinNextStep({ item, view, names: who, now, ...can }).acts;
    return kinTaskControls({ view, ...can, step });
  };

  it.each([
    {
      who: "the owner, or a co-owner, on a teammate's task",
      item: task(),
      names,
      can: { change: true, give: true },
      page: { status: { done: true, reopen: false, states: true, waiting: true } },
      menu: { give: true, takeBack: true, handBack: false, drop: true },
    },
    {
      who: "a member holding a task the owner gave, whose card already offers Done",
      item: task({ owner: zoya, can: memberHolds }),
      names: asZoya,
      can: { change: true, give: true },
      page: { status: { done: false, reopen: false, states: true, waiting: true } },
      menu: { give: true, takeBack: false, handBack: true, drop: true },
    },
    {
      who: "a member who may only look",
      item: task({ can: readOnly }),
      names: asZoya,
      can: { change: true, give: true },
      page: { status: null },
      menu: { give: false, takeBack: false, handBack: false, drop: false },
    },
    {
      who: "a session without the right to change tasks",
      item: task(),
      names,
      can: { change: false, give: false },
      page: { status: null },
      menu: { give: false, takeBack: false, handBack: false, drop: false },
    },
    {
      who: "the owner on a done task, whose card already offers Reopen",
      item: task({
        state: "done",
        closedAt: "2026-11-14T10:00:00.000Z",
        can: { ...ownerCan, give: false, takeBack: false },
      }),
      names,
      can: { change: true, give: true },
      page: { status: null },
      menu: { give: false, takeBack: false, handBack: false, drop: false },
    },
  ])("puts status on the page and the rest in the menu for $who", (row) => {
    expect(controls(row.item, row.names, row.can)).toEqual({ page: row.page, menu: row.menu });
  });
});

describe("kinRecordChip", () => {
  const chipOf = (item: KinRecordDetail, who = names) =>
    kinRecordChip(item, kinWorkItemView(item, who, now, 50, place), who, now);

  it.each([
    [
      "counts whole days late",
      task({ late: true, dueAt: "2026-11-15T09:00:00.000Z" }),
      { tone: "late", label: "3 days late" },
    ],
    [
      "says late within the first day",
      task({ late: true, dueAt: "2026-11-18T08:00:00.000Z" }),
      { tone: "late", label: "Late" },
    ],
    [
      "waits on the owner for a suggestion",
      task({ owner: finance, createdBy: finance, confirmed: false }),
      { tone: "wait", label: "Waiting on you" },
    ],
    [
      "waits on the owner for a draft about an agent's task",
      task({
        owner: finance,
        waiting: {
          kind: "send",
          chatId: KinChatId.make("ambermill-chat"),
          messageId: KinMessageId.make("ambermill-message"),
          widgetId: KinWidgetId.make("ambermill-card"),
          preview: "To accounts@orbit.invalid: October invoice",
          files: [],
          at: "2026-11-18T08:00:00.000Z",
        },
      }),
      { tone: "wait", label: "Waiting on you" },
    ],
    [
      "shows an agent at work in progress",
      task({ owner: chief, working: true }),
      { tone: "doing", label: "In progress" },
    ],
    [
      "says done",
      task({ state: "done", closedAt: "2026-11-14T10:00:00.000Z" }),
      { tone: "done", label: "Done" },
    ],
  ] as const)("%s", (_name, item, expected) => {
    expect(chipOf(item)).toEqual(expected);
  });

  it("does not tell a teammate a suggestion waits on them", () => {
    const item = task({ owner: finance, createdBy: finance, confirmed: false, can: readOnly });
    expect(chipOf(item, asZoya).label).not.toBe("Waiting on you");
  });
});

describe("kinTaskActivity", () => {
  it("reads oldest first with the before and after of a due date and a brief", () => {
    const item = task({
      changes: [
        change({
          seq: 3,
          at: "2026-11-06T10:00:00.000Z",
          fields: [
            { field: "notes", from: "Send the welcome letter.", to: "Send it signed, as a PDF." },
          ],
        }),
        change({
          seq: 2,
          at: "2026-11-06T09:00:00.000Z",
          fields: [
            { field: "due", from: "2026-11-10T23:59:59.000Z", to: "2026-11-13T23:59:59.000Z" },
          ],
        }),
        change({ seq: 1, kind: "created", at: "2026-11-02T09:00:00.000Z" }),
      ],
    });
    const lines = kinTaskActivity(item, names, now);
    expect(lines.map((line) => [line.icon, line.who, line.text])).toEqual([
      ["made", "You", "added this"],
      ["due", "You", expect.stringMatching(/^set it due /)],
      ["brief", "You", "changed the brief"],
    ]);
    expect(lines[1]?.before).not.toBeNull();
    expect(lines[1]?.before).not.toBe(lines[1]?.after);
    expect(lines[2]).toMatchObject({
      before: "Send the welcome letter.",
      after: "Send it signed, as a PDF.",
    });
  });

  it("names a hand-over and leaves a line with nothing replaced plain", () => {
    const [line] = kinTaskActivity(
      task({
        changes: [
          change({
            seq: 4,
            by: meera,
            fields: [
              { field: "owner", from: "person:ambermill-meera", to: "person:ambermill-zoya" },
            ],
          }),
        ],
      }),
      names,
      now,
      "Zoya wrote the last campaign.",
    );
    expect(line).toMatchObject({
      icon: "gave",
      who: "Meera",
      text: "gave it to Zoya",
      before: null,
      after: null,
      via: null,
      quote: "Zoya wrote the last campaign.",
    });
  });

  it("names the person an agent acted for, and threads notes in among changes by time", () => {
    const lines = kinTaskActivity(
      task({
        changes: [
          change({
            seq: 2,
            by: chief,
            via: "lead",
            askedBy: meera.personId,
            at: "2026-11-10T10:00:00.000Z",
            fields: [
              { field: "owner", from: "person:ambermill-meera", to: "person:ambermill-zoya" },
            ],
          }),
          change({ seq: 1, kind: "created", at: "2026-11-10T08:00:00.000Z" }),
          // Kin took the default of a question nobody answered.
          change({
            seq: 3,
            by: chief,
            via: "lead",
            at: "2026-11-10T13:00:00.000Z",
            fields: [
              { field: "state", from: "open", to: "done" },
              { field: KIN_TAKEN_DEFAULT_FIELD, from: null, to: "q-1" },
            ],
          }),
          // A list's own field called "default" is an ordinary edit.
          change({
            seq: 4,
            by: chief,
            via: "lead",
            at: "2026-11-10T14:00:00.000Z",
            fields: [{ field: "default", from: null, to: "q-2" }],
          }),
          // Zoya dismissed the question it waited on her for, so it stopped waiting on her.
          change({
            seq: 6,
            by: zoya,
            at: "2026-11-10T16:00:00.000Z",
            fields: [
              { field: "state", from: "waiting", to: "open" },
              { field: KIN_DISMISSED_FIELD, from: null, to: "q-3" },
            ],
          }),
          // Zoya's coding agent started it and left a note, through her key.
          change({
            seq: 5,
            by: zoya,
            codingAgent: "Work laptop",
            at: "2026-11-10T15:00:00.000Z",
            fields: [{ field: "state", from: "open", to: "doing" }],
          }),
        ],
        comments: [
          comment({ seq: 1, by: zoya, at: "2026-11-10T09:00:00.000Z", body: "On it." }),
          comment({
            seq: 2,
            at: "2026-11-10T11:00:00.000Z",
            body: "",
            removed: { at: "2026-11-10T12:00:00.000Z", by: rhea },
          }),
          comment({
            seq: 3,
            by: zoya,
            codingAgent: "Work laptop",
            at: "2026-11-10T15:00:00.000Z",
            body: "Logo draft checked.",
          }),
          // Meera reads another teammate's key by the server's generic name; a key named "Kin" is quoted.
          comment({
            seq: 4,
            by: zoya,
            codingAgent: KIN_CODING_AGENT_UNNAMED,
            at: "2026-11-10T16:00:00.000Z",
            body: "Logo exported.",
          }),
          comment({
            seq: 5,
            by: zoya,
            codingAgent: "Kin",
            at: "2026-11-10T17:00:00.000Z",
            body: "Done here.",
          }),
        ],
      }),
      names,
      now,
    );
    expect(lines.map((line) => [line.icon, line.who, line.text, line.via])).toEqual([
      ["made", "You", "added this", null],
      ["comment", "Zoya", "", null],
      ["gave", "Meera", "gave it to Zoya", "Chief of staff"],
      ["comment", "You", "removed this note", null],
      ["state", "Chief of staff", "went with the default: finished it (nobody answered)", null],
      ["change", "Chief of staff", "updated it", null],
      ["state", "Zoya", "started on it", "coding agent “Work laptop”"],
      ["comment", "Zoya", "", "coding agent “Work laptop”"],
      ["state", "Zoya", "dismissed the question without choosing", null],
      ["comment", "Zoya", "", "a coding agent"],
      ["comment", "Zoya", "", "coding agent “Kin”"],
    ]);
    expect(lines[1]?.comment).toMatchObject({ body: "On it.", removed: false });
  });
});

describe("kinRecordAskedBy and kinBriefBy", () => {
  it("names the person who asked, never the agent that wrote it down", () => {
    expect(kinRecordAskedBy({ createdBy: meera, assignedBy: rhea })).toEqual(meera);
    expect(kinRecordAskedBy({ createdBy: finance, assignedBy: rhea })).toEqual(rhea);
    expect(kinRecordAskedBy({ createdBy: finance, assignedBy: null })).toBeNull();
    // The asker the host stored wins over both stand-ins.
    expect(
      kinRecordAskedBy({ createdBy: finance, assignedBy: rhea, askedBy: zoya.personId }),
    ).toEqual(zoya);
  });

  it("credits the brief to whoever last wrote it, and has no line without one", () => {
    expect(kinBriefBy(task(), names, now)).toBeNull();
    const item = task({
      notes: "Find a printer under €1,500.",
      changes: [change({ seq: 2, by: meera, fields: [{ field: "notes", from: "", to: "x" }] })],
    });
    expect(kinBriefBy(item, names, now)?.name).toBe("Meera");
    expect(kinBriefBy({ ...item, changes: [] }, names, now)?.name).toBe("You");
  });
});
