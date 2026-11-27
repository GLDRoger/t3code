// @effect-diagnostics globalDate:off - Days are read on the device clock, so fixtures use local dates.
import type { KinWaitingItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinWaitingAskInput, kinWaitingAskView } from "./kinWaitingAsk.ts";

const item = (ask: KinWaitingItem["ask"]) =>
  ({
    waitingId: "w-1",
    orgId: "org",
    personId: "rhea",
    chatId: "finance-chat",
    messageId: "m-1",
    widgetId: "widget-1",
    reason: "decision",
    createdAt: "2026-11-16T06:00:00.000Z",
    resolvedAt: null,
    resolution: null,
    question: "Shall I draft VIOM's payment reminder?",
    ...(ask === undefined ? {} : { ask }),
  }) as KinWaitingItem;

const options = [
  { optionId: "option-1", label: "Draft it" },
  { optionId: "option-2", label: "Leave it" },
];

describe("an open question in Waiting on you", () => {
  it("says what the agent does on which day, and marks its default", () => {
    const now = new Date(2026, 10, 16, 11, 30).getTime();
    const view = kinWaitingAskView(
      item({
        agent: "Finance",
        default: "Draft it",
        by: new Date(2026, 10, 18, 19, 30).toISOString(),
        revision: 1,
        options,
      }),
      now,
    );
    expect(view?.line).toBe("Finance goes with “Draft it” on Wednesday unless you say otherwise.");
    expect(view?.options.map((option) => option.isDefault)).toEqual([true, false]);
    expect(view?.target).toEqual({ widgetId: "widget-1", revision: 1 });
  });

  it("says plainly when nothing happens without them, and is absent for other items", () => {
    const now = new Date(2026, 10, 16, 11, 30).getTime();
    const view = kinWaitingAskView(
      item({
        agent: "Finance",
        default: null,
        by: new Date(2026, 10, 17, 19, 30).toISOString(),
        revision: 2,
        options,
      }),
      now,
    );
    expect(view?.line).toBe("Finance won't act on this without you.");
    expect(view?.options.some((option) => option.isDefault)).toBe(false);
    expect(kinWaitingAskView(item(undefined), now)).toBeNull();
  });

  it("posts an answer as the card's own tap, and Dismiss as the card's Dismiss", () => {
    const target = { widgetId: "widget-1", revision: 2 } as const;
    expect(kinWaitingAskInput(target as never, "option-1", "tap-1")).toMatchObject({
      widgetId: "widget-1",
      revision: 2,
      actionId: "choose",
      value: "option-1",
      clientActionId: "tap-1",
    });
    expect(kinWaitingAskInput(target as never, "dismiss", "tap-2")).toEqual({
      widgetId: "widget-1",
      revision: 2,
      actionId: "dismiss",
      clientActionId: "tap-2",
    });
  });
});
