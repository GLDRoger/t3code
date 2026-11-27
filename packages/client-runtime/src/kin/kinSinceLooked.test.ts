// @effect-diagnostics globalDate:off - Pure view tests construct fixed Date instants outside an Effect runtime.
import {
  KIN_RECORD_CHANGES_CAP,
  KinAgentId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  KinRecordKey,
  type KinDocDetail,
  type KinDocLatestSlim,
  type KinProjectPage,
  type KinRecordChange,
  type KinRecordComment,
  type KinRecordDetail,
  type KinWorkHistoryItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  kinDocLookedUpTo,
  kinDocSinceLooked,
  kinEntryLookedUpTo,
  kinEntrySinceLooked,
  kinProjectLookedUpTo,
  kinProjectSinceLooked,
  kinSinceWhen,
  mergePinnedDocSinceLooked,
  mergePinnedProjectSinceLooked,
  pinEntryLookedAt,
} from "./kinSinceLooked.ts";
import type { KinWorkNames } from "./kinWork.ts";

const orgId = KinOrgId.make("tidewater");
const rheaId = KinPersonId.make("rhea");
const meeraId = KinPersonId.make("meera");
const zoyaId = KinPersonId.make("zoya");
const chiefId = KinAgentId.make("chief");

const rhea = { _tag: "person", personId: rheaId } as const;
const meera = { _tag: "person", personId: meeraId } as const;
const zoya = { _tag: "person", personId: zoyaId } as const;
const chief = { _tag: "agent", agentId: chiefId } as const;

const names: KinWorkNames = {
  people: new Map([
    [rheaId, "Rhea"],
    [meeraId, "Meera"],
    [zoyaId, "Zoya"],
  ]),
  agents: new Map([[chiefId, "Chief of staff"]]),
  me: rheaId,
  owner: rheaId,
  zone: "UTC",
  readerZone: "UTC",
};

// Friday, 27 Nov 2026 14:00 UTC
const now = new Date("2026-11-27T14:00:00.000Z");

function change(overrides: Partial<KinRecordChange> = {}): KinRecordChange {
  return {
    seq: 1,
    at: "2026-11-26T10:00:00.000Z",
    by: meera,
    via: "owner",
    kind: "updated",
    fields: [{ field: "state", from: "open", to: "doing" }],
    ...overrides,
  };
}

function comment(overrides: Partial<KinRecordComment> = {}): KinRecordComment {
  return {
    commentId: "cmt-1",
    seq: 1,
    at: "2026-11-26T11:00:00.000Z",
    by: zoya,
    body: "Checked the schedule.",
    files: [],
    ...overrides,
  } as unknown as KinRecordComment;
}

function entry(overrides: Partial<KinRecordDetail> = {}): KinRecordDetail {
  return {
    recordId: KinRecordId.make("rec-w12"),
    orgId,
    key: KinRecordKey.make("W-12"),
    title: "Confirm cold-chain carrier",
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
    rev: 2,
    createdAt: "2026-11-20T09:00:00.000Z",
    updatedAt: "2026-11-26T12:00:00.000Z",
    closedAt: null,
    lookedAt: "2026-11-24T12:00:00.000Z",
    notes: "",
    source: { chatId: null, messageId: null },
    assignedBy: rhea,
    assignedAt: "2026-11-20T09:00:00.000Z",
    createdBy: rhea,
    links: [],
    changes: [],
    comments: [],
    seq: 2,
    ...overrides,
  } as unknown as KinRecordDetail;
}

function docVersion(overrides: Partial<KinDocLatestSlim> = {}): KinDocLatestSlim {
  return {
    version: 3,
    at: "2026-11-26T10:00:00.000Z",
    kind: "edited",
    summary: "Updated cold-chain pricing",
    provenance: { by: meera },
    ...overrides,
  };
}

function doc(overrides: Partial<KinDocDetail> = {}): KinDocDetail {
  return {
    recordId: KinRecordId.make("rec-d3"),
    key: KinRecordKey.make("D-3"),
    title: "Juniper Cold Chain brief",
    owner: chief,
    kind: "brief",
    sensitive: false,
    archived: false,
    bodyKind: "markdown",
    latest: {
      version: 4,
      at: "2026-11-26T12:00:00.000Z",
      kind: "edited",
      summary: "Updated cold-chain pricing",
      provenance: { by: meera },
      bodyKind: "markdown",
    },
    version: {
      version: 4,
      at: "2026-11-26T12:00:00.000Z",
      kind: "edited",
      summary: "Updated cold-chain pricing",
      provenance: { by: meera },
      bodyKind: "markdown",
    },
    lookedAt: "2026-11-24T12:00:00.000Z",
    body: "Body",
    outline: [],
    links: [],
    ...overrides,
  } as unknown as KinDocDetail;
}

function projectItem(overrides: Partial<KinWorkHistoryItem> = {}): KinWorkHistoryItem {
  return {
    seq: 10,
    at: "2026-11-26T10:00:00.000Z",
    by: meera,
    via: "owner",
    kind: "updated",
    fields: [{ field: "state", from: "open", to: "done" }],
    record: {
      recordId: KinRecordId.make("rec-w12"),
      key: KinRecordKey.make("W-12"),
      list: "work",
      title: "Confirm cold-chain carrier",
    },
    ...overrides,
  } as unknown as KinWorkHistoryItem;
}

function projectPage(overrides: Partial<KinProjectPage> = {}): KinProjectPage {
  return {
    project: {
      recordId: KinRecordId.make("rec-p1"),
      key: KinRecordKey.make("P-1"),
      title: "Tidewater Freight launch",
    },
    changedThisWeek: { items: [], total: 0 },
    lookedAt: "2026-11-24T12:00:00.000Z",
    asOf: "2026-11-27T14:00:00.000Z",
    seq: 12,
    ...overrides,
  } as unknown as KinProjectPage;
}

describe("kinSinceWhen", () => {
  it("formats earlier today, yesterday, weekdays within 6 days, and dates further back", () => {
    expect(kinSinceWhen("2026-11-27T08:00:00.000Z", now, names)).toBe("since earlier today");
    expect(kinSinceWhen("2026-11-26T22:00:00.000Z", now, names)).toBe("since yesterday");
    expect(kinSinceWhen("2026-11-24T12:00:00.000Z", now, names)).toBe("since Tuesday");
    expect(kinSinceWhen("2026-11-21T12:00:00.000Z", now, names)).toBe("since Saturday");
    expect(kinSinceWhen("2026-11-12T12:00:00.000Z", now, names)).toMatch(/^since (12 Nov|Nov 12)$/);
    expect(kinSinceWhen("2025-11-12T12:00:00.000Z", now, names)).toMatch(
      /^since (12 Nov 2025|Nov 12, 2025)$/,
    );
  });

  it("uses the reader's time zone for day boundaries", () => {
    const istNames: KinWorkNames = { ...names, zone: "UTC", readerZone: "Asia/Kolkata" };
    // 2026-11-27T14:00Z is 19:30 IST on 27 Nov; 2026-11-26T19:00Z is 00:30 IST on 27 Nov (same day in IST).
    expect(kinSinceWhen("2026-11-26T19:00:00.000Z", now, istNames)).toBe("since earlier today");
  });
});

describe("kinEntrySinceLooked", () => {
  it("returns null on a first visit, older host, or when nothing changed after the mark", () => {
    expect(kinEntrySinceLooked(entry({ changes: [change()] }), null, names, now)).toBeNull();
    expect(kinEntrySinceLooked(entry({ changes: [change()] }), undefined, names, now)).toBeNull();
    expect(
      kinEntrySinceLooked(
        entry({
          changes: [
            change({ at: "2026-11-24T12:00:00.000Z" }),
            change({ seq: 2, at: "2026-11-23T12:00:00.000Z" }),
          ],
          comments: [comment({ at: "2026-11-24T12:00:00.000Z" })],
        }),
        "2026-11-24T12:00:00.000Z",
        names,
        now,
      ),
    ).toBeNull();
  });

  it("excludes the reader's own direct changes and coding-agent key changes", () => {
    const item = entry({
      changes: [
        change({ seq: 2, by: rhea, at: "2026-11-26T10:00:00.000Z" }),
        change({
          seq: 3,
          by: rhea,
          codingAgent: "Work laptop",
          at: "2026-11-26T11:00:00.000Z",
        }),
      ],
      comments: [comment({ by: rhea, at: "2026-11-26T12:00:00.000Z" })],
    });
    expect(kinEntrySinceLooked(item, "2026-11-24T12:00:00.000Z", names, now)).toBeNull();
  });

  it("formats a single change cleanly", () => {
    const item = entry({
      changes: [
        change({
          at: "2026-11-26T10:00:00.000Z",
          fields: [{ field: "state", from: "open", to: "doing" }],
        }),
      ],
    });
    const view = kinEntrySinceLooked(item, "2026-11-24T12:00:00.000Z", names, now);
    expect(view).toEqual({
      lead: "1 change since Tuesday",
      lines: ["Meera started on it"],
      more: null,
      text: "1 change since Tuesday: Meera started on it",
      variants: ["1 change since Tuesday: Meera started on it"],
      opens: { kind: "history" },
      accessibilityLabel: "1 change since Tuesday: Meera started on it. Open history.",
    });
  });

  it("shows a change made by an agent FOR the reader, and distinguishes agent-for-other and autonomous", () => {
    const item = entry({
      changes: [
        change({
          seq: 3,
          by: chief,
          via: "lead",
          askedBy: rheaId,
          at: "2026-11-26T12:00:00.000Z",
          fields: [{ field: "state", from: "open", to: "doing" }],
        }),
        change({
          seq: 2,
          by: chief,
          via: "lead",
          askedBy: meeraId,
          at: "2026-11-26T11:00:00.000Z",
          fields: [{ field: "title", from: "Old", to: "New" }],
        }),
        change({
          seq: 1,
          by: chief,
          via: "lead",
          at: "2026-11-26T10:00:00.000Z",
          kind: "linked",
          fields: [{ field: "url", from: null, to: "https://example.com" }],
        }),
      ],
    });
    const view = kinEntrySinceLooked(item, "2026-11-24T12:00:00.000Z", names, now);
    expect(view).not.toBeNull();
    expect(view?.lead).toBe("3 changes since Tuesday");
    expect(view?.lines).toEqual([
      "Chief of staff, for you, started on it",
      "Meera, via Chief of staff, renamed it",
      "Chief of staff added a link",
    ]);
    expect(view?.more).toBeNull();
  });

  it("shows 2 lines plus 'and N more' for 4+ changes and includes comments newest first", () => {
    const item = entry({
      changes: [
        change({ seq: 3, by: meera, at: "2026-11-26T12:00:00.000Z" }),
        change({
          seq: 2,
          by: chief,
          at: "2026-11-26T10:00:00.000Z",
          kind: "linked",
          fields: [{ field: "url", from: null, to: "https://example.com" }],
        }),
        change({
          seq: 1,
          by: zoya,
          at: "2026-11-25T09:00:00.000Z",
          fields: [{ field: "notes", from: "", to: "Added context" }],
        }),
      ],
      comments: [
        comment({ commentId: "c1", seq: 1, by: zoya, at: "2026-11-26T11:00:00.000Z" }),
        // Removed comments are not shown or counted.
        comment({
          commentId: "c2",
          seq: 2,
          by: meera,
          at: "2026-11-26T13:00:00.000Z",
          removed: { at: "2026-11-26T13:05:00.000Z", by: meera },
        }),
      ],
    });
    const view = kinEntrySinceLooked(item, "2026-11-24T12:00:00.000Z", names, now);
    expect(view?.lead).toBe("4 changes since Tuesday");
    expect(view?.lines).toEqual(["Meera started on it", "Zoya commented"]);
    expect(view?.more).toBe("and 2 more");
    expect(view?.text).toBe(
      "4 changes since Tuesday: Meera started on it · Zoya commented · and 2 more",
    );
  });

  it("collapses equal neighbouring fragments with a count, keeps the leading total, and counts unshown changes in 'and N more'", () => {
    const briefEdit = (seq: number, at: string) =>
      change({
        seq,
        by: meera,
        at,
        fields: [{ field: "notes", from: "a", to: "b" }],
      });
    // 5 changes: 2 neighbouring brief edits by Meera, 1 comment by Zoya, 2 older changes.
    const five = entry({
      changes: [
        briefEdit(5, "2026-11-26T14:00:00.000Z"),
        briefEdit(4, "2026-11-26T13:00:00.000Z"),
        change({
          seq: 2,
          by: chief,
          at: "2026-11-26T10:00:00.000Z",
          kind: "linked",
          fields: [{ field: "url", from: null, to: "https://example.com" }],
        }),
        change({
          seq: 1,
          by: meera,
          at: "2026-11-25T09:00:00.000Z",
          fields: [{ field: "title", from: "Old", to: "New" }],
        }),
      ],
      comments: [comment({ commentId: "c1", seq: 3, by: zoya, at: "2026-11-26T11:00:00.000Z" })],
    });
    const view5 = kinEntrySinceLooked(five, "2026-11-24T12:00:00.000Z", names, now);
    expect(view5?.lead).toBe("5 changes since Tuesday");
    expect(view5?.lines).toEqual(["Meera changed the brief (2)", "Zoya commented"]);
    expect(view5?.more).toBe("and 2 more");
    expect(view5?.text).toBe(
      "5 changes since Tuesday: Meera changed the brief (2) · Zoya commented · and 2 more",
    );

    // 4 changes that collapse into 3 fragments show all 3 with no tail.
    const fourFit = entry({
      changes: [
        briefEdit(4, "2026-11-26T14:00:00.000Z"),
        briefEdit(3, "2026-11-26T13:00:00.000Z"),
        change({
          seq: 1,
          by: meera,
          at: "2026-11-25T09:00:00.000Z",
          fields: [{ field: "title", from: "Old", to: "New" }],
        }),
      ],
      comments: [comment({ commentId: "c1", seq: 2, by: zoya, at: "2026-11-26T11:00:00.000Z" })],
    });
    const view4 = kinEntrySinceLooked(fourFit, "2026-11-24T12:00:00.000Z", names, now);
    expect(view4?.lead).toBe("4 changes since Tuesday");
    expect(view4?.lines).toEqual([
      "Meera changed the brief (2)",
      "Zoya commented",
      "Meera renamed it",
    ]);
    expect(view4?.more).toBeNull();

    // Non-neighbouring equal fragments stay separate.
    const split = entry({
      changes: [briefEdit(3, "2026-11-26T14:00:00.000Z"), briefEdit(1, "2026-11-26T10:00:00.000Z")],
      comments: [comment({ commentId: "c1", seq: 2, by: zoya, at: "2026-11-26T12:00:00.000Z" })],
    });
    const viewSplit = kinEntrySinceLooked(split, "2026-11-24T12:00:00.000Z", names, now);
    expect(viewSplit?.lines).toEqual([
      "Meera changed the brief",
      "Zoya commented",
      "Meera changed the brief",
    ]);

    // Capped history collapses neighbouring duplicates too while keeping "and many more".
    const cappedChanges = Array.from({ length: KIN_RECORD_CHANGES_CAP }, (_, i) =>
      i < 2
        ? briefEdit(
            KIN_RECORD_CHANGES_CAP - i,
            new Date(Date.parse("2026-11-26T12:00:00.000Z") - i * 60_000).toISOString(),
          )
        : change({
            seq: KIN_RECORD_CHANGES_CAP - i,
            by: i % 2 === 0 ? meera : zoya,
            at: new Date(Date.parse("2026-11-26T12:00:00.000Z") - i * 60_000).toISOString(),
          }),
    );
    const viewCapped = kinEntrySinceLooked(
      entry({ changes: cappedChanges }),
      "2026-11-24T12:00:00.000Z",
      names,
      now,
    );
    expect(viewCapped?.lead).toBe("50+ changes since Tuesday");
    expect(viewCapped?.lines).toEqual(["Meera changed the brief (2)", "Meera started on it"]);
    expect(viewCapped?.more).toBe("and many more");
  });

  it("provides shorter variants that drop trailing whole fragments and raise 'and N more' for narrow widths", () => {
    const four = entry({
      changes: [
        change({
          seq: 4,
          by: chief,
          via: "lead",
          askedBy: rheaId,
          at: "2026-11-26T14:00:00.000Z",
          fields: [{ field: "steps", from: "", to: "step" }],
        }),
        change({
          seq: 3,
          by: meera,
          at: "2026-11-26T13:00:00.000Z",
          fields: [{ field: "title", from: "Old", to: "New" }],
        }),
        change({
          seq: 2,
          by: zoya,
          at: "2026-11-26T12:00:00.000Z",
          fields: [{ field: "notes", from: "", to: "a" }],
        }),
        change({
          seq: 1,
          by: meera,
          at: "2026-11-26T11:00:00.000Z",
          fields: [{ field: "state", from: "open", to: "doing" }],
        }),
      ],
    });
    const view4 = kinEntrySinceLooked(four, "2026-11-24T12:00:00.000Z", names, now);
    expect(view4?.variants).toEqual([
      "4 changes since Tuesday: Chief of staff, for you, changed its steps · Meera renamed it · and 2 more",
      "4 changes since Tuesday: Chief of staff, for you, changed its steps · and 3 more",
    ]);

    // Dropping a collapsed fragment raises N by its collapsed count.
    const collapsedTail = entry({
      changes: [
        change({
          seq: 5,
          by: zoya,
          at: "2026-11-26T15:00:00.000Z",
          fields: [{ field: "title", from: "A", to: "B" }],
        }),
        change({
          seq: 4,
          by: meera,
          at: "2026-11-26T14:00:00.000Z",
          fields: [{ field: "notes", from: "a", to: "b" }],
        }),
        change({
          seq: 3,
          by: meera,
          at: "2026-11-26T13:00:00.000Z",
          fields: [{ field: "notes", from: "b", to: "c" }],
        }),
        change({
          seq: 2,
          by: chief,
          at: "2026-11-26T12:00:00.000Z",
          kind: "linked",
          fields: [{ field: "url", from: null, to: "https://example.com" }],
        }),
        change({
          seq: 1,
          by: meera,
          at: "2026-11-26T11:00:00.000Z",
          fields: [{ field: "state", from: "open", to: "doing" }],
        }),
      ],
    });
    const viewCollapsed = kinEntrySinceLooked(
      collapsedTail,
      "2026-11-24T12:00:00.000Z",
      names,
      now,
    );
    expect(viewCollapsed?.variants).toEqual([
      "5 changes since Tuesday: Zoya renamed it · Meera changed the brief (2) · and 2 more",
      "5 changes since Tuesday: Zoya renamed it · and 4 more",
    ]);

    // A 3-change summary with no initial tail gains "and 1 more" / "and 2 more" as fragments drop.
    const three = entry({
      changes: [
        change({
          seq: 3,
          by: zoya,
          at: "2026-11-26T13:00:00.000Z",
          fields: [{ field: "title", from: "A", to: "B" }],
        }),
        change({
          seq: 2,
          by: meera,
          at: "2026-11-26T12:00:00.000Z",
          fields: [{ field: "notes", from: "", to: "a" }],
        }),
        change({
          seq: 1,
          by: meera,
          at: "2026-11-26T11:00:00.000Z",
          fields: [{ field: "state", from: "open", to: "doing" }],
        }),
      ],
    });
    const view3 = kinEntrySinceLooked(three, "2026-11-24T12:00:00.000Z", names, now);
    expect(view3?.variants).toEqual([
      "3 changes since Tuesday: Zoya renamed it · Meera changed the brief · Meera started on it",
      "3 changes since Tuesday: Zoya renamed it · Meera changed the brief · and 1 more",
      "3 changes since Tuesday: Zoya renamed it · and 2 more",
    ]);
  });

  it("says 'and many more' when changes hit the 50-change cap newer than the mark", () => {
    const changes = Array.from({ length: KIN_RECORD_CHANGES_CAP }, (_, i) =>
      change({
        seq: KIN_RECORD_CHANGES_CAP - i,
        by: i % 2 === 0 ? meera : zoya,
        at: new Date(Date.parse("2026-11-26T12:00:00.000Z") - i * 60_000).toISOString(),
      }),
    );
    const view = kinEntrySinceLooked(entry({ changes }), "2026-11-24T12:00:00.000Z", names, now);
    expect(view?.lead).toBe("50+ changes since Tuesday");
    expect(view?.lines).toHaveLength(2);
    expect(view?.more).toBe("and many more");
    expect(view?.text).toContain("and many more");
  });

  it("keeps an all-day due date on the company's calendar day even when the reader is in another time zone", () => {
    // All-day 4 Dec in Asia/Kolkata ends at 18:29:59.999Z, already 5 Dec in Pacific/Auckland.
    const crossZoneNames: KinWorkNames = {
      ...names,
      zone: "Asia/Kolkata",
      readerZone: "Pacific/Auckland",
    };
    const item = entry({
      changes: [
        change({
          at: "2026-11-26T10:00:00.000Z",
          fields: [
            { field: "due", from: null, to: "2026-12-04T18:29:59.999Z" },
            { field: "dueAllDay", from: "false", to: "true" },
          ],
        }),
      ],
    });
    const view = kinEntrySinceLooked(item, "2026-11-24T12:00:00.000Z", crossZoneNames, now);
    expect(view?.lines[0]).toMatch(/Meera set it due Fri,? (4 Dec|Dec 4)$/);
  });

  it("uses list-entry wording and shows agent comments made for the reader", () => {
    const item = entry({
      list: "invoices" as KinRecordDetail["list"],
      changes: [
        change({
          seq: 2,
          by: meera,
          at: "2026-11-26T10:00:00.000Z",
          fields: [{ field: "state", from: "waiting", to: "done" }],
        }),
      ],
      comments: [
        comment({
          commentId: "c-agent",
          seq: 1,
          by: chief,
          askedBy: rheaId,
          at: "2026-11-26T11:00:00.000Z",
        }),
      ],
    });
    const view = kinEntrySinceLooked(item, "2026-11-24T12:00:00.000Z", names, now);
    expect(view?.lines).toEqual(["Chief of staff, for you, commented", "Meera marked it paid"]);
  });

  it("derives upTo as the newest timestamp shown and returns null on older hosts", () => {
    expect(kinEntryLookedUpTo(entry({ lookedAt: undefined }))).toBeNull();
    expect(
      kinEntryLookedUpTo(
        entry({
          updatedAt: "2026-11-26T10:00:00.000Z",
          changes: [change({ at: "2026-11-26T11:00:00.000Z" })],
          comments: [comment({ at: "2026-11-26T12:30:00.000Z" })],
        }),
      ),
    ).toBe("2026-11-26T12:30:00.000Z");
  });
});

describe("kinDocSinceLooked", () => {
  it("formats server-filtered versions, opens a diff from `from`, and keeps agent-for-reader edits", () => {
    const summary: NonNullable<KinDocDetail["sinceLooked"]> = {
      total: 4,
      from: 2,
      versions: [
        docVersion({
          version: 6,
          at: "2026-11-26T14:00:00.000Z",
          summary: "Tightened delivery SLA",
          provenance: { by: chief },
          askedBy: rheaId,
        }),
        docVersion({
          version: 5,
          at: "2026-11-26T12:00:00.000Z",
          summary: "Added customs checklist",
          provenance: { by: meera },
        }),
        docVersion({
          version: 4,
          at: "2026-11-25T09:00:00.000Z",
          summary: "Fixed typos",
          provenance: { by: zoya },
        }),
      ],
    };
    const d = doc({
      version: { ...doc().version, version: 6 },
      latest: { ...doc().latest, version: 6 },
      sinceLooked: summary,
    });
    const view = kinDocSinceLooked(d, "2026-11-24T12:00:00.000Z", summary, names, now);
    expect(view).toEqual({
      lead: "4 changes since Tuesday",
      lines: ["Chief of staff, for you: Tightened delivery SLA", "Meera: Added customs checklist"],
      more: "and 2 more",
      text: "4 changes since Tuesday: Chief of staff, for you: Tightened delivery SLA · Meera: Added customs checklist · and 2 more",
      variants: [
        "4 changes since Tuesday: Chief of staff, for you: Tightened delivery SLA · Meera: Added customs checklist · and 2 more",
        "4 changes since Tuesday: Chief of staff, for you: Tightened delivery SLA · and 3 more",
      ],
      opens: { kind: "diff", from: 2, to: 6 },
      accessibilityLabel:
        "4 changes since Tuesday: Chief of staff, for you: Tightened delivery SLA · Meera: Added customs checklist · and 2 more. Compare with the version you last saw.",
    });
  });

  it("returns null when the single change since looked is already named by the doc's Updated line", () => {
    const sameVersion: NonNullable<KinDocDetail["sinceLooked"]> = {
      total: 1,
      from: 1,
      versions: [
        docVersion({
          version: 2,
          at: "2026-11-27T13:24:00.000Z",
          summary: 'Changed "When this applies" by hand',
          provenance: { by: meera },
        }),
      ],
    };
    const d2 = doc({
      version: { ...doc().version, version: 2, summary: 'Changed "When this applies" by hand' },
      latest: { ...doc().latest, version: 2, summary: 'Changed "When this applies" by hand' },
      sinceLooked: sameVersion,
    });
    expect(kinDocSinceLooked(d2, "2026-11-27T10:00:00.000Z", sameVersion, names, now)).toBeNull();

    // If the reader saved a newer version after Meera's edit, the Updated line names v3, not v2.
    const d3 = doc({
      version: {
        ...doc().version,
        version: 3,
        provenance: { ...doc().version.provenance, by: rhea },
      },
      latest: {
        ...doc().latest,
        version: 3,
        provenance: { ...doc().latest.provenance, by: rhea },
      },
      sinceLooked: sameVersion,
    });
    const kept = kinDocSinceLooked(d3, "2026-11-27T10:00:00.000Z", sameVersion, names, now);
    expect(kept?.text).toBe(
      '1 change since earlier today: Meera: Changed "When this applies" by hand',
    );

    // Two or more changes are still drawn even when the newest matches doc.version.
    const twoChanges: NonNullable<KinDocDetail["sinceLooked"]> = {
      total: 2,
      from: 1,
      versions: [
        docVersion({ version: 3, at: "2026-11-27T13:24:00.000Z", summary: "Second edit" }),
        docVersion({ version: 2, at: "2026-11-27T12:00:00.000Z", summary: "First edit" }),
      ],
    };
    const dTwo = doc({
      version: { ...doc().version, version: 3 },
      latest: { ...doc().latest, version: 3 },
      sinceLooked: twoChanges,
    });
    expect(kinDocSinceLooked(dTwo, "2026-11-27T10:00:00.000Z", twoChanges, names, now)?.lead).toBe(
      "2 changes since earlier today",
    );
  });

  it("returns null upTo for old or explicit versions and older hosts", () => {
    expect(kinDocLookedUpTo(doc({ lookedAt: undefined }), { isLatest: true })).toBeNull();
    expect(kinDocLookedUpTo(doc(), { isLatest: false })).toBeNull();
    expect(kinDocLookedUpTo(doc(), { isLatest: true })).toBe("2026-11-26T12:00:00.000Z");
  });
});

describe("kinProjectSinceLooked", () => {
  it("uses server total and items without widening, names child records, and keeps agent-for-reader edits", () => {
    const summary: NonNullable<KinProjectPage["sinceLooked"]> = {
      total: 2,
      items: [
        projectItem({
          seq: 11,
          by: chief,
          via: "lead",
          askedBy: rheaId,
          fields: [{ field: "state", from: "open", to: "done" }],
          record: {
            recordId: KinRecordId.make("rec-w12"),
            key: KinRecordKey.make("W-12"),
            list: "work",
            title: "Confirm cold-chain carrier",
          },
        }),
        projectItem({
          seq: 10,
          by: meera,
          fields: [{ field: "due", from: null, to: "2026-12-04T23:59:59.999Z" }],
          record: {
            recordId: KinRecordId.make("rec-p1"),
            key: KinRecordKey.make("P-1"),
            list: "projects",
            title: "Tidewater Freight launch",
          },
        }),
      ],
    };
    const p = projectPage({ sinceLooked: summary });
    const view = kinProjectSinceLooked(p, "2026-11-24T12:00:00.000Z", summary, names, now);
    expect(view?.lead).toBe("2 changes since Tuesday");
    expect(view?.lines[0]).toBe(
      "Chief of staff, for you, finished it (Confirm cold-chain carrier)",
    );
    expect(view?.lines[1]).toMatch(/^Meera set the target to Fri,? (4 Dec|Dec 4)$/);
    expect(view?.opens).toEqual({ kind: "projectHistory" });
    expect(view?.accessibilityLabel).toMatch(/\. Open project history\.$/);
    expect(kinProjectLookedUpTo(p)).toBe("2026-11-27T14:00:00.000Z");
    expect(kinProjectLookedUpTo(projectPage({ lookedAt: undefined }))).toBeNull();
  });

  it("ends the accessible name with 'Show this week's changes.' when tapping opens This week instead of project history", () => {
    const summary: NonNullable<KinProjectPage["sinceLooked"]> = {
      total: 1,
      items: [projectItem()],
    };
    const p = projectPage({ sinceLooked: summary });
    const ownerView = kinProjectSinceLooked(p, "2026-11-24T12:00:00.000Z", summary, names, now, {
      opensHistory: true,
    });
    expect(ownerView?.opens).toEqual({ kind: "projectHistory" });
    expect(ownerView?.accessibilityLabel).toBe(
      "1 change since Tuesday: Meera finished it (Confirm cold-chain carrier). Open project history.",
    );

    const teammateView = kinProjectSinceLooked(p, "2026-11-24T12:00:00.000Z", summary, names, now, {
      opensHistory: false,
    });
    expect(teammateView?.opens).toEqual({ kind: "projectThisWeek" });
    expect(teammateView?.accessibilityLabel).toBe(
      "1 change since Tuesday: Meera finished it (Confirm cold-chain carrier). Show this week's changes.",
    );
  });
});

describe("pinning across live re-reads", () => {
  it("keeps the initial entry mark for the whole visit and resets for another record", () => {
    const first = pinEntryLookedAt(null, KinRecordId.make("rec-1"), "2026-11-24T12:00:00.000Z");
    const afterLook = pinEntryLookedAt(
      first,
      KinRecordId.make("rec-1"),
      "2026-11-27T14:00:00.000Z",
    );
    expect(afterLook?.lookedAt).toBe("2026-11-24T12:00:00.000Z");
    const other = pinEntryLookedAt(afterLook, KinRecordId.make("rec-2"), null);
    expect(other?.lookedAt).toBeNull();
  });

  it("keeps a doc summary when looked moves the mark, and merges live arrivals without losing `from`", () => {
    const initial: NonNullable<KinDocDetail["sinceLooked"]> = {
      total: 1,
      from: 2,
      versions: [docVersion({ version: 3, at: "2026-11-26T10:00:00.000Z" })],
    };
    const pinned = mergePinnedDocSinceLooked(
      null,
      KinRecordId.make("rec-d3"),
      "2026-11-24T12:00:00.000Z",
      initial,
    );
    // Re-read after `looked` moved the mark to v3: server omits sinceLooked, pinned stays.
    const afterMark = mergePinnedDocSinceLooked(
      pinned,
      KinRecordId.make("rec-d3"),
      "2026-11-26T10:00:00.000Z",
      undefined,
    );
    expect(afterMark?.sinceLooked).toEqual(initial);
    // Live edit v4 arrives after the moved mark: joins the pinned summary with original `from: 2`.
    const live: NonNullable<KinDocDetail["sinceLooked"]> = {
      total: 1,
      from: 3,
      versions: [docVersion({ version: 4, at: "2026-11-27T14:01:00.000Z", summary: "Added note" })],
    };
    const afterLive = mergePinnedDocSinceLooked(
      afterMark,
      KinRecordId.make("rec-d3"),
      "2026-11-26T10:00:00.000Z",
      live,
    );
    expect(afterLive?.sinceLooked?.from).toBe(2);
    expect(afterLive?.sinceLooked?.total).toBe(2);
    expect(afterLive?.sinceLooked?.versions.map((v) => v.version)).toEqual([4, 3]);
    // Re-rendering with the same inputs returns the exact same reference (no render loop).
    expect(
      mergePinnedDocSinceLooked(
        afterLive,
        KinRecordId.make("rec-d3"),
        "2026-11-26T10:00:00.000Z",
        live,
      ),
    ).toBe(afterLive);
    // A second live edit v5 before the mark moves again does not double-count v4.
    const live2: NonNullable<KinDocDetail["sinceLooked"]> = {
      total: 2,
      from: 3,
      versions: [
        docVersion({ version: 5, at: "2026-11-27T14:02:00.000Z", summary: "Second note" }),
        docVersion({ version: 4, at: "2026-11-27T14:01:00.000Z", summary: "Added note" }),
      ],
    };
    const afterLive2 = mergePinnedDocSinceLooked(
      afterLive,
      KinRecordId.make("rec-d3"),
      "2026-11-26T10:00:00.000Z",
      live2,
    );
    expect(afterLive2?.sinceLooked?.from).toBe(2);
    expect(afterLive2?.sinceLooked?.total).toBe(3);
    expect(afterLive2?.sinceLooked?.versions.map((v) => v.version)).toEqual([5, 4, 3]);
  });

  it("pins the fresh copy on a revisit, not the cached one read before this app's last look", () => {
    const doc = KinRecordId.make("rec-d10");
    const v3 = "2026-11-27T09:00:00.000Z";
    const v5 = "2026-11-27T11:16:00.000Z";
    const seenBefore: NonNullable<KinDocDetail["sinceLooked"]> = {
      total: 2,
      from: 3,
      versions: [docVersion({ version: 5, at: v5 }), docVersion({ version: 4 })],
    };
    const newer: NonNullable<KinDocDetail["sinceLooked"]> = {
      total: 2,
      from: 5,
      versions: [
        docVersion({ version: 7, at: "2026-11-27T13:30:00.000Z" }),
        docVersion({ version: 6, at: "2026-11-27T13:20:00.000Z" }),
      ],
    };
    // The cache's copy from the earlier visit draws first; this app already moved the mark to v5.
    const cached = mergePinnedDocSinceLooked(null, doc, v3, seenBefore, v5);
    const fresh = mergePinnedDocSinceLooked(cached, doc, v5, newer, v5);
    expect(fresh?.sinceLooked).toEqual(newer);
    expect(fresh?.lookedAt).toBe(v5);

    // Within one visit the line stays after this visit's own look moves the mark to v5.
    const opened = mergePinnedDocSinceLooked(null, doc, v3, seenBefore, null);
    const reread = mergePinnedDocSinceLooked(opened, doc, v5, undefined, v5);
    expect(reread?.sinceLooked).toEqual(seenBefore);
    expect(reread?.lookedAt).toBe(v3);

    const project = KinRecordId.make("rec-p1");
    const cachedPage = mergePinnedProjectSinceLooked(
      null,
      project,
      v3,
      { total: 1, items: [projectItem({ seq: 10 })] },
      v5,
    );
    const freshPage = mergePinnedProjectSinceLooked(
      cachedPage,
      project,
      v5,
      { total: 1, items: [projectItem({ seq: 12 })] },
      v5,
    );
    expect(freshPage?.sinceLooked?.items.map((i) => i.seq)).toEqual([12]);
  });

  it("keeps a project summary when looked moves the mark and merges live arrivals", () => {
    const initial: NonNullable<KinProjectPage["sinceLooked"]> = {
      total: 1,
      items: [projectItem({ seq: 10 })],
    };
    const pinned = mergePinnedProjectSinceLooked(
      null,
      KinRecordId.make("rec-p1"),
      "2026-11-24T12:00:00.000Z",
      initial,
    );
    const afterMark = mergePinnedProjectSinceLooked(
      pinned,
      KinRecordId.make("rec-p1"),
      "2026-11-27T14:00:00.000Z",
      undefined,
    );
    expect(afterMark?.sinceLooked).toEqual(initial);
    const live: NonNullable<KinProjectPage["sinceLooked"]> = {
      total: 2,
      items: [projectItem({ seq: 12 }), projectItem({ seq: 11 })],
    };
    const afterLive = mergePinnedProjectSinceLooked(
      afterMark,
      KinRecordId.make("rec-p1"),
      "2026-11-27T14:00:00.000Z",
      live,
    );
    expect(afterLive?.sinceLooked?.total).toBe(3);
    expect(afterLive?.sinceLooked?.items.map((i) => i.seq)).toEqual([12, 11, 10]);
  });
});
