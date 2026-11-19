// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import {
  EnvironmentId,
  KinAgentId,
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
    editing = false,
  ) => kinTaskControls({ view: kinWorkItemView(item, who, now, 50, place), ...can, editing });

  it.each([
    {
      who: "the owner, or a co-owner, on a teammate's task",
      item: task(),
      names,
      can: { change: true, give: true },
      page: { status: { done: true, reopen: false, states: true, waiting: true }, edit: true },
      menu: { give: true, takeBack: true, handBack: false, drop: true },
    },
    {
      who: "a member holding a task the owner gave",
      item: task({ owner: zoya, can: memberHolds }),
      names: asZoya,
      can: { change: true, give: true },
      page: { status: { done: true, reopen: false, states: true, waiting: true }, edit: true },
      menu: { give: true, takeBack: false, handBack: true, drop: true },
    },
    {
      who: "a member who may only look",
      item: task({ can: readOnly }),
      names: asZoya,
      can: { change: true, give: true },
      page: { status: null, edit: false },
      menu: { give: false, takeBack: false, handBack: false, drop: false },
    },
    {
      who: "a session without the right to change tasks",
      item: task(),
      names,
      can: { change: false, give: false },
      page: { status: null, edit: false },
      menu: { give: false, takeBack: false, handBack: false, drop: false },
    },
    {
      who: "the owner on a done task",
      item: task({
        state: "done",
        closedAt: "2026-11-14T10:00:00.000Z",
        can: { ...ownerCan, give: false, takeBack: false },
      }),
      names,
      can: { change: true, give: true },
      page: { status: { done: false, reopen: true, states: false, waiting: false }, edit: true },
      menu: { give: false, takeBack: false, handBack: false, drop: false },
    },
  ])("puts status and edit on the page and the rest in the menu for $who", (row) => {
    expect(controls(row.item, row.names, row.can)).toEqual({ page: row.page, menu: row.menu });
  });

  it("hides the page's edit while the title and brief are open", () => {
    expect(controls(task(), names, { change: true, give: true }, true).page.edit).toBe(false);
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
    );
    expect(line).toMatchObject({
      icon: "gave",
      who: "Meera",
      text: "gave it to Zoya",
      before: null,
      after: null,
      via: null,
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
        ],
        comments: [
          comment({ seq: 1, by: zoya, at: "2026-11-10T09:00:00.000Z", body: "On it." }),
          comment({
            seq: 2,
            at: "2026-11-10T11:00:00.000Z",
            body: "",
            removed: { at: "2026-11-10T12:00:00.000Z", by: rhea },
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
