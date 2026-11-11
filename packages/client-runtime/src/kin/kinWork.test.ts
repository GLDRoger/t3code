// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import {
  KinAgentId,
  KinChatError,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type KinRecord,
  type KinRecordDetail,
  EnvironmentId,
  ThreadId,
  type KinWorkAssignInput,
  type KinWorkSummary,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { AtomCommandResult } from "../state/runtime.ts";
import {
  KIN_WORK_CHANGED,
  KIN_WORK_DEFAULT_FILTER,
  createKinWorkActions,
  kinWorkDraftCheck,
  kinWorkHostEdits,
  kinWorkItemView,
  kinWorkListFooter,
  kinWorkListQuery,
  kinWorkOverview,
  kinWorkRow,
  kinWorkScreenState,
  kinWorkShown,
  type KinWorkNames,
} from "./kinWork.ts";

const orgId = KinOrgId.make("invented-org");
const me = { _tag: "person", personId: KinPersonId.make("invented-owner") } as const;
const priya = { _tag: "person", personId: KinPersonId.make("invented-priya") } as const;
const lead = { _tag: "agent", agentId: KinAgentId.make("invented-lead") } as const;
const names: KinWorkNames = {
  people: new Map([
    [me.personId, "Invented Owner"],
    [priya.personId, "Priya"],
  ]),
  agents: new Map([[lead.agentId, "Tech lead"]]),
  me: me.personId,
  zone: "UTC",
};
const now = new Date("2026-11-11T08:00:00.000Z");
const hostEnvironment = EnvironmentId.make("invented-host");
const place = {
  environmentId: hostEnvironment,
  isKnownEnvironment: (environmentId: EnvironmentId) => environmentId === hostEnvironment,
};
const record = (patch: Partial<KinRecord> = {}): KinRecord => ({
  recordId: KinRecordId.make("rec-1"),
  orgId,
  key: "W-1",
  title: "Send the invented quote",
  state: "open",
  waitingOn: null,
  owner: me,
  category: null,
  side: "ours",
  dueAt: null,
  dueAllDay: false,
  late: false,
  confirmed: true,
  sensitive: false,
  working: false,
  pullRequest: null,
  rev: 3,
  createdAt: "2026-11-10T08:00:00.000Z",
  updatedAt: "2026-11-10T08:00:00.000Z",
  closedAt: null,
  ...patch,
});
const detail = (patch: Partial<KinRecordDetail> = {}): KinRecordDetail => ({
  ...record(),
  notes: "",
  source: { chatId: null, messageId: null },
  assignedBy: null,
  assignedAt: null,
  createdBy: me,
  links: [],
  changes: [],
  ...patch,
});

describe("kinWorkListQuery", () => {
  it.each([
    ["open", { open: true }],
    ["doing", { states: ["doing"] }],
    ["waiting", { states: ["waiting"] }],
    ["late", { late: true }],
    ["week", { open: true, dueBy: "2026-11-18T08:00:00.000Z", late: false }],
    ["closed", { open: false }],
  ] as const)("asks the host for the %s view", (view, expected) => {
    expect(kinWorkListQuery(orgId, { view, owner: null, text: "" }, now.getTime(), true)).toEqual({
      orgId,
      ...expected,
    });
  });

  it("adds whose it is and the words searched for, trimmed", () => {
    expect(
      kinWorkListQuery(orgId, { view: "open", owner: lead, text: "  quote " }, now.getTime(), true),
    ).toEqual({ orgId, open: true, owner: lead, text: "quote" });
  });

  it("hides what is late from due this week only for a host that can't leave it out itself", () => {
    const week = { ...KIN_WORK_DEFAULT_FILTER, view: "week" } as const;
    const rows = [record({ key: "W-1", late: true }), record({ key: "W-2" })];
    expect(kinWorkListQuery(orgId, week, now.getTime(), false)).not.toHaveProperty("late");
    expect(kinWorkShown(week, rows, false).map((row) => row.key)).toEqual(["W-2"]);
    // A host that filters sends whole pages, so nothing it sent is hidden and its total is right.
    expect(kinWorkShown(week, rows, true)).toHaveLength(2);
    expect(kinWorkListFooter(week, 50, 132, true, true)).toBe("Showing 50 of 132");
    expect(kinWorkListFooter(week, 50, 132, true, false)).toBe("Showing the first 50");
  });
});

describe("kinWorkOverview", () => {
  const summary: KinWorkSummary = {
    open: 7,
    doing: 2,
    waiting: 1,
    late: 3,
    dueThisWeek: 4,
    owners: [
      { owner: lead, open: 5, doing: 2, waiting: 0, late: 3, dueThisWeek: 1 },
      { owner: me, open: 2, doing: 0, waiting: 1, late: 0, dueThisWeek: 3 },
    ],
    seq: 9,
    asOf: now.toISOString(),
  };
  const counts = (filter = KIN_WORK_DEFAULT_FILTER) =>
    Object.fromEntries(
      kinWorkOverview(summary, filter, names).chips.map((chip) => [chip.id, chip.count]),
    );

  it("counts everyone's work, then one owner's once they are picked", () => {
    expect(counts()).toEqual({ open: 7, doing: 2, waiting: 1, late: 3, week: 4, closed: null });
    expect(kinWorkHostEdits(summary)).toBe(false);
    const newer = { ...summary, closed: 12 };
    expect(kinWorkHostEdits(newer)).toBe(true);
    expect(kinWorkOverview(newer, KIN_WORK_DEFAULT_FILTER, names).chips.at(-1)).toMatchObject({
      id: "closed",
      count: 12,
    });
    expect(counts({ ...KIN_WORK_DEFAULT_FILTER, owner: me })).toMatchObject({ open: 2, late: 0 });
    // Someone with nothing open isn't in the host's list at all.
    expect(counts({ ...KIN_WORK_DEFAULT_FILTER, owner: priya })).toMatchObject({ open: 0 });
  });

  it("names each owner with what stands out about their work", () => {
    expect(
      kinWorkOverview(summary, KIN_WORK_DEFAULT_FILTER, names).owners.map(
        (owner) => `${owner.name}: ${owner.line}`,
      ),
    ).toEqual(["Tech lead: 5 open · 3 late", "You: 2 open · 1 waiting"]);
  });
});

describe("kinWorkScreenState", () => {
  type Input = Parameters<typeof kinWorkScreenState>[0];
  const refusal: Input["live"] = AsyncResult.failure(
    Cause.fail(new KinChatError({ reason: "not_allowed", message: "Only the owner." })),
  );
  const cases: ReadonlyArray<readonly [string, Input, string]> = [
    [
      "a session without the scope",
      { allowed: false, connected: true, live: AsyncResult.initial() },
      "refused",
    ],
    [
      "a host that refuses the viewer",
      { allowed: true, connected: true, live: refusal },
      "refused",
    ],
    [
      "nothing read and no connection",
      { allowed: true, connected: false, live: AsyncResult.initial() },
      "offline",
    ],
    [
      "nothing read yet",
      { allowed: true, connected: true, live: AsyncResult.initial() },
      "loading",
    ],
    [
      "counts that couldn't be read",
      {
        allowed: true,
        connected: true,
        live: AsyncResult.success({
          seq: 4,
          summary: null,
          failed: true,
          changed: {},
          unnamed: 0,
        }),
      },
      "failed",
    ],
  ];
  it.each(cases)("shows %s as %s", (_name, input, tag) => {
    expect(kinWorkScreenState(input)._tag).toBe(tag);
  });
});

describe("kinWorkItemView", () => {
  it("tells the history in words, leaving bookkeeping out", () => {
    const at = "2026-11-10T09:00:00.000Z";
    const view = kinWorkItemView(
      detail({
        owner: lead,
        changes: [
          {
            seq: 4,
            at,
            by: lead,
            via: "lead",
            kind: "updated",
            fields: [
              { field: "state", from: "doing", to: "waiting" },
              { field: "waitingOn", from: null, to: `person:${priya.personId}` },
            ],
          },
          {
            seq: 3,
            at,
            by: me,
            via: "owner",
            kind: "updated",
            fields: [
              { field: "owner", from: `person:${me.personId}`, to: `agent:${lead.agentId}` },
            ],
          },
          {
            seq: 2,
            at,
            by: lead,
            via: "lead",
            kind: "updated",
            fields: [{ field: "sensitive", from: "false", to: "true" }],
          },
          { seq: 1, at, by: me, via: "owner", kind: "created", fields: [] },
        ],
      }),
      names,
      now,
      50,
      place,
    );
    expect(view.history.map((line) => line.text)).toEqual([
      "Tech lead marked it waiting on Priya",
      "You gave it to Tech lead",
      "Tech lead updated it",
      "You added this",
    ]);
  });

  it("opens web links and source chats only, and keeps the latest word on a pull request", () => {
    const link = { relation: "relates", chatId: null, createdAt: now.toISOString() } as const;
    const view = kinWorkItemView(
      detail({
        links: [
          { ...link, kind: "pull_request", target: "https://example.test/pr/12", label: "PR #12" },
          { ...link, kind: "url", target: "javascript:alert(1)", label: "Invented" },
          {
            ...link,
            kind: "pull_request",
            target: "https://example.test/pr/12",
            label: "PR #12 merged",
          },
        ],
      }),
      names,
      now,
      50,
      place,
    );
    expect(view.links.map((held) => [held.label, held.open?.type ?? null])).toEqual([
      ["PR #12 merged", "url"],
    ]);
  });
});

describe("a task on an older host", () => {
  const suggested = detail({ owner: lead, confirmed: false, createdBy: lead });

  it("offers no changes, and sends a suggestion's answer to chat", () => {
    const view = kinWorkItemView(suggested, names, now, 50, place);
    expect(view).toMatchObject({ editable: false, suggestion: "Tech lead suggested this task." });
    expect(view.remarks.join(" ")).toContain("Tell it in chat");
  });

  it("offers them on a host that sends a task's own change number", () => {
    const view = kinWorkItemView({ ...suggested, seq: 9 }, names, now, 50, place);
    expect(view).toMatchObject({ editable: true, takeBack: true });
    expect(view.remarks).toEqual([]);
    expect(view.leadNote).toContain("tells Tech lead to stop");
  });
});

describe("links to other tasks and to a lead's work", () => {
  const link = {
    relation: "relates",
    chatId: null,
    label: null,
    createdAt: now.toISOString(),
  } as const;
  const worker = (remoteEnvironmentId: EnvironmentId | null) =>
    ({
      ...link,
      kind: "worker",
      relation: "attempt",
      target: `run-${remoteEnvironmentId ?? "host"}`,
      worker: {
        threadId: ThreadId.make("invented-thread"),
        remoteEnvironmentId,
        running: false,
        pullRequest: { url: "https://github.com/invented/repo/pull/7", number: 7 },
      },
    }) as const;

  it("opens a related task by its key, and only names one an older host can't place", () => {
    const view = kinWorkItemView(
      detail({
        links: [
          {
            ...link,
            kind: "record",
            target: "rec-2",
            record: { recordId: KinRecordId.make("rec-2"), key: "W-2", title: "Invented other" },
          },
          { ...link, kind: "record", target: "rec-3", label: "W-3" },
        ],
      }),
      names,
      now,
      50,
      place,
    );
    expect(view.links.map((held) => [held.label, held.open])).toEqual([
      ["Invented other", { type: "task", key: "W-2" }],
      ["W-3", null],
    ]);
  });

  it("opens a lead's pull request, and its thread only where this device knows the way", () => {
    const view = kinWorkItemView(
      detail({ links: [worker(null), worker(EnvironmentId.make("invented-elsewhere"))] }),
      names,
      now,
      50,
      place,
    );
    expect(view.links.map((held) => [held.open?.type, held.thread])).toEqual([
      ["url", { environmentId: hostEnvironment, threadId: "invented-thread" }],
      ["url", null],
    ]);
  });
});

describe("kinWorkRow", () => {
  it("offers one tap only where it changes nothing but the task", () => {
    const tick = (patch: Partial<KinRecord>) => kinWorkRow(record(patch), names, now).tick;
    expect(tick({})).toBe("done");
    expect(tick({ state: "done" })).toBe("reopen");
    // Finishing a lead's task tells it to stop, and a suggestion wants a yes or no first.
    expect(tick({ owner: lead })).toBeNull();
    expect(tick({ confirmed: false })).toBeNull();
  });

  it("shows an all-day due date as the owner's calendar day, wherever it is read", () => {
    const due = record({ dueAt: "2026-11-20T23:59:59.999Z", dueAllDay: true });
    const far = { ...names, zone: "Pacific/Kiritimati" };
    expect(kinWorkRow(due, names, now).due).toContain("20");
    expect(kinWorkRow(due, far, now).due).toContain("21");
  });
});

describe("kinWorkDraftCheck", () => {
  it("sends a picked day as an all-day date and leaves out what was left blank", () => {
    expect(
      kinWorkDraftCheck({ title: "  Send the quote ", owner: lead, due: "2026-11-14", notes: " " }),
    ).toEqual({
      ok: true,
      input: { title: "Send the quote", owner: lead, dueAt: "2026-11-14", dueAllDay: true },
    });
    expect(kinWorkDraftCheck({ title: " ", owner: null, due: null, notes: "" }).ok).toBe(false);
  });
});

describe("createKinWorkActions", () => {
  const actions = (answer: AtomCommandResult<KinRecordDetail, unknown>) => {
    const sent: Array<KinWorkAssignInput> = [];
    const reread: Array<string> = [];
    const made = createKinWorkActions({
      orgId,
      create: async () => answer,
      assign: async (input) => {
        sent.push(input);
        return answer;
      },
      reread: (key) => reread.push(key),
    });
    return { made, sent, reread };
  };

  it("gives a task as the owner saw it", async () => {
    const h = actions(AsyncResult.success(detail({ owner: lead, rev: 4 })));
    const outcome = await h.made.give({ key: "W-1", rev: 3 }, lead);
    expect(h.sent).toEqual([{ orgId, key: "W-1", to: lead, rev: 3 }]);
    expect(outcome).toMatchObject({ ok: true, item: { rev: 4 } });
    expect(h.reread).toEqual([]);
  });

  it("reads the task again and says why when it changed since", async () => {
    const h = actions(
      AsyncResult.failure(
        Cause.fail(
          new KinChatError({
            reason: "conflict",
            message: "W-1 changed since you read it; it is at revision 5 now. Read it again.",
          }),
        ),
      ),
    );
    expect(await h.made.give({ key: "W-1", rev: 3 }, lead)).toEqual({
      ok: false,
      problem: KIN_WORK_CHANGED,
      changed: true,
    });
    expect(h.reread).toEqual(["W-1"]);
  });

  it("keeps the host's internals out of any other refusal", async () => {
    const h = actions(
      AsyncResult.failure(
        Cause.fail(new KinChatError({ reason: "invalid_state", message: "dueAt is not a time." })),
      ),
    );
    const outcome = await h.made.add({ title: "Invented" }, "request-1");
    expect(outcome).toMatchObject({ ok: false, changed: false });
    expect(outcome.ok ? "" : outcome.problem).not.toContain("dueAt");
  });
});
