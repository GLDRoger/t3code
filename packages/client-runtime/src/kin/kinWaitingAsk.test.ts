// @effect-diagnostics globalDate:off - Days are read on the device clock, so fixtures use local dates.
import { formatKinWhen, type KinWaitingItem, KinWidgetId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinChoiceDefaultLine, kinWaitingAskView } from "./kinWaitingAsk.ts";

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
});

describe("an open question's card", () => {
  const now = new Date(2026, 10, 16, 11, 30).getTime();
  const waiting = (ask: KinWaitingItem["ask"]) => [item(ask)];
  const asked = (fields: Partial<NonNullable<KinWaitingItem["ask"]>>) =>
    waiting({
      agent: "Finance",
      default: "Draft it",
      by: new Date(2026, 10, 17, 19, 30).toISOString(),
      revision: 1,
      options,
      ...fields,
    });
  const card = KinWidgetId.make("widget-1");

  it("names the default Kin takes and when, in the reader's own time", () => {
    const at = new Date(2026, 10, 17, 19, 30);
    expect(kinChoiceDefaultLine(card, asked({}), now)).toBe(
      `If nobody answers by tomorrow at ${formatKinWhen(at, "time")}: Draft it.`,
    );
    expect(
      kinChoiceDefaultLine(
        card,
        asked({ by: new Date(2026, 10, 19, 19, 30).toISOString(), default: "Go ahead!" }),
        now,
      ),
    ).toBe(`If nobody answers by Thursday at ${formatKinWhen(at, "time")}: Go ahead!`);
  });

  it("says nothing where no default is taken, or the card isn't the reader's question", () => {
    expect(kinChoiceDefaultLine(card, asked({ default: null }), now)).toBeNull();
    expect(kinChoiceDefaultLine(KinWidgetId.make("widget-2"), asked({}), now)).toBeNull();
    expect(kinChoiceDefaultLine(card, waiting(undefined), now)).toBeNull();
    expect(kinChoiceDefaultLine(card, null, now)).toBeNull();
    expect(kinChoiceDefaultLine(card, asked({}), Date.parse(asked({})[0]!.ask!.by))).toBeNull();
  });
});
