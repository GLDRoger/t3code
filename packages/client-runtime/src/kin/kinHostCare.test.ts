import { KinAgentId, KinWidgetId, type KinHostStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinFreeSpaceLine, kinHostPageView, kinHostTroubleCardView } from "./kinHostCare.ts";

const GB = 1024 ** 3;
const NOW = Date.parse("2026-11-22T10:00:00.000Z");
const at = (iso: string) => iso.slice(11, 16);
const chief = { agentId: KinAgentId.make("chief"), name: "Chief of staff" };

const trouble = (state: object) => ({ type: "host_trouble", state });

const status = (patch: Partial<KinHostStatus> = {}): KinHostStatus => ({
  host: true,
  space: {
    freeBytes: 40 * GB,
    totalBytes: 200 * GB,
    level: "ok",
    usage: {
      temporary: 2 * GB,
      builds: null,
      backups: 12 * GB,
      data: 3 * GB,
      measuredAt: "2026-11-22T09:00:00.000Z",
    },
  },
  backup: {
    configured: true,
    lastGoodAt: "2026-11-22T03:00:00.000Z",
    lastTriedAt: null,
    failed: null,
  },
  agents: { running: 0, held: 0, troubles: [] },
  version: "0.0.25",
  startedAt: "2026-11-21T08:00:00.000Z",
  ...patch,
});

describe("kinHostTroubleCardView", () => {
  it("offers the cause's taps while open, and only the fixed line once closed", () => {
    const open = {
      cause: "space",
      agents: [chief],
      count: 3,
      openedAt: "2026-11-22T09:00:00.000Z",
      closed: null,
    };
    expect(kinHostTroubleCardView(trouble(open), at)).toMatchObject({
      title: "Out of space",
      line: "Kin keeps the 3 held turns and runs them as soon as there is space.",
      actions: [
        { action: "free_space", label: "Free up space now" },
        { action: "retry", label: "Try again" },
      ],
      closed: false,
    });
    expect(
      kinHostTroubleCardView(
        trouble({ ...open, closed: { at: "2026-11-22T14:10:00.000Z", ran: 6 } }),
        at,
      ),
    ).toMatchObject({
      title: "Out of space · Fixed",
      line: "Fixed at 14:10. 6 held turns ran.",
      actions: [],
      closed: true,
    });
    // Copy details only when there is a line to copy; anything else is no card of this kind.
    expect(
      kinHostTroubleCardView(trouble({ ...open, cause: "unknown" }), at)?.actions.map(
        (one) => one.action,
      ),
    ).toEqual(["retry"]);
    expect(kinHostTroubleCardView(trouble({ cause: "space" }), at)).toBeNull();
  });
});

describe("kinHostPageView", () => {
  it("reads healthy, low, out of space, no backup yet and failing, and hides what a non-host can't do", () => {
    const healthy = kinHostPageView(status(), NOW);
    expect(healthy.space).toMatchObject({
      line: "40 GB free of 200 GB",
      level: "ok",
      used: 0.8,
      parts: [
        { name: "Kin's data", value: "3.0 GB" },
        { name: "Backups", value: "12 GB" },
        { name: "Temporary files", value: "2.0 GB" },
      ],
    });
    expect(healthy).toMatchObject({ canFreeSpace: true, canRetry: false, failing: [] });
    expect(healthy.backup?.canBackUp).toBe(true);

    const out = status({
      space: { freeBytes: 0, totalBytes: 200 * GB, level: "out", usage: null },
      backup: { configured: true, lastGoodAt: null, lastTriedAt: null, failed: null },
      agents: {
        running: 0,
        held: 4,
        troubles: [
          {
            widgetId: KinWidgetId.make("kin-trouble:o:space:1"),
            card: {
              cause: "space",
              agents: [chief, { agentId: KinAgentId.make("fin"), name: "Finance" }],
              count: 4,
              openedAt: "2026-11-22T09:00:00.000Z",
              closed: null,
            },
          },
        ],
      },
    });
    expect(kinHostPageView(out, NOW)).toMatchObject({
      space: {
        level: "out",
        used: 1,
        parts: [],
        partsNote: "Kin is still measuring what uses the space.",
      },
      backup: { title: "No good backup yet", canBackUp: true },
      failing: [{ title: "Out of space", detail: "Chief of staff and Finance · 4 turns waiting" }],
      canRetry: true,
    });

    // A dev or desktop server: no clean, no nightly backup, so neither shows.
    const notHost = kinHostPageView(status({ host: false, backup: null }), NOW);
    expect(notHost).toMatchObject({ canFreeSpace: false, backup: null });
    expect(notHost.space?.partsNote).toBeNull();
  });

  it("says what Free up space now gave back, or that nothing was old enough", () => {
    expect(kinFreeSpaceLine({ ran: true, removed: 40, freedBytes: 1.2 * GB, failed: 0 })).toBe(
      "Gave back 1.2 GB",
    );
    expect(kinFreeSpaceLine({ ran: true, removed: 0, freedBytes: 0, failed: 0 })).toBe(
      "Nothing old to clear",
    );
    expect(kinFreeSpaceLine({ ran: false, removed: 0, freedBytes: 0, failed: 0 })).toBe(
      "Nothing old to clear",
    );
  });
});
