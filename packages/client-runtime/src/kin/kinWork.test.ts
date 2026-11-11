// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import {
  KinAgentId,
  KinChatError,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type KinRecord,
  type KinRecordDetail,
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
  kinWorkItemView,
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
    ["week", { open: true, dueBy: "2026-11-18T08:00:00.000Z" }],
    ["closed", { open: false }],
  ] as const)("asks the host for the %s view", (view, expected) => {
    expect(kinWorkListQuery(orgId, { view, owner: null, text: "" }, now.getTime())).toEqual({
      orgId,
      ...expected,
    });
  });

  it("adds whose it is and the words searched for, trimmed", () => {
    expect(
      kinWorkListQuery(orgId, { view: "open", owner: lead, text: "  quote " }, now.getTime()),
    ).toEqual({ orgId, open: true, owner: lead, text: "quote" });
  });

  it("leaves what is already late out of due this week, as the count does", () => {
    const rows = [record({ key: "W-1", late: true }), record({ key: "W-2" })];
    expect(
      kinWorkShown({ ...KIN_WORK_DEFAULT_FILTER, view: "week" }, rows).map((row) => row.key),
    ).toEqual(["W-2"]);
    expect(kinWorkShown(KIN_WORK_DEFAULT_FILTER, rows)).toHaveLength(2);
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
        live: AsyncResult.success({ seq: 4, summary: null, failed: true }),
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
    );
    expect(view.links.map((held) => [held.label, held.open?.type ?? null])).toEqual([
      ["PR #12 merged", "url"],
    ]);
  });
});

describe("kinWorkRow", () => {
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
