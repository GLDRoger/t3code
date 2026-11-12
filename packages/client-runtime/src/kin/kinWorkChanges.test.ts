import {
  KinAgentId,
  KinChatError,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type KinRecordDetail,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type { AtomCommandResult } from "../state/runtime.ts";
import type { KinWorkNames } from "./kinWork.ts";
import {
  KIN_WORK_EDIT_CHANGED,
  KIN_WORK_OFFLINE_CHANGE,
  createKinWorkChanges,
  createKinWorkItemWatch,
  kinWorkApplied,
  kinWorkAtRev,
  kinWorkEditMoved,
  kinWorkItemNotice,
  kinWorkListNotice,
} from "./kinWorkChanges.ts";
import { KIN_WORK_NOTHING_NAMED, kinWorkNote } from "./kinWorkStream.ts";

const orgId = KinOrgId.make("invented-org");
const me = { _tag: "person", personId: KinPersonId.make("invented-owner") } as const;
const lead = { _tag: "agent", agentId: KinAgentId.make("invented-lead") } as const;
const names: KinWorkNames = {
  people: new Map([[me.personId, "Invented Owner"]]),
  agents: new Map([[lead.agentId, "Tech lead"]]),
  me: me.personId,
  zone: "UTC",
};
const task = (patch: Partial<KinRecordDetail> = {}): KinRecordDetail => ({
  recordId: KinRecordId.make("rec-1"),
  orgId,
  key: "W-1",
  title: "Send the invented quote",
  state: "doing",
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
  notes: "Invented notes",
  source: { chatId: null, messageId: null },
  assignedBy: null,
  assignedAt: null,
  createdBy: me,
  links: [],
  changes: [],
  seq: 5,
  ...patch,
});
const refused = (reason: KinChatError["reason"]): AtomCommandResult<KinRecordDetail, unknown> =>
  AsyncResult.failure(
    Cause.fail(new KinChatError({ reason, message: "W-1 is at revision 9 now." })),
  );

const never = (): never => {
  throw new Error("Expected an edit in progress.");
};

/** A host whose answers the test releases one at a time. */
function harness() {
  const sent: Array<readonly [string, object]> = [];
  const waiting: Array<(answer: AtomCommandResult<KinRecordDetail, unknown>) => void> = [];
  const reread: Array<string> = [];
  let online = true;
  const call = (method: string) => (input: object) => {
    sent.push([method, input]);
    return new Promise<AtomCommandResult<KinRecordDetail, unknown>>((resolve) =>
      waiting.push(resolve),
    );
  };
  const changes = createKinWorkChanges({
    orgId,
    update: call("update"),
    assign: call("assign"),
    confirm: call("confirm"),
    decline: call("decline"),
    reread: (key) => reread.push(key),
    online: () => online,
    onChange: () => undefined,
  });
  return {
    changes,
    sent,
    reread,
    state: () => changes.getState(),
    answer: (result: AtomCommandResult<KinRecordDetail, unknown>) => waiting.shift()?.(result),
    goOffline: () => {
      online = false;
    },
  };
}

describe("createKinWorkChanges", () => {
  it("shows a change at once, then the host's answer, with the way back from closing", async () => {
    const h = harness();
    const held = task({ owner: lead, working: true });
    const done = h.changes.run(held, { type: "state", state: "done" }, names);
    expect(kinWorkApplied(held, h.state())).toMatchObject({ state: "done", working: false });
    expect(h.sent).toEqual([["update", { orgId, key: "W-1", rev: 3, state: "done" }]]);

    h.answer(AsyncResult.success(task({ owner: lead, state: "done", rev: 4, seq: 6 })));
    expect(await done).toBe(true);
    expect(kinWorkApplied(held, h.state())).toMatchObject({ state: "done", rev: 4 });
    expect(h.reread).toEqual([]);
    expect(h.state().notice).toMatchObject({
      kind: "saved",
      text: "Marked done. Tech lead was told to stop.",
      undo: { type: "state", state: "doing" },
    });
    // A list says it above its rows, unless the task's own sheet is open to say it.
    expect(kinWorkListNotice(h.state(), null)).not.toBeNull();
    expect(kinWorkListNotice(h.state(), "W-1")).toBeNull();

    // Undo goes against the host's answer, so it works once a list has dropped the task.
    const undone = h.changes.undo(names);
    expect(h.sent[1]).toEqual(["update", { orgId, key: "W-1", rev: 4, state: "doing" }]);
    h.answer(AsyncResult.success(task({ owner: lead, rev: 5, seq: 7 })));
    await undone;
    expect(h.state().notice).toMatchObject({
      text: "Reopened. Tech lead has it again.",
      undo: null,
    });
  });

  it("takes a refused change back and says why without the host's wording", async () => {
    const h = harness();
    const held = task();
    const dropped = h.changes.run(held, { type: "state", state: "dropped" }, names);
    expect(kinWorkApplied(held, h.state()).state).toBe("dropped");
    h.answer(refused("unavailable"));
    expect(await dropped).toBe(false);
    expect(kinWorkApplied(held, h.state())).toBe(held);
    expect(h.state().notice).toMatchObject({ kind: "failed", undo: null });
    expect(h.state().notice?.text).not.toContain("revision");
    expect(h.reread).toEqual([]);
  });

  it("keeps what was typed when the task moved on, and saves it over the latest", async () => {
    const h = harness();
    h.changes.startEdit(task());
    h.changes.setEdit({ title: "Send the invented quote to Acme" });
    const first = h.changes.saveEdit(task(), names);
    h.answer(refused("conflict"));
    expect(await first).toBe(false);
    expect(h.reread).toEqual(["W-1"]);
    expect(h.state().notice).toMatchObject({ kind: "conflict", text: KIN_WORK_EDIT_CHANGED });
    expect(h.state().edit).toMatchObject({ title: "Send the invented quote to Acme" });
    const latest = task({ rev: 9, notes: "Invented notes, changed by a lead" });
    expect(kinWorkEditMoved(h.state().edit ?? never(), latest)).toEqual({
      title: null,
      notes: "Invented notes, changed by a lead",
    });

    // The latest arrives with a lead's notes; saving again sends the title alone, at that revision.
    const second = h.changes.saveEdit(latest, names);
    expect(h.sent[1]).toEqual([
      "update",
      { orgId, key: "W-1", rev: 9, title: "Send the invented quote to Acme" },
    ]);
    h.answer(AsyncResult.success(task({ rev: 10, title: "Send the invented quote to Acme" })));
    expect(await second).toBe(true);
    expect(h.state()).toMatchObject({ edit: null, notice: { kind: "saved", text: "Saved." } });
  });

  it("puts a changed due date back, time and all, and says so once", async () => {
    const h = harness();
    const held = task({ dueAt: "2026-11-20T15:30:00.000Z", dueAllDay: false });
    const moved = h.changes.run(held, { type: "due", day: "2026-11-14" }, names);
    h.answer(AsyncResult.success(task({ dueAt: "2026-11-14T12:00:00.000Z", rev: 4 })));
    expect(await moved).toBe(true);
    expect(h.state().notice).toMatchObject({
      text: "Due date changed.",
      undo: { type: "dueBack" },
    });

    const undone = h.changes.undo(names);
    expect(h.sent[1]).toEqual([
      "update",
      { orgId, key: "W-1", rev: 4, dueAt: "2026-11-20T15:30:00.000Z", dueAllDay: false },
    ]);
    h.answer(AsyncResult.success(task({ ...held, rev: 5 })));
    await undone;
    expect(h.state().notice).toMatchObject({ text: "Due date put back.", undo: null });
  });

  it.each([
    [
      "an all-day date",
      { dueAt: "2026-11-20T12:00:00.000Z", dueAllDay: true },
      { dueAt: "2026-11-20T12:00:00.000Z", dueAllDay: true },
    ],
    ["no date before, so Undo takes it off", { dueAt: null, dueAllDay: false }, { dueAt: null }],
  ] as const)("puts back %s", async (_name, before, sent) => {
    const h = harness();
    const moved = h.changes.run(task(before), { type: "due", day: "2026-11-14" }, names);
    h.answer(AsyncResult.success(task({ dueAt: "2026-11-14T12:00:00.000Z", rev: 4 })));
    await moved;
    void h.changes.undo(names);
    expect(h.sent[1]).toEqual(["update", { orgId, key: "W-1", rev: 4, ...sent }]);
  });

  it("drops a task's notice once a later change to it, such as Give to, is held", async () => {
    const h = harness();
    const moved = h.changes.run(task(), { type: "due", day: "2026-11-14" }, names);
    h.answer(AsyncResult.success(task({ rev: 4 })));
    await moved;
    expect(kinWorkItemNotice(h.state(), task({ rev: 4 }))).toMatchObject({ kind: "saved" });
    expect(kinWorkItemNotice(h.state(), task({ rev: 5, owner: lead }))).toBeNull();
    expect(kinWorkItemNotice(h.state(), task({ key: "W-2" }))).toBeNull();
  });

  it("sends nothing while offline, and queues nothing for later", async () => {
    const h = harness();
    h.goOffline();
    expect(await h.changes.run(task(), { type: "state", state: "done" }, names)).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.state()).toMatchObject({
      pending: {},
      notice: { kind: "offline", text: KIN_WORK_OFFLINE_CHANGE },
    });
  });

  it("runs one change to a task at a time", async () => {
    const h = harness();
    void h.changes.run(task(), { type: "state", state: "done" }, names);
    expect(await h.changes.run(task(), { type: "state", state: "dropped" }, names)).toBe(false);
    expect(h.sent).toHaveLength(1);
  });

  it.each([
    [{ type: "confirm" }, "confirm", { orgId, key: "W-1", rev: 3 }],
    [{ type: "decline" }, "decline", { orgId, key: "W-1", rev: 3 }],
    [{ type: "takeBack" }, "assign", { orgId, key: "W-1", rev: 3, to: null }],
    [
      { type: "due", day: "2026-11-14" },
      "update",
      { orgId, key: "W-1", rev: 3, dueAt: "2026-11-14", dueAllDay: true },
    ],
    [{ type: "due", day: null }, "update", { orgId, key: "W-1", rev: 3, dueAt: null }],
    [
      { type: "state", state: "waiting", waitingOn: lead },
      "update",
      { orgId, key: "W-1", rev: 3, state: "waiting", waitingOn: lead },
    ],
  ] as const)("asks the host for %o", (action, method, input) => {
    const h = harness();
    void h.changes.run(task({ owner: lead, confirmed: false }), action, names);
    expect(h.sent).toEqual([[method, input]]);
  });

  it("says a closed task has to be reopened before it is given to anyone", async () => {
    const h = harness();
    const given = h.changes.run(task(), { type: "give", to: lead }, names);
    h.answer(refused("invalid_state"));
    await given;
    expect(h.state().notice?.text).toBe(
      "This task is closed. Reopen it before giving it to someone.",
    );
  });
});

describe("kinWorkAtRev", () => {
  it("sends the sheet's newer revision, never an older or garbled one", () => {
    expect(kinWorkAtRev(task({ rev: 3 }), "4").rev).toBe(4);
    expect(kinWorkAtRev(task({ rev: 5 }), "4").rev).toBe(5);
    expect(kinWorkAtRev(task({ rev: 3 }), "x").rev).toBe(3);
    expect(kinWorkAtRev(task({ rev: 3 })).rev).toBe(3);
  });
});

describe("createKinWorkItemWatch", () => {
  const watching = () => {
    let rereads = 0;
    const watch = createKinWorkItemWatch({ key: "W-1", reread: () => (rereads += 1) });
    return { watch, rereads: () => rereads };
  };
  const live = (events: ReadonlyArray<{ readonly seq: number; readonly key?: string }>) =>
    events.reduce(kinWorkNote, KIN_WORK_NOTHING_NAMED);

  it("reads nothing for another task's change, or for a change it already holds", () => {
    const h = watching();
    const held = { seq: 5 };
    h.watch.changed(live([{ seq: 5 }]), held);
    h.watch.changed(live([{ seq: 5 }, { seq: 6, key: "W-2" }]), held);
    // The owner's own change: the host's answer came first and is what is held.
    h.watch.changed(live([{ seq: 5 }, { seq: 6, key: "W-2" }, { seq: 7, key: "W-1" }]), {
      seq: 7,
    });
    expect(h.rereads()).toBe(0);
  });

  it("reads again when its own task changed, once", () => {
    const h = watching();
    const held = { seq: 5 };
    h.watch.changed(live([{ seq: 5 }]), held);
    const changed = live([{ seq: 5 }, { seq: 8, key: "W-1" }]);
    h.watch.changed(changed, held);
    h.watch.changed(changed, held);
    expect(h.rereads()).toBe(1);
  });

  it("reads again after changes it wasn't told the names of", () => {
    const h = watching();
    h.watch.changed(live([{ seq: 5 }]), { seq: 5 });
    // Back from a dropped connection: the number moved and nothing says which task it was.
    h.watch.changed(live([{ seq: 5 }, { seq: 9 }]), { seq: 5 });
    expect(h.rereads()).toBe(1);
  });

  it("reads again on every change from an older host, which names nothing", () => {
    const h = watching();
    const held = {};
    h.watch.changed(live([{ seq: 5 }]), held);
    h.watch.changed(live([{ seq: 5 }, { seq: 6 }]), held);
    h.watch.changed(live([{ seq: 5 }, { seq: 6 }, { seq: 7 }]), held);
    expect(h.rereads()).toBe(2);
  });

  it("reads a task opened from an older copy than the change that named it", () => {
    const h = watching();
    h.watch.changed(live([{ seq: 5 }, { seq: 8, key: "W-1" }]), { seq: 5 });
    expect(h.rereads()).toBe(1);
  });
});
