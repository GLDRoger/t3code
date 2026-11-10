import type { KinFeedRow } from "@t3tools/client-runtime/kin/kinChatFeed";
import { describe, expect, it } from "vite-plus/test";

import { kinFeedDisplay } from "./kinFeedDisplay";

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
    continues: false,
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

const display = (rows: ReadonlyArray<KinFeedRow>, options: { readonly direct?: boolean } = {}) => {
  const shown = kinFeedDisplay({
    rows,
    direct: options.direct ?? true,
    formatTime: (iso) => iso.slice(11, 16),
  });
  return rows.map((row) => shown.get(row.key));
};

describe("kinFeedDisplay", () => {
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

  it("keeps only the last of a run of identical notices", () => {
    const notice = (key: string, text: string): KinFeedRow =>
      ({ type: "system", key, text, retry: null, message: {} }) as never;
    const shown = display([
      notice("n1", "Tech lead couldn't start. Trying again in a moment."),
      notice("n2", "Tech lead couldn't start. Trying again in a moment."),
      notice("n3", "Tech lead stopped partway."),
    ]);
    expect(shown.map((row) => row?.hidden)).toEqual([true, undefined, undefined]);
  });
});
