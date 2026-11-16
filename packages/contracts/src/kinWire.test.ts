import { describe, expect, it } from "@effect/vitest";

import { KinOrgId } from "./kinChat.ts";
import type { KinPulseFact } from "./kinPulse.ts";
import type { KinRecord, KinRecordCan, KinWorkListResult } from "./kinWork.ts";
import { kinCompactWorkList, kinPulsePage, kinRestoreWorkList } from "./kinWire.ts";

// Invented rows only.
const orgId = KinOrgId.make("org");
const can = (edit: boolean): KinRecordCan => ({
  states: edit ? ["open", "done"] : [],
  edit,
  party: edit,
  project: edit,
  clearProject: edit,
  give: edit,
  takeBack: false,
  mark: edit,
  unmark: edit,
  share: false,
  confirm: false,
});
const record = (key: string, extra: Partial<KinRecord> = {}) =>
  ({
    recordId: `rec-${key}`,
    orgId,
    key,
    title: `Invented ${key}`,
    state: "open",
    waitingOn: null,
    owner: { _tag: "person", personId: "owner" },
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
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    closedAt: null,
    ...extra,
  }) as KinRecord;

describe("acceptCompactRows", () => {
  it("restores every row as it was, the odd `can` and every set field included", () => {
    const page: KinWorkListResult = {
      records: [
        record("W-1", { can: can(true) }),
        record("W-2", {
          can: can(true),
          waitingOn: { _tag: "person", personId: "ana" },
          category: "issue",
          dueAt: "2026-11-02T18:29:59.999Z",
          dueAllDay: true,
          late: true,
          confirmed: false,
          sensitive: true,
          working: true,
          pullRequest: { url: "https://example.invalid/pr/1", number: 1 },
          closedAt: "2026-11-03T00:00:00.000Z",
        }),
        record("W-3", { can: can(false) }),
      ],
      total: 3,
      nextCursor: null,
      seq: 9,
      asOf: "2026-11-04T00:00:00.000Z",
    };
    const compact = kinCompactWorkList(page);
    expect(compact.records).toEqual([]);
    expect(compact.can).toEqual(can(true));
    expect(compact.rows?.map((row) => row.can)).toEqual([undefined, undefined, can(false)]);
    expect(kinRestoreWorkList(compact, orgId)).toEqual(page);
  });

  it("sends no shared `can` when a row has none, so none is made up for it", () => {
    const page: KinWorkListResult = {
      records: [record("W-1", { can: can(true) }), record("W-2")],
      total: 2,
      nextCursor: null,
      seq: 1,
      asOf: "2026-11-04T00:00:00.000Z",
    };
    const compact = kinCompactWorkList(page);
    expect(compact.can).toBeUndefined();
    expect(kinRestoreWorkList(compact, orgId)).toEqual(page);
  });
});

describe("kinPulsePage", () => {
  const fact = (key: string, family: string, sense: string, handled = false) =>
    ({
      key,
      family,
      sense,
      subject: { kind: "record", key: key.toUpperCase(), title: key },
      handled: handled ? { by: { _tag: "person", personId: "owner" } } : null,
    }) as unknown as KinPulseFact;

  it("pages open facts urgent first and money last, keeps every handled one, and counts the rest", () => {
    const facts = [
      fact("m1", "money", "invoice_overdue"),
      fact("t1", "work", "task_waiting"),
      fact("t2", "work", "task_late"),
      fact("h1", "work", "task_late", true),
      fact("t3", "work", "task_waiting"),
    ];
    const page = kinPulsePage(facts, 2);
    expect(page.facts.map((one) => one.key)).toEqual(["t2", "t1", "h1"]);
    expect(page.outline).toEqual({
      open: 4,
      money: 1,
      moneyUrgent: true,
      records: ["M1", "T1", "T2", "H1", "T3"],
      invoiceOverdue: false,
    });
  });
});
