// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import {
  KinAgentId,
  KinChatId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type KinCanvasRead,
  type KinCanvasWidget,
  type KinRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinCanvasFit, kinCanvasZoom } from "./kinCanvasCamera.ts";
import { KIN_CANVAS_CARD_W, kinCanvasLayout, kinCanvasOverlaps } from "./kinCanvasLayout.ts";
import { kinCanvasLensColumns } from "./kinCanvasLens.ts";
import { kinCanvasApply } from "./kinCanvasStream.ts";
import {
  kinCanvasActivityText,
  kinCanvasModel,
  kinCanvasSinceLine,
  kinCanvasWidgetView,
} from "./kinCanvasView.ts";
import type { KinWorkNames } from "./kinWork.ts";

const orgId = KinOrgId.make("invented-org");
const me = { _tag: "person", personId: KinPersonId.make("invented-owner") } as const;
const meera = { _tag: "person", personId: KinPersonId.make("invented-meera") } as const;
const lead = { _tag: "agent", agentId: KinAgentId.make("invented-lead") } as const;
const names: KinWorkNames = {
  people: new Map([
    [me.personId, "Invented Owner"],
    [meera.personId, "Meera"],
  ]),
  agents: new Map([[lead.agentId, "Tech lead"]]),
  me: me.personId,
  zone: "UTC",
};
const now = new Date("2026-11-18T08:00:00.000Z");
const project = (key: string, title: string) => ({
  recordId: KinRecordId.make(`rec-${key}`),
  key,
  title,
});
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
  rev: 1,
  createdAt: "2026-11-10T08:00:00.000Z",
  updatedAt: "2026-11-10T08:00:00.000Z",
  closedAt: null,
  ...patch,
});
const widget = (patch: Partial<KinCanvasWidget> = {}): KinCanvasWidget => ({
  id: "cw_abcdef",
  kind: "progress",
  source: project("P-1", "Launch site"),
  value: { _tag: "progress", done: 6, total: 13 },
  addedBy: me,
  addedAt: "2026-11-17T08:00:00.000Z",
  ...patch,
});
const read = (patch: Partial<KinCanvasRead> = {}): KinCanvasRead => ({
  places: [],
  widgets: [],
  since: { seenAt: "2026-11-17T08:00:00.000Z", changes: [], more: 0 },
  activity: [],
  canArrange: true,
  ...patch,
});

describe("canvas layout", () => {
  const items = Array.from({ length: 6 }, (_, i) => ({
    key: `W-${i + 1}`,
    group: i < 4 ? "P-1" : null,
  }));
  const groups = [
    { key: "P-1", title: "Launch site" },
    { key: null, title: "No project" },
  ];

  it("lays out the same input the same way, with no card covering another", () => {
    const a = kinCanvasLayout({ groups, items, places: new Map() });
    const b = kinCanvasLayout({ groups, items, places: new Map() });
    expect([...a.cards.values()]).toEqual([...b.cards.values()]);
    const boxes = [...a.cards.values()];
    for (const box of boxes)
      for (const other of boxes) if (other !== box) expect(kinCanvasOverlaps(box, other)).toBe(false);
    expect(a.groups.map((g) => g.title)).toEqual(["Launch site", "No project"]);
  });

  it("keeps a stored place exactly and puts a new card in the first free cell beside it", () => {
    const places = new Map([["W-1", { x: 2000, y: 1000 }]]);
    const layout = kinCanvasLayout({ groups, items, places });
    expect(layout.cards.get("W-1")).toMatchObject({ x: 2000, y: 1000, placed: true });
    const next = layout.cards.get("W-2")!;
    expect(next.placed).toBe(false);
    expect(next.y).toBe(1000);
    expect(next.x).toBe(2000 + KIN_CANVAS_CARD_W + 24);
    // The group nobody arranged goes below the arranged one.
    expect(layout.cards.get("W-5")!.y).toBeGreaterThan(1000);
  });
});

describe("canvas camera", () => {
  it("fits a box inside the free part of the screen", () => {
    const cam = kinCanvasFit({ x: 0, y: 0, w: 1000, h: 500 }, 1064, 564, undefined, 32);
    expect(cam).toEqual({ x: 500, y: 250, scale: 1 });
  });
  it("zooms about the pointer, keeping the point under it still", () => {
    const cam = kinCanvasZoom({ x: 0, y: 0, scale: 1 }, 2, 600, 300, 800, 600);
    // The canvas point under (600, 300) was (200, 0); it still is.
    expect((600 - 400) / cam.scale + cam.x).toBeCloseTo(200);
  });
});

describe("canvas lens", () => {
  const tasks = [
    { key: "W-1", state: "open", holder: "You", dueAt: null, late: false },
    { key: "W-2", state: "doing", holder: "Tech lead", dueAt: "2026-11-20T00:00:00.000Z", late: false },
    { key: "W-3", state: "open", holder: "Meera", dueAt: "2026-11-10T00:00:00.000Z", late: true },
    { key: "W-4", state: "done", holder: "You", dueAt: null, late: false },
    { key: "W-5", state: "dropped", holder: "You", dueAt: null, late: false },
  ] as const;

  it("sorts by state, leaving dropped tasks out", () => {
    const cols = kinCanvasLensColumns("state", tasks, now.getTime());
    expect(cols.map((c) => [c.title, c.keys])).toEqual([
      ["To do", ["W-1", "W-3"]],
      ["In progress", ["W-2"]],
      ["Waiting", []],
      ["Done", ["W-4"]],
    ]);
  });

  it("sorts by due date and by who has it, you first", () => {
    const due = kinCanvasLensColumns("due", tasks, now.getTime());
    expect(Object.fromEntries(due.map((c) => [c.id, c.keys]))).toMatchObject({
      late: ["W-3"],
      week: ["W-2"],
      none: ["W-1"],
      closed: ["W-4"],
    });
    const holder = kinCanvasLensColumns("holder", tasks, now.getTime());
    expect(holder.map((c) => c.title)).toEqual(["You", "Meera", "Tech lead"]);
  });
});

describe("canvas cards and words", () => {
  it("groups tasks by project, keeps recently done ones and drops old done and dropped ones", () => {
    const model = kinCanvasModel({
      tasks: [
        record({ key: "W-1", project: project("P-1", "Launch site") }),
        record({ key: "W-2", state: "done", closedAt: "2026-11-17T08:00:00.000Z" }),
        record({ key: "W-3", state: "done", closedAt: "2026-10-01T08:00:00.000Z" }),
        record({ key: "W-4", state: "dropped" }),
      ],
      docs: [],
      projects: [],
      canvas: read({ widgets: [widget()] }),
      needsYou: new Set(["W-1"]),
      names,
      now,
    });
    expect([...model.cards.keys()]).toEqual(["W-1", "W-2"]);
    expect(model.items.find((i) => i.key === "cw_abcdef")?.group).toBe("P-1");
    expect(model.cards.get("W-1")?.needsYou).toBe(true);
    expect(model.groups.map((g) => g.title)).toEqual(["Launch site", "No project"]);
  });

  it("marks what others changed and what an agent is working on", () => {
    const model = kinCanvasModel({
      tasks: [record({ key: "W-1" })],
      docs: [],
      projects: [],
      canvas: read({
        since: {
          seenAt: "2026-11-17T08:00:00.000Z",
          changes: [
            { key: "W-1", title: "x", by: lead, others: 1, count: 3, at: "2026-11-18T07:00:00.000Z", created: false },
          ],
          more: 0,
        },
        activity: [
          {
            agentId: lead.agentId,
            name: "Tech lead",
            chatId: KinChatId.make("chat-1"),
            state: "working",
            label: null,
            startedAt: "2026-11-18T07:59:00.000Z",
            keys: ["W-1"],
          },
        ],
      }),
      needsYou: new Set(),
      names,
      now,
    });
    expect(model.cards.get("W-1")?.changed).toBe("Tech lead and 1 other changed it today");
    expect(model.cards.get("W-1")?.working).toBe("Tech lead is working on it");
  });

  it("says what changed since the last look", () => {
    const change = { title: "x", others: 0, count: 1, at: "2026-11-18T07:00:00.000Z", created: false };
    expect(kinCanvasSinceLine(read(), names)).toBe("Nothing changed since you last looked.");
    expect(kinCanvasSinceLine(read({ since: { seenAt: null, changes: [], more: 0 } }), names)).toBe(
      "Changes appear here from your next visit.",
    );
    expect(
      kinCanvasSinceLine(
        read({
          since: {
            seenAt: "2026-11-17T08:00:00.000Z",
            changes: [
              { ...change, key: "W-1", by: lead },
              { ...change, key: "W-2", by: meera },
            ],
            more: 3,
          },
        }),
        names,
      ),
    ).toBe("Tech lead and Meera changed 5 things since you last looked.");
  });

  it("words each widget from its value", () => {
    expect(kinCanvasWidgetView(widget(), now)).toMatchObject({ headline: "6 of 13 done", tone: "open" });
    const countdown = (value: KinCanvasWidget["value"]) =>
      kinCanvasWidgetView(widget({ kind: "countdown", value }), now).headline;
    expect(countdown({ _tag: "countdown", at: "2026-12-05T08:00:00.000Z", allDay: true, closed: false })).toBe(
      "17 days left",
    );
    expect(countdown({ _tag: "countdown", at: "2026-11-15T08:00:00.000Z", allDay: true, closed: false })).toBe(
      "3 days late",
    );
    expect(countdown({ _tag: "gone" })).toBe("Its source was removed");
    expect(
      kinCanvasWidgetView(
        widget({ kind: "facts", value: { _tag: "facts", open: 2, doing: 1, waiting: 0, late: 1 } }),
        now,
      ),
    ).toMatchObject({ headline: "3 tasks open", detail: "1 in progress · 1 late", tone: "late" });
  });

  it("names where an agent is working", () => {
    const base = {
      agentId: lead.agentId,
      name: "Tech lead",
      chatId: KinChatId.make("chat-1"),
      label: null,
      startedAt: now.toISOString(),
    };
    expect(kinCanvasActivityText({ ...base, state: "working", keys: ["W-14"] })).toBe(
      "Tech lead · working on W-14",
    );
    expect(kinCanvasActivityText({ ...base, state: "thinking", keys: [] })).toBe("Tech lead · thinking");
  });
});

describe("the canvas stream", () => {
  it("folds moves, widgets and activity into the held read", () => {
    let held = kinCanvasApply(null, { _tag: "snapshot", read: read() });
    held = kinCanvasApply(held, { _tag: "placed", places: [{ key: "W-1", x: 1, y: 2 }] });
    held = kinCanvasApply(held, { _tag: "placed", places: [{ key: "W-1", x: 5, y: 6 }] });
    expect(held?.places).toEqual([{ key: "W-1", x: 5, y: 6 }]);
    held = kinCanvasApply(held, { _tag: "widget", widget: widget() });
    held = kinCanvasApply(held, {
      _tag: "widget",
      widget: widget({ value: { _tag: "progress", done: 7, total: 13 } }),
    });
    expect(held?.widgets).toHaveLength(1);
    held = kinCanvasApply(held, { _tag: "placed", places: [{ key: "cw_abcdef", x: 0, y: 0 }] });
    held = kinCanvasApply(held, { _tag: "widgetRemoved", id: "cw_abcdef" });
    expect(held?.widgets).toEqual([]);
    expect(held?.places.map((p) => p.key)).toEqual(["W-1"]);
    held = kinCanvasApply(held, { _tag: "unplaced", keys: ["W-1"] });
    expect(held?.places).toEqual([]);
  });

  it("holds nothing until the snapshot", () => {
    expect(kinCanvasApply(null, { _tag: "placed", places: [] })).toBeNull();
  });
});
