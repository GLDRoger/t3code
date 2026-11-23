// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import {
  KinAgentId,
  KinChatError,
  KinListId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type KinRecord,
  type KinRecordDetail,
  EnvironmentId,
  ThreadId,
  type KinWorkAssignInput,
  type KinWorkSummary,
  KIN_LEFT_FIELD,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { AtomCommandResult } from "../state/runtime.ts";
import {
  KIN_WORK_DEFAULT_FILTER,
  KIN_WORK_NO_DRAFT,
  KIN_WORK_TITLE_TOO_LONG,
  kinWorkDueChoices,
  kinWorkDueDays,
  kinWorkDueLabel,
  kinWorkDueText,
  kinWorkTitleCount,
  createKinWorkActions,
  kinWorkDraftCheck,
  kinWorkHostClients,
  kinWorkAssignees,
  kinWorkAudience,
  kinWorkNameOfText,
  kinWorkAudienceMove,
  kinWorkHostEdits,
  kinWorkClientStays,
  kinWorkAnswerKept,
  kinWorkAnswerOf,
  kinWorkItemState,
  kinWorkItemView,
  kinWorkListFooter,
  kinWorkListQuery,
  kinWorkOverview,
  kinWorkRow,
  kinWorkRowMarked,
  kinWorkOffline,
  kinWorkOnlyOwner,
  kinWorkScreenState,
  kinWorkShown,
  kinWorkStaleNotice,
  KIN_WORK_REFRESH_FAILED,
  KIN_WORK_STALE,
  type KinWorkNames,
} from "./kinWork.ts";
import { KIN_CHANGED } from "./kinAnswers.ts";
import { kinDatesAgenda } from "./kinDates.ts";

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

describe("kinWorkName", () => {
  const names = {
    people: new Map([
      ["p-me", "Rhea"],
      ["p-zoya", "Zoya"],
    ]),
    agents: new Map([["a-fin", "Finance"]]),
    me: KinPersonId.make("p-me"),
  };
  it.each([
    ["yourself", "person:p-me", "You"],
    ["a teammate", "person:p-zoya", "Zoya"],
    ["an agent, by name", "agent:a-fin", "Finance"],
    ["an unlisted teammate", "person:p-gone", "A teammate"],
    ["an unlisted agent, never by id", "agent:a-gone", "An agent"],
  ])("names %s", (_, text, expected) => {
    expect(kinWorkNameOfText(text, names)).toBe(expected);
  });

  it("leaves text that names nobody", () => {
    expect(kinWorkNameOfText("next week", names)).toBeNull();
  });
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
    expect(
      kinWorkListQuery(orgId, { ...KIN_WORK_DEFAULT_FILTER, view }, now.getTime(), true),
    ).toEqual({ orgId, ...expected });
  });

  it("adds whose it is and the words searched for, trimmed", () => {
    expect(
      kinWorkListQuery(
        orgId,
        { ...KIN_WORK_DEFAULT_FILTER, owner: lead, text: "  quote " },
        now.getTime(),
        true,
      ),
    ).toEqual({ orgId, open: true, owner: lead, text: "quote" });
    expect(
      kinWorkListQuery(
        orgId,
        {
          ...KIN_WORK_DEFAULT_FILTER,
          party: { key: "C-1", title: "Invented Foods" },
          project: { key: "P-2", title: "Invented relaunch" },
        },
        now.getTime(),
        true,
      ),
    ).toEqual({ orgId, open: true, party: "C-1", project: "P-2" });
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
  const held = (failed = false): Input["live"] =>
    AsyncResult.success({
      seq: 4,
      summary: failed ? null : ({} as never),
      failed,
      changed: {},
      unnamed: 0,
      lists: {},
      unlisted: 0,
      rows: null,
    });
  const cases: ReadonlyArray<readonly [string, Input, string]> = [
    [
      "a session whose scopes are known and lack it",
      { allowed: "refused", link: "connected", live: AsyncResult.initial() },
      "refused",
    ],
    [
      "a host that refuses the viewer",
      { allowed: "granted", link: "connected", live: refusal },
      "refused",
    ],
    [
      "scopes not known while the first connection is under way",
      { allowed: "unknown", link: "connecting", live: AsyncResult.initial() },
      "loading",
    ],
    [
      "scopes not known yet on a live connection",
      { allowed: "unknown", link: "connected", live: AsyncResult.initial() },
      "loading",
    ],
    [
      "scopes not known and the connection failed",
      { allowed: "unknown", link: "offline", live: AsyncResult.initial() },
      "offline",
    ],
    [
      "nothing read and no connection",
      { allowed: "granted", link: "offline", live: AsyncResult.initial() },
      "offline",
    ],
    [
      "nothing read while connecting",
      { allowed: "granted", link: "connecting", live: AsyncResult.initial() },
      "loading",
    ],
    [
      "nothing read yet",
      { allowed: "granted", link: "connected", live: AsyncResult.initial() },
      "loading",
    ],
    [
      "scopes whose read failed on a live connection",
      { allowed: "failed", link: "connected", live: AsyncResult.initial() },
      "failed",
    ],
    [
      "scopes whose read failed and no connection",
      { allowed: "failed", link: "offline", live: AsyncResult.initial() },
      "offline",
    ],
    [
      "counts that couldn't be read",
      { allowed: "granted", link: "connected", live: held(true) },
      "failed",
    ],
  ];
  it.each(cases)("shows %s as %s", (_name, input, tag) => {
    expect(kinWorkScreenState(input)._tag).toBe(tag);
  });

  it.each([
    ["connecting", false],
    ["connected", false],
    ["offline", true],
  ] as const)("calls a held page stale when the link is %s: %s", (link, stale) => {
    expect(kinWorkScreenState({ allowed: "granted", link, live: held() })).toMatchObject({
      _tag: "ready",
      stale,
    });
  });
});

describe("kinWorkStaleNotice", () => {
  it.each([
    ["offline", { message: KIN_WORK_STALE, retry: false }],
    ["connected", { message: KIN_WORK_REFRESH_FAILED, retry: true }],
    ["connecting", null],
  ] as const)("on a held page that is behind, with the link %s, says %j", (link, notice) => {
    expect(kinWorkStaleNotice(link)).toEqual(notice);
  });

  it("offline, says when the rows shown were last read, as a chat's offline line does", () => {
    const readAt = Date.parse("2026-11-11T08:00:00.000Z");
    expect(kinWorkStaleNotice("offline", readAt, (date) => date.toISOString())).toEqual({
      message: "Offline. Last updated 2026-11-11T08:00:00.000Z.",
      retry: false,
    });
  });
});

describe("kinWorkOnlyOwner", () => {
  it.each([
    ["tasks", "Tasks are"],
    ["money", "Money is"],
    ["clients", "Clients come"],
    ["docs", "Docs are"],
  ] as const)("names %s, the page it is on", (place, starts) => {
    if (place !== "clients") expect(kinWorkOnlyOwner(place).detail.startsWith(starts)).toBe(true);
    expect(kinWorkOffline(place).detail.startsWith(starts.split(" ")[0]!)).toBe(true);
  });

  it("tells a teammate Clients is switched off for them, as the client page does", () => {
    expect(kinWorkOnlyOwner("clients")).toEqual({
      title: "Clients isn't on for you",
      detail: "The owner or a co-owner decides who sees Clients.",
    });
  });
});

describe("kinWorkItemView", () => {
  it("tells the history in words, leaving bookkeeping out", () => {
    const at = "2026-11-10T09:00:00.000Z";
    const view = kinWorkItemView(
      detail({
        owner: lead,
        reason: "You know the auth flow best",
        changes: [
          {
            seq: 8,
            at,
            by: priya,
            via: "owner",
            kind: "updated",
            fields: [{ field: "alsoOn", from: `person:${me.personId}`, to: null }],
          },
          {
            seq: 7,
            at,
            by: priya,
            via: "owner",
            kind: "updated",
            fields: [
              {
                field: "alsoOn",
                from: `agent:${lead.agentId}, person:${priya.personId}`,
                to: `agent:${lead.agentId}`,
              },
            ],
          },
          {
            seq: 6.5,
            at,
            by: priya,
            via: "owner",
            kind: "updated",
            fields: [{ field: "alsoOn", from: null, to: `person:${priya.personId}` }],
          },
          {
            seq: 6,
            at,
            by: priya,
            via: "owner",
            kind: "updated",
            fields: [
              {
                field: "alsoOn",
                from: null,
                to: `agent:${lead.agentId}, person:${me.personId}`,
              },
            ],
          },
          {
            seq: 5,
            at,
            by: priya,
            via: "owner",
            kind: "updated",
            fields: [
              { field: "owner", from: `person:${priya.personId}`, to: `agent:${lead.agentId}` },
              { field: "handedBack", from: `person:${priya.personId}`, to: "On the release" },
            ],
          },
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
            fields: [{ field: "dueAllDay", from: "false", to: "true" }],
          },
          {
            seq: 1.8,
            at,
            by: lead,
            via: "lead",
            kind: "updated",
            fields: [{ field: "untold", from: `person:${priya.personId}`, to: null }],
          },
          {
            seq: 1.7,
            at,
            by: lead,
            via: "lead",
            kind: "updated",
            fields: [
              { field: "owner", from: `person:${me.personId}`, to: `person:${priya.personId}` },
              { field: "untold", from: null, to: `person:${priya.personId}` },
            ],
          },
          {
            seq: 1.6,
            at,
            by: me,
            via: "owner",
            kind: "updated",
            fields: [
              { field: "owner", from: `agent:${lead.agentId}`, to: `person:${priya.personId}` },
              { field: "alsoOn", from: `person:${priya.personId}`, to: null },
            ],
          },
          {
            seq: 1.5,
            at,
            by: me,
            via: "owner",
            kind: "updated",
            fields: [{ field: "repeat", from: null, to: "every month" }],
          },
          { seq: 1, at, by: me, via: "owner", kind: "created", fields: [] },
        ],
      }),
      names,
      now,
      50,
      place,
    );
    expect(view.given).toMatch(/^Priya handed this back · /);
    expect(view.reason).toBe("On the release");
    expect(view.history.map((line) => line.text)).toEqual([
      "Priya took you off it",
      "Priya left it",
      "Priya joined it",
      "Priya put Tech lead and you on it",
      "Priya handed it back to Tech lead: “On the release”",
      "Tech lead marked it waiting on Priya",
      "You gave it to Tech lead",
      "Tech lead updated it",
      "Tech lead told Priya",
      "Tech lead gave it to Priya, not told yet",
      "You gave it to Priya",
      "You set it to repeat every month",
      "You added this",
    ]);
  });

  it("names who asked as the giver, via the agent, and says whose access moved", () => {
    const at = "2026-11-10T09:00:00.000Z";
    const view = kinWorkItemView(
      detail({
        owner: me,
        createdBy: lead,
        assignedBy: priya,
        assignedAt: at,
        changes: [
          {
            seq: 3,
            at,
            by: priya,
            via: "owner",
            kind: "updated",
            fields: [{ field: "accessBack", from: `person:${me.personId}`, to: null }],
          },
          {
            seq: 2,
            at,
            by: me,
            via: "owner",
            kind: "updated",
            fields: [{ field: "accessRemoved", from: `person:${priya.personId}`, to: null }],
          },
          {
            seq: 1,
            at,
            by: lead,
            via: "lead",
            kind: "updated",
            fields: [{ field: "owner", from: null, to: `person:${me.personId}` }],
          },
          {
            seq: 0.5,
            at,
            by: lead,
            via: "lead",
            kind: "updated",
            fields: [
              { field: "owner", from: `person:${priya.personId}`, to: `person:${me.personId}` },
              { field: KIN_LEFT_FIELD, from: `person:${priya.personId}`, to: null },
            ],
          },
        ],
      }),
      names,
      now,
      50,
      place,
    );
    expect(view.given).toMatch(/^Priya gave this to you, via Tech lead · /);
    expect(view.history.map((line) => line.text).slice(0, 2)).toEqual([
      "Priya came back; it's theirs again",
      "You removed Priya's access; it stays with them",
    ]);
    expect(view.history.at(-1)?.text).toBe("Tech lead gave it to you (Priya left)");
  });

  it("says an invoice was issued, paid or voided, not marked waiting, finished or dropped", () => {
    const at = "2026-11-10T09:00:00.000Z";
    const closed = (seq: number, to: string) =>
      ({
        seq,
        at,
        by: lead,
        via: "lead",
        kind: "updated",
        fields: [{ field: "state", from: "open", to }],
      }) as const;
    const view = kinWorkItemView(
      detail({
        list: KinListId.make("invoices"),
        changes: [closed(3, "dropped"), closed(2, "done"), closed(1, "waiting")],
      }),
      names,
      now,
      50,
      place,
    );
    expect(view.history.map((line) => line.text)).toEqual([
      "Tech lead voided it",
      "Tech lead marked it paid",
      "Tech lead issued it",
    ]);
  });

  it("lists a task's steps in order, and says all ticked without marking it done", () => {
    const can = {
      states: ["done" as const],
      edit: true,
      party: true,
      project: true,
      clearProject: true,
      give: true,
      takeBack: false,
      mark: true,
      unmark: true,
      share: false,
      confirm: false,
    };
    const checklist = [
      { title: "Fields and states", done: true },
      { title: "Wireframe", done: true },
    ];
    const changed = (seq: number, field: string, to: string) =>
      ({
        seq,
        at: "2026-11-10T09:00:00.000Z",
        by: lead,
        via: "lead",
        kind: "updated",
        fields: [{ field, from: null, to }],
      }) as const;
    const view = kinWorkItemView(
      detail({
        can,
        checklist,
        steps: { done: 2, of: 2 },
        urgent: true,
        changes: [changed(2, "urgent", "true"), changed(1, "steps", "Wireframe (done)")],
      }),
      names,
      now,
      50,
      place,
    );
    expect(view.urgent).toBe(true);
    expect(view.history.map((line) => line.text)).toEqual([
      "Tech lead marked it urgent",
      "Tech lead changed its steps",
    ]);
    expect(view.steps).toMatchObject({
      count: "2 of 2",
      editable: true,
      allDone: "Every step is ticked. Mark the task done when it's finished.",
    });
    expect(view.steps?.items.map((item) => [item.title, item.label])).toEqual([
      ["Fields and states", "Untick: Fields and states"],
      ["Wireframe", "Untick: Wireframe"],
    ]);
    expect(view.state).not.toBe("done");
    // One that may not change it reads them and ticks none; with none, it has no Steps.
    const reader = { ...can, edit: false };
    expect(
      kinWorkItemView(detail({ can: reader, checklist }), names, now, 50, place).steps,
    ).toMatchObject({ editable: false });
    expect(
      kinWorkItemView(detail({ can: reader, checklist: [] }), names, now, 50, place).steps,
    ).toBeNull();
    // One who may change it can add the first step.
    expect(
      kinWorkItemView(detail({ can, checklist: [] }), names, now, 50, place).steps,
    ).toMatchObject({ count: null, items: [], editable: true });
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
    // A web link offers Remove only where the host says this viewer may change its links.
    const figma = {
      ...link,
      kind: "url",
      target: "https://figma.example/f",
      label: "Screens",
    } as const;
    const can = {
      states: [],
      edit: true,
      party: false,
      project: false,
      clearProject: false,
      give: false,
      takeBack: false,
      mark: false,
      unmark: false,
      share: false,
      confirm: false,
    };
    const removable = (extra: Partial<Parameters<typeof detail>[0]>) =>
      kinWorkItemView(detail({ links: [figma], ...extra }), names, now, 50, place).links.map(
        (held) => held.removeUrl ?? null,
      );
    expect(removable({})).toEqual([null]);
    expect(removable({ can })).toEqual([null]);
    expect(removable({ can: { ...can, links: true } })).toEqual(["https://figma.example/f"]);
    expect(kinWorkItemView(detail({ links: [figma] }), names, now, 50, place).links[0]?.label).toBe(
      "Screens · figma.example",
    );
  });

  it("names the outside text a task was made or changed after, in a quiet line of its own", () => {
    const remarks = (afterReading?: KinRecordDetail["afterReading"]) =>
      kinWorkItemView(detail(afterReading ? { afterReading } : {}), names, now, 50, place).remarks;
    const source = "mail from lena@brightwell.example: New bank details";
    expect(remarks({ made: true, source })).toEqual([`Made after reading: ${source}`]);
    expect(remarks({ made: false, source })).toEqual([`Changed after reading: ${source}`]);
    expect(remarks()).toEqual([]);
  });

  it("puts who sees a task as one answer, and a pick changes only what it must", () => {
    const project = { key: "P-1", title: "Invented app" };
    const at = (sensitive: boolean, shared: boolean) =>
      kinWorkItemView(
        detail({ sensitive, ...(shared ? { shared: true } : {}) }),
        names,
        now,
        50,
        place,
      );
    const owner = { mark: true, unmark: true, share: true };
    const plain = kinWorkAudience({ ...at(false, false), project }, owner);
    expect(plain.current).toBe("people");
    expect(plain.answer).toBe(
      "You, co-owners, whoever has it, gave it or is with it, and the people on Invented app",
    );
    expect(plain.choices.map((one) => one.id)).toEqual(["people", "team", "me"]);
    // Marked private wins over an old share, so it reads as only you.
    expect(kinWorkAudience(at(true, true), owner).current).toBe("me");
    expect(kinWorkAudienceMove({ private: true, shared: true }, "people")).toEqual({
      private: false,
      shared: false,
    });
    expect(kinWorkAudienceMove({ private: false, shared: false }, "team")).toEqual({
      private: null,
      shared: true,
    });
    // A teammate who can't share or mark sees the answer with nothing to pick.
    expect(
      kinWorkAudience(at(false, false), { mark: false, unmark: false, share: false }).choices,
    ).toEqual([]);
    // #10: a milestone or client is never shared on its own, so the whole team is never offered.
    const unshared = { mark: true, unmark: true, share: false };
    expect(kinWorkAudience(at(false, false), unshared).choices.map((one) => one.id)).toEqual([
      "people",
      "me",
    ]);
    // J14: Priya, the project's lead, reads it from her side: "you" is never the owner.
    const priyas = { ...names, me: priya.personId, owner: me.personId };
    const lead = { mark: true, unmark: false, share: false };
    const hers = kinWorkAudience({ ...at(false, false), project }, lead, priyas);
    expect(hers.answer).toBe(
      "Invented Owner, co-owners, whoever has it, gave it or is with it, and the people on Invented app",
    );
    // She may make it private; un-marking and sharing stay the owner's.
    expect(hers.choices.map((one) => one.id)).toEqual(["people", "me"]);
    // Picking it reads "Only me" to her as to the owner.
    expect(hers.choices.find((one) => one.id === "me")?.label).toBe("Only me");
    const marked = kinWorkAudience(at(true, false), lead, priyas);
    expect(marked.answer).toBe("Only Invented Owner, co-owners and whoever has it or is with it");
    expect(marked.choices).toEqual([]);
    // Her own mark is hers to take off, and reads as hers; to anyone else, as kept to her.
    const own = { ...lead, unmark: true };
    const herMark = { ...at(true, false), markedBy: priya.personId };
    expect(kinWorkAudience(herMark, own, priyas)).toMatchObject({
      answer: "Only you, co-owners and whoever has it or is with it",
      choices: [
        { id: "people", label: "People on it" },
        { id: "me", label: "Only me" },
      ],
    });
    expect(
      kinWorkAudience(herMark, owner, { ...names, owner: me.personId }).choices.find(
        (one) => one.id === "me",
      )?.label,
    ).toBe("Only Priya");
    expect(kinWorkAudience(at(true, false), owner, { ...names, owner: me.personId }).answer).toBe(
      "Only you, co-owners and whoever has it or is with it",
    );
  });
});

describe("a task on an older host", () => {
  const suggested = detail({ owner: lead, confirmed: false, createdBy: lead });

  it("offers no changes, and sends a suggestion's answer to chat", () => {
    const view = kinWorkItemView(suggested, names, now, 50, place);
    expect(view).toMatchObject({ editable: false, suggestion: "Tech lead suggested this task." });
    expect(view.remarks.join(" ")).toContain("Tell it in chat");
  });

  it("shows no Steps to add where the host doesn't say it keeps them", () => {
    expect(kinWorkItemView({ ...suggested, seq: 9 }, names, now, 50, place).steps).toBeNull();
  });

  it("offers them on a host that sends a task's own change number", () => {
    const view = kinWorkItemView({ ...suggested, seq: 9 }, names, now, 50, place);
    expect(view).toMatchObject({ editable: true, takeBack: true });
    expect(view.remarks).toEqual([]);
    expect(view.leadNote).toContain("tells Tech lead to stop");
  });

  it("marks a task a retired agent has, and says nobody is working on it", () => {
    const retired = { ...names, retired: new Set([lead.agentId]) };
    const view = kinWorkItemView(
      { ...suggested, confirmed: true, seq: 9 },
      retired,
      now,
      50,
      place,
    );
    expect(view.owner).toMatchObject({ name: "Tech lead", retired: true });
    expect(view.leadNote).toBe(
      "Tech lead is retired, so nobody is working on this. Give it to someone else, or restore Tech lead.",
    );
    expect(kinWorkRow(record({ owner: lead }), retired, now).line).toBe("Tech lead (retired)");
    expect(kinWorkRow(record({ owner: lead }), names, now).ownerRetired).toBe(false);
  });

  it("keeps who handed a task back on its row when On me marks it due today", () => {
    const back = kinWorkRow(
      record({ owner: me, handedBack: { by: priya, at: now.toISOString() } }),
      names,
      now,
    );
    // The row's detail already says it is due today; the mark keeps what only it says.
    expect(kinWorkRowMarked(back, "today").markText).toBe("Handed back by Priya");
    expect(kinWorkRowMarked(kinWorkRow(record({ owner: me }), names, now), "today").markText).toBe(
      "Due today",
    );
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

describe("kinWorkItemState", () => {
  const webLink = {
    kind: "url",
    relation: "relates",
    target: "https://ambermill.example/logos",
    chatId: null,
    label: null,
    createdAt: now.toISOString(),
  } as const;
  const projectNote = {
    body: "Invented: brand blue is #1a4f8b",
    at: now.toISOString(),
    by: me,
    project: { recordId: KinRecordId.make("rec-p"), key: "P-1", title: "Invented site" },
  };
  const shown = (read: KinRecordDetail, given: KinRecordDetail | null) => {
    const state = kinWorkItemState(AsyncResult.success(read), given);
    return state._tag === "ready" ? state.item : null;
  };

  it("shows a link or a project's note read after the last change's answer, at the same rev", () => {
    const answer = detail({ rev: 4, seq: 7 });
    const linked = detail({ rev: 4, seq: 8, links: [webLink] });
    expect(shown(linked, answer)).toBe(linked);
    const noted = detail({ rev: 4, seq: 7, projectNote });
    expect(shown(noted, answer)).toBe(noted);
    // A read from before the change still gives way to its answer.
    expect(shown(detail({ rev: 3, seq: 6 }), answer)).toBe(answer);
    expect(shown(detail({ rev: 4, seq: 6 }), answer)).toBe(answer);
  });
});

describe("kinWorkAnswerOf", () => {
  it("keeps one person's answer from the next person signed in on the same host", () => {
    const rheas = kinWorkAnswerKept({}, detail({ rev: 4 }), "rhea");
    expect(kinWorkAnswerOf(rheas, detail().key, "rhea")?.rev).toBe(4);
    expect(kinWorkAnswerOf(rheas, detail().key, "arjun")).toBeUndefined();
    // Arjun's own answer replaces hers at the same rev; an older one of hers changes nothing.
    const arjuns = kinWorkAnswerKept(rheas, detail({ rev: 4 }), "arjun");
    expect(kinWorkAnswerOf(arjuns, detail().key, "arjun")?.rev).toBe(4);
    expect(kinWorkAnswerKept(rheas, detail({ rev: 3 }), "rhea")).toBe(rheas);
  });
});

describe("kinWorkClientStays", () => {
  const ref = (key: string, title: string) => ({ recordId: KinRecordId.make(key), key, title });
  const grove = ref("C-1", "Invented Grove");
  const clientOf = new Map<string, string | null>([
    ["P-1", "C-2"],
    ["P-2", null],
  ]);
  const changed = (fields: ReadonlyArray<readonly [string, string | null, string | null]>) =>
    detail({
      party: grove,
      changes: [
        {
          seq: 4,
          at: now.toISOString(),
          by: me,
          via: "owner",
          kind: "updated",
          fields: fields.map(([field, from, to]) => ({ field, from, to })),
        },
      ],
    });

  it("says a new client took the task off another client's project, and only then", () => {
    expect(
      kinWorkClientStays(
        changed([
          ["party", "C-2", "C-1"],
          ["project", "P-1", null],
        ]),
        clientOf,
      ),
    ).toBe("No longer on P-1: that project is another client's");
    // A project with no client, or only the project cleared, is the person's own doing.
    expect(
      kinWorkClientStays(
        changed([
          ["party", null, "C-1"],
          ["project", "P-2", null],
        ]),
        clientOf,
      ),
    ).toBeNull();
    expect(kinWorkClientStays(changed([["project", "P-1", null]]), clientOf)).toBeNull();
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

  // K227: the day and the today it counts from are both the owner's, and a day has no time.
  it.each([
    [
      "Asia/Kolkata",
      "2026-11-20T18:29:59.999Z",
      "2026-11-19T18:29:00.000Z",
      "2026-11-19T18:31:00.000Z",
    ],
    [
      "America/New_York",
      "2026-11-21T04:59:59.999Z",
      "2026-11-20T04:59:00.000Z",
      "2026-11-20T05:01:00.000Z",
    ],
    ["UTC", "2026-11-20T23:59:59.999Z", "2026-11-19T23:59:00.000Z", "2026-11-20T00:01:00.000Z"],
  ])("prints a due day as the day only where the owner is (%s)", (zone, dueAt, before, after) => {
    const where = { ...names, zone };
    const due = { dueAt, dueAllDay: true };
    expect(kinWorkDueText(due, where, new Date(before))).toBe("tomorrow");
    expect(kinWorkDueText(due, where, new Date(after))).toBe("today");
  });

  // Play-test W-4, due Fri 4 Dec, stored as that day's end where the company is. Moving the device's
  // zone mid-run is what its Los Angeles browser did: earlier formatters keep their zone, Date doesn't.
  it.each([
    ["UTC+12", "Etc/GMT-12", "2026-12-04T11:59:59.999Z"],
    ["UTC-8", "Etc/GMT+8", "2026-12-05T07:59:59.999Z"],
  ])("shows a %s company's all-day due as one day on every screen and device", (_, zone, dueAt) => {
    const where = { ...names, zone };
    const due = { dueAt, dueAllDay: true };
    // A minute either side of the company's midnight starting Fri 4 Dec.
    const midnight = Date.parse(dueAt) + 1 - 86_400_000;
    const [before, after] = [new Date(midnight - 60_000), new Date(midnight + 60_000)];
    const read = (now: Date) => ({
      row: kinWorkRow(record(due), where, now).due,
      detail: kinWorkItemView(detail(due), where, now, 50, place).due,
      days: kinWorkDueDays(due, where, now),
      picked: kinWorkItemView(detail(due), where, now, 50, place).dueDay,
      label: kinWorkDueLabel("2026-12-04", now, zone),
      today: kinWorkDueChoices(now, zone)[0]!.day,
      far: kinWorkDueText(due, where, new Date("2026-11-20T00:00:00.000Z")),
    });
    const held = process.env.TZ;
    try {
      for (const device of [held, "Pacific/Kiritimati", "Pacific/Pago_Pago"]) {
        if (device !== undefined) process.env.TZ = device;
        expect([read(before), read(after)]).toEqual([
          {
            row: "Due tomorrow",
            detail: "tomorrow",
            days: 1,
            picked: "2026-12-04",
            label: "Tomorrow",
            today: "2026-12-03",
            far: "Fri, Dec 4",
          },
          {
            row: "Due today",
            detail: "today",
            days: 0,
            picked: "2026-12-04",
            label: "Today",
            today: "2026-12-04",
            far: "Fri, Dec 4",
          },
        ]);
      }
    } finally {
      if (held === undefined) delete process.env.TZ;
      else process.env.TZ = held;
    }
  });

  // The play-test's M-1: 4 Dec 10:16 UTC is 5 Dec 00:16 for a UTC+14 company, wherever it is read.
  it("shows a timed due on the owner's day and clock, in the detail and the agenda alike", () => {
    const where = { ...names, zone: "Etc/GMT-14" };
    const due = record({ dueAt: "2026-12-04T10:16:00.000Z", dueAllDay: false });
    const today = new Date("2026-11-20T00:00:00.000Z");
    expect(kinWorkDueText(due, where, today)).toBe("Sat, Dec 5, 12:16 AM");
    const [day] = kinDatesAgenda(
      [
        {
          record: due,
          listName: "Milestones",
          stateLabel: "Open",
          kind: "due",
          label: "Due",
          at: due.dueAt!,
          allDay: false,
        },
      ],
      where,
      today,
    );
    expect([day!.day, day!.rows[0]!.time]).toEqual(["2026-12-05", "12:16 AM"]);
    // A suggestion's dates stay, tagged as the lists tag it; stored issued, it reads Suggested.
    const suggested = {
      ...record({ dueAt: "2026-12-16T00:00:00.000Z" }),
      list: "invoices",
      state: "waiting",
      confirmed: false,
    } as KinRecord;
    const lines = kinDatesAgenda(
      (
        [
          ["date", "Date", "Issued", suggested],
          ["due", "Due", "Issued", suggested],
          ["due", "Due", "Draft", { ...suggested, state: "open" }],
          ["date", "Issued", "Issued", { ...suggested, confirmed: true }],
        ] as const
      ).map(([kind, label, stateLabel, one]) => ({
        record: one,
        listName: "Invoices",
        stateLabel,
        kind,
        label,
        at: "2026-12-16T00:00:00.000Z",
        allDay: true,
      })),
      names,
      today,
    ).flatMap((one) => one.rows.map((row) => row.line));
    expect(lines).toEqual([
      "Invoices · Date · Suggested",
      "Invoices · Due · Suggested",
      "Invoices · Due · Suggested · Draft",
      "Invoices · Issued",
    ]);
  });

  it("says who it waits on only while it is waiting, and never doubles a title's full stop", () => {
    expect(kinWorkRow(record({ state: "waiting", waitingOn: priya }), names, now).status).toBe(
      "Waiting on Priya",
    );
    // K224: a stale waitingOn on a task under way reads as where it stands; the holder leads.
    const doing = kinWorkRow(record({ state: "doing", waitingOn: priya, owner: lead }), names, now);
    expect([doing.status, doing.holder]).toEqual(["In progress", "Tech lead"]);
    // K228
    const label = kinWorkRow(record({ title: "Call the bank." }), names, now).accessibilityLabel;
    expect(label).toBe("Call the bank. You");
  });

  it("names the project, else the client except in a list of only theirs, and nothing on an older host", () => {
    const party = {
      recordId: KinRecordId.make("rec-c"),
      key: "C-1",
      title: "Invented Foods",
    } as const;
    const owed = record({ party, side: "theirs" });
    // Who has it leads, so a narrow row that cuts the end off never loses it; the key is gone.
    expect(kinWorkRow(owed, names, now)).toMatchObject({
      holder: "You",
      detail: "Invented Foods · They owe this",
      line: "You · Invented Foods · They owe this",
    });
    expect(kinWorkRow(owed, names, now, { party: party, project: null }).about).toBeNull();
    // Owner and member read the same words: the project when there is one, inside its client too.
    const project = { recordId: KinRecordId.make("rec-p"), key: "P-1", title: "Invented app" };
    const ownerSees = kinWorkRow(record({ party, project }), names, now);
    const memberSees = kinWorkRow(record({ project }), names, now);
    expect([ownerSees.about, memberSees.about]).toEqual(["Invented app", "Invented app"]);
    expect(kinWorkRow(record({ party, project }), names, now, { party, project: null }).about).toBe(
      "Invented app",
    );
    // A repeating task says so on its row while it is open.
    const monthly = record({ project, repeat: { every: "month" } });
    expect(kinWorkRow(monthly, names, now).line).toBe("You · Every month · Invented app");
    expect(kinWorkRow({ ...monthly, state: "done" }, names, now).line).not.toContain("Every");
    // A host from before clients sends none of it: the row and the ways in show nothing new.
    expect(kinWorkRow(record(), names, now).line).toBe("You");
    expect(kinWorkHostClients(null)).toBe(false);
  });
});

describe("kinWorkAssignees", () => {
  const person = (personId: KinPersonId, displayName: string) => ({
    personId,
    orgId,
    handle: displayName.toLowerCase(),
    displayName,
    githubLogin: null,
  });
  const sami = { _tag: "person", personId: KinPersonId.make("invented-sami") } as const;
  const people = [
    person(me.personId, "Invented Owner"),
    person(priya.personId, "Priya"),
    person(sami.personId, "Sami"),
  ];
  const offered = (current: typeof sami | null, invited: ReadonlyArray<KinPersonId> = []) =>
    kinWorkAssignees({
      orgs: null,
      orgId,
      people,
      names,
      current,
      joined: [me.personId, priya.personId],
      invited,
    }).people.map((to) => (to.invited ? `${to.key} (invited)` : to.key));

  it("leaves out people whose access was removed, unless the task is with them now", () => {
    expect(offered(null)).toEqual(["person:invented-owner", "person:invented-priya"]);
    expect(offered(sami)).toContain("person:invented-sami");
  });

  it("lists someone re-invited who hasn't opened the link as invited, last", () => {
    expect(offered(null, [sami.personId])).toEqual([
      "person:invented-owner",
      "person:invented-priya",
      "person:invented-sami (invited)",
    ]);
  });
});

describe("kinWorkDraftCheck", () => {
  it("counts a long title from 240 and refuses one past 280 on Save, never cutting it", () => {
    expect(kinWorkTitleCount("x".repeat(239))).toBeNull();
    expect(kinWorkTitleCount("x".repeat(240))).toBe("240 of 280");
    const long = "x".repeat(300);
    expect(kinWorkTitleCount(long)).toBe("300 of 280");
    expect(kinWorkDraftCheck({ ...KIN_WORK_NO_DRAFT, title: long })).toEqual({
      ok: false,
      problem: KIN_WORK_TITLE_TOO_LONG,
    });
    expect(kinWorkDraftCheck({ ...KIN_WORK_NO_DRAFT, title: "x".repeat(280) }).ok).toBe(true);
  });

  it("sends a picked day as an all-day date and leaves out what was left blank", () => {
    expect(
      kinWorkDraftCheck({
        ...KIN_WORK_NO_DRAFT,
        title: "  Send the quote ",
        owner: lead,
        due: "2026-11-14",
        notes: " ",
      }),
    ).toEqual({
      ok: true,
      input: { title: "Send the quote", owner: lead, dueAt: "2026-11-14", dueAllDay: true },
    });
    expect(kinWorkDraftCheck({ ...KIN_WORK_NO_DRAFT, title: " " }).ok).toBe(false);
    // K187: a client alone is a plain task about them; saying who owes it makes an obligation.
    const party = { key: "C-1" as const, title: "Invented Foods" };
    expect(kinWorkDraftCheck({ ...KIN_WORK_NO_DRAFT, title: "Sign", party })).toEqual({
      ok: true,
      input: { title: "Sign", party: "C-1" },
    });
    expect(kinWorkDraftCheck({ ...KIN_WORK_NO_DRAFT, title: "Sign", party, side: "ours" })).toEqual(
      { ok: true, input: { title: "Sign", party: "C-1", category: "obligation" } },
    );
    expect(
      kinWorkDraftCheck({ ...KIN_WORK_NO_DRAFT, title: "Sign", party, side: "theirs" }),
    ).toEqual({
      ok: true,
      input: { title: "Sign", party: "C-1", category: "obligation", side: "theirs" },
    });
    expect(kinWorkDraftCheck({ ...KIN_WORK_NO_DRAFT, title: "Sign", side: "theirs" })).toEqual({
      ok: true,
      input: { title: "Sign" },
    });
    // From a deal's page: the deal it sits on, and where it was promised, said only of a promise.
    const deal = { key: "DL-4" as const, title: "Invented second clinic" };
    expect(
      kinWorkDraftCheck({
        ...KIN_WORK_NO_DRAFT,
        title: "Plan",
        party,
        side: "ours",
        deal,
        from: " At the site visit ",
      }),
    ).toEqual({
      ok: true,
      input: {
        title: "Plan",
        party: "C-1",
        category: "obligation",
        deal: "DL-4",
        from: "At the site visit",
      },
    });
    expect(
      kinWorkDraftCheck({ ...KIN_WORK_NO_DRAFT, title: "Plan", party, from: "Ignored" }),
    ).toEqual({ ok: true, input: { title: "Plan", party: "C-1" } });
    expect(
      kinWorkDraftCheck({
        ...KIN_WORK_NO_DRAFT,
        title: "Plan",
        party,
        side: "ours",
        from: "x".repeat(281),
      }).ok,
    ).toBe(false);
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
      problem: KIN_CHANGED,
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
