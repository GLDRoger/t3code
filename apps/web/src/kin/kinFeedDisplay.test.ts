import type { KinFeedRow } from "@t3tools/client-runtime/kin/kinChatFeed";
import type { EnvironmentId, KinWidget } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinFeedDisplay, kinIsBookkeeping, kinQuietWording } from "./kinFeedDisplay";

const environmentId = "env" as EnvironmentId;

function message(
  key: string,
  minute: number,
  fields: {
    readonly own?: boolean;
    readonly author?: "agent" | "system";
    readonly showAuthor?: boolean;
    readonly kind?: string;
    readonly widgetId?: string;
    readonly body?: string;
  } = {},
): KinFeedRow {
  const own = fields.own === true;
  return {
    type: "message",
    key,
    own,
    authorLabel: fields.author === "system" ? "Kin" : "Tech lead",
    authorKind: "agent",
    showAuthor: fields.showAuthor ?? !own,
    message: {
      messageId: key,
      author: { _tag: own ? "human" : (fields.author ?? "agent") },
      kind: fields.kind ?? "text",
      status: "posted",
      body: fields.body ?? "text",
      widgetId: fields.widgetId ?? null,
      createdAt: `2026-11-10T09:${String(minute).padStart(2, "0")}:00.000Z`,
    },
  } as never;
}

const widget = (widgetId: string, type: string, state: object): KinWidget =>
  ({ widgetId, type, widgetClass: "native", state, revision: 1, closedAt: null }) as never;

const display = (
  rows: ReadonlyArray<KinFeedRow>,
  options: { readonly direct?: boolean; readonly widgets?: ReadonlyArray<KinWidget> } = {},
) => {
  const shown = kinFeedDisplay({
    rows,
    widgets: new Map((options.widgets ?? []).map((held) => [held.widgetId, held])),
    environmentId,
    direct: options.direct ?? true,
    formatTime: (iso) => iso.slice(11, 16),
  });
  return rows.map((row) => shown.get(row.key));
};

describe("kinFeedDisplay", () => {
  it("never draws a card tap, whether or not the feed could read its words", () => {
    const shown = display([
      message("read", 1, { own: true, kind: "widget_action", body: 'Chose "Yes"' }),
      message("unread", 2, {
        own: true,
        kind: "widget_action",
        widgetId: "choice:1",
        body: '{"widgetId":"choice:1","actionId":"choose"}',
      }),
    ]);
    expect(shown).toEqual([
      { hidden: true, quiet: null, head: null },
      { hidden: true, quiet: null, head: null },
    ]);
  });

  it("draws the host's old reminder and memory notes as one quiet line each", () => {
    const shown = display(
      [
        message("set", 1, { author: "system", widgetId: "deferral:1", body: "" }),
        message("memory", 1, { author: "system", widgetId: "memory:1", body: "" }),
        message("asked", 2, { author: "system", widgetId: "deferral:2", body: "" }),
      ],
      {
        widgets: [
          widget("deferral:1", "deferral", {
            itemId: "def-1",
            title: "Stretch",
            dueAt: "2026-11-10T10:00:00.000Z",
            onDue: "remind",
            text: "",
          }),
          widget("memory:1", "memory_changes", {
            agentId: "lead",
            wakeupId: "w",
            branch: "b",
            base: "a",
            commit: "c",
            items: [
              { itemId: "m1", path: "claims/m1.md", title: "Repo", change: "created", undo: null },
              { itemId: "m2", path: "claims/m2.md", title: "Zone", change: "updated", undo: null },
            ],
            more: 0,
          }),
          widget("deferral:2", "deferral", {
            itemId: "def-2",
            title: "Rate limiting",
            dueAt: "2026-11-10T10:00:00.000Z",
            onDue: "start",
            text: "",
            phase: "asked",
          }),
        ],
      },
    );
    expect(shown[0]?.quiet).toMatch(/^Scheduled for .*\. I'll remind you then\.$/);
    expect(shown[1]?.quiet).toBe("Remembered: Repo, and 1 more");
    // A card that still asks for a decision stays a card.
    expect(shown[2]).toMatchObject({ hidden: false, quiet: null });
  });

  it("heads a group with its time once a minute, and names nobody in a direct chat", () => {
    const rows = [
      message("a", 1, { own: true }),
      message("b", 1),
      message("c", 1, { showAuthor: false }),
      message("d", 3, { own: true }),
      message("e", 3, { own: true }),
    ];
    expect(display(rows).map((shown) => shown?.head)).toEqual(["09:01", null, null, "09:03", null]);
    expect(display(rows, { direct: false }).map((shown) => shown?.head)).toEqual([
      "09:01",
      "Tech lead",
      null,
      "09:03",
      null,
    ]);
  });

  it("leaves the time to the divider right above a message", () => {
    const rows: ReadonlyArray<KinFeedRow> = [
      { type: "day", key: "day:1", label: "Today 9:01 AM" },
      message("a", 1),
      message("b", 2, { own: true }),
    ];
    expect(display(rows).map((shown) => shown?.head)).toEqual([undefined, null, "09:02"]);
  });

  it("keeps only the last of a run of identical notices, and tells notices from bookkeeping", () => {
    const notice = (key: string, text: string): KinFeedRow =>
      ({ type: "system", key, text, retry: null, message: {} }) as never;
    const shown = display([
      notice("n1", "Tech lead couldn't start. Trying again in a moment."),
      notice("n2", "Tech lead couldn't start. Trying again in a moment."),
      notice("n3", "Remembered: Repo"),
    ]);
    expect(shown.map((row) => row?.hidden)).toEqual([true, undefined, undefined]);
    expect(kinIsBookkeeping("Remembered: Repo")).toBe(true);
    expect(kinIsBookkeeping("Deferred to Mon 9 Nov, 16:09. I'll remind you then.")).toBe(true);
    expect(kinIsBookkeeping("Tech lead couldn't start. Trying again in a moment.")).toBe(false);
    expect(kinIsBookkeeping("Reminder: Stretch. This was due at 16:10.")).toBe(false);
  });

  it("rewords the host's old reminder notice", () => {
    expect(kinQuietWording("Deferred to Mon 9 Nov, 16:09. I'll remind you then.")).toBe(
      "Scheduled for Mon 9 Nov, 16:09. I'll remind you then.",
    );
  });
});
