// @effect-diagnostics globalDate:off - Fixtures build ISO times relative to a fixed clock.
import {
  KinAgentId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type KinDocListRow,
  type KinProjectRow,
  type KinRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinCanvasClampScale,
  kinCanvasDetail,
  kinCanvasFit,
  kinCanvasZoom,
} from "./kinCanvasCamera.ts";
import { kinCanvasLayout, kinCanvasOverlaps } from "./kinCanvasLayout.ts";
import { kinCanvasModel, kinCanvasStatus } from "./kinCanvasView.ts";
import type { KinWorkNames } from "./kinWork.ts";

const orgId = KinOrgId.make("invented-org");
const me = { _tag: "person", personId: KinPersonId.make("invented-owner") } as const;
const lead = { _tag: "agent", agentId: KinAgentId.make("invented-lead") } as const;
const names: KinWorkNames = {
  people: new Map([[me.personId, "Invented Owner"]]),
  agents: new Map([[lead.agentId, "Tech lead"]]),
  me: me.personId,
  zone: "UTC",
};
const now = new Date("2026-11-18T08:00:00.000Z");
const ref = (key: string, title: string) => ({
  recordId: KinRecordId.make(`rec-${key}`),
  key,
  title,
});
const task = (patch: Partial<KinRecord> = {}): KinRecord => ({
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
  rev: 1,
  createdAt: "2026-11-10T08:00:00.000Z",
  updatedAt: "2026-11-10T08:00:00.000Z",
  closedAt: null,
  ...patch,
});
const doc = (patch: Partial<KinDocListRow> = {}): KinDocListRow => ({
  recordId: KinRecordId.make("rec-d1"),
  key: "D-1",
  title: "Invented brief",
  owner: lead,
  sensitive: false,
  archived: false,
  bodyKind: "markdown",
  latest: {
    version: 2,
    at: "2026-11-17T08:00:00.000Z",
    kind: "edited",
    summary: "Added the launch dates",
    provenance: { by: lead },
  },
  createdAt: "2026-11-01T08:00:00.000Z",
  updatedAt: "2026-11-17T08:00:00.000Z",
  rev: 2,
  ...patch,
});
const projectRow = (
  key: string,
  name: string,
  patch: Partial<KinProjectRow> = {},
): KinProjectRow => ({
  recordId: KinRecordId.make(`rec-${key}`),
  key,
  name,
  party: null,
  owner: me,
  state: "open",
  targetAt: null,
  targetAllDay: false,
  open: 4,
  late: 0,
  health: "on_track",
  sensitive: false,
  sensitiveInherited: false,
  rev: 1,
  ...patch,
});

describe("canvas layout", () => {
  const groups = [
    { key: "a", title: "Launch site" },
    { key: "b", title: "Everything else" },
  ];
  const items = Array.from({ length: 9 }, (_, i) => ({
    key: `W-${i + 1}`,
    group: i < 7 ? "a" : "b",
  }));

  it("lays out the same input the same way, areas in order, no card covering another", () => {
    const a = kinCanvasLayout({ groups, items });
    expect([...a.cards.values()]).toEqual([...kinCanvasLayout({ groups, items }).cards.values()]);
    const boxes = [...a.cards.values()];
    for (const box of boxes)
      for (const other of boxes)
        if (other !== box) expect(kinCanvasOverlaps(box, other)).toBe(false);
    expect(a.groups.map((g) => g.key)).toEqual(["a", "b"]);
    for (const card of boxes) {
      const area = a.groups.find((g) => g.key === card.group)!;
      expect(kinCanvasOverlaps(card, area)).toBe(true);
    }
  });

  it("leaves out an area with no cards", () => {
    const layout = kinCanvasLayout({ groups, items: items.slice(0, 3) });
    expect(layout.groups.map((g) => g.key)).toEqual(["a"]);
  });
});

describe("canvas camera", () => {
  it("fits a box inside the free part of the screen", () => {
    expect(kinCanvasFit({ x: 0, y: 0, w: 1000, h: 500 }, 1064, 564, undefined, 32)).toEqual({
      x: 500,
      y: 250,
      scale: 1,
    });
  });

  it("zooms about the pointer, keeping the point under it still", () => {
    const cam = kinCanvasZoom({ x: 0, y: 0, scale: 1 }, 2, 600, 300, 800, 600);
    expect((600 - 400) / cam.scale + cam.x).toBeCloseTo(200);
  });

  it("reads a card in place once it fills most of a phone, and never zooms past one card's width", () => {
    expect(kinCanvasDetail(0.1, 402)).toBe("dots");
    expect(kinCanvasDetail(0.4, 402)).toBe("titles");
    expect(kinCanvasDetail(1, 402)).toBe("cards");
    expect(kinCanvasDetail(1.3, 402)).toBe("near");
    expect(kinCanvasDetail(1.3, 1440)).toBe("cards");
    expect(kinCanvasDetail(1.6, 1440)).toBe("near");
    expect(kinCanvasClampScale(9, 402)).toBeCloseTo((402 - 24) / 240);
    expect(kinCanvasClampScale(9, 1440)).toBe(2.5);
  });
});

describe("canvas model", () => {
  it("puts each card in its project, else its client, else the company's docs, else the rest", () => {
    const model = kinCanvasModel({
      tasks: [
        task({ key: "W-1", project: ref("P-1", "Launch site") }),
        task({ key: "W-2", party: ref("C-1", "Invented Clinic") }),
        task({ key: "W-3" }),
      ],
      docs: [
        doc({ key: "D-1", company: true }),
        doc({ key: "D-2", project: ref("P-1", "Launch site") }),
      ],
      projects: [projectRow("P-1", "Launch site", { open: 12, late: 2 })],
      names,
      now,
    });
    expect(model.groups.map((g) => [g.title, g.kind])).toEqual([
      ["Launch site", "project"],
      ["Invented Clinic", "client"],
      ["Company", "company"],
      ["Everything else", "other"],
    ]);
    expect(model.items.filter((i) => i.group === "p:P-1").map((i) => i.key)).toEqual([
      "W-1",
      "D-2",
    ]);
    expect(model.groups[0]?.line).toBe("12 open · 2 late");
    expect(model.cards.get("D-1")?.summary).toBe("Added the launch dates");
  });

  it("puts areas with an agent at work first, then late projects, and lists what agents work on", () => {
    const model = kinCanvasModel({
      tasks: [
        task({ key: "W-1", project: ref("P-1", "Alpha") }),
        task({ key: "W-2", project: ref("P-2", "Beta"), late: true }),
        task({ key: "W-3", project: ref("P-3", "Gamma"), working: true }),
      ],
      docs: [],
      projects: [projectRow("P-2", "Beta", { late: 1 })],
      names,
      now,
    });
    expect(model.groups.map((g) => g.title)).toEqual(["Gamma", "Beta", "Alpha"]);
    expect(model.working).toEqual(["W-3"]);
    expect(model.cards.get("W-3")?.accessibilityLabel).toContain("An agent is working on it now");
    expect(model.cards.get("W-2")?.tone).toBe("late");
  });

  it("leaves out closed tasks, deleted docs and agents' characters", () => {
    const model = kinCanvasModel({
      tasks: [task({ key: "W-1", state: "done" }), task({ key: "W-2", state: "dropped" })],
      docs: [doc({ key: "D-1", archived: true }), doc({ key: "D-2", character: true })],
      projects: [],
      names,
      now,
    });
    expect(model.cards.size).toBe(0);
    expect(model.groups).toEqual([]);
  });
});

describe("canvas status", () => {
  it("keeps the cards on screen while a source reloads or fails, and blocks only with nothing to show", () => {
    // After the In progress / All open switch the task list reloads while the docs stay.
    expect(kinCanvasStatus({ refused: false, showing: true, sources: ["loading", "rows"] })).toBe(
      "ready",
    );
    expect(kinCanvasStatus({ refused: false, showing: true, sources: ["failed", "rows"] })).toBe(
      "ready",
    );
    expect(
      kinCanvasStatus({ refused: false, showing: false, sources: ["loading", "failed"] }),
    ).toBe("loading");
    expect(kinCanvasStatus({ refused: false, showing: false, sources: ["rows", "failed"] })).toBe(
      "failed",
    );
    expect(kinCanvasStatus({ refused: false, showing: false, sources: ["offline", "rows"] })).toBe(
      "offline",
    );
    expect(kinCanvasStatus({ refused: true, showing: false, sources: ["rows", "rows"] })).toBe(
      "refused",
    );
  });
});
