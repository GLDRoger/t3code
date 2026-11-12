import { makeKinFixtureMessages } from "@t3tools/client-runtime/kin/kinChatFixtures";
import type { KinMessage, KinMessageId, KinReaction, KinWidget } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinWithoutChoiceEchoes } from "./kinChoiceEcho";

const [human, agent] = makeKinFixtureMessages(2).toSorted(
  (a, b) => Number(a.author._tag === "agent") - Number(b.author._tag === "agent"),
);
const choiceWidget = {
  orgId: "org",
  chatId: "chat",
  widgetId: "w1",
  messageId: "card",
  widgetClass: "native",
  type: "choice",
  revision: 1,
  state: {
    question: "Red or   Blue?",
    detail: null,
    options: [
      { optionId: "red", label: "Red" },
      { optionId: "blue", label: "Blue" },
    ],
    answer: null,
  },
  source: null,
  feed: null,
  awaiting: [],
  pinnedAt: null,
  closedAt: null,
  updatedAt: "2026-11-08T09:00:00.000Z",
} as unknown as KinWidget;
const widgets = new Map([["w1", choiceWidget]]);

const said = (base: KinMessage, id: string, body: string): KinMessage => ({
  ...base,
  messageId: id as KinMessageId,
  body,
  widgetId: null,
});
const card = { ...said(agent!, "card", ""), widgetId: choiceWidget.widgetId };

describe("kinWithoutChoiceEchoes", () => {
  it("drops the lead's bubble that repeats its choice card's question, before or after it", () => {
    const echo = said(agent!, "echo", "Red or Blue?");
    const ids = (messages: ReadonlyArray<KinMessage>) =>
      kinWithoutChoiceEchoes(messages, widgets, []).map((message) => message.messageId);
    expect(ids([card, echo])).toEqual(["card"]);
    expect(ids([echo, card])).toEqual(["card"]);
  });

  it("keeps other text, the same words from someone else, and words away from the card", () => {
    const other = said(agent!, "other", "Pick one.");
    const fromHuman = said(human!, "human", "Red or Blue?");
    const far = said(agent!, "far", "Red or Blue?");
    const ids = kinWithoutChoiceEchoes([far, other, card, fromHuman], widgets, []).map(
      (message) => message.messageId,
    );
    expect(ids).toEqual(["far", "other", "card", "human"]);
    // A chart card is never a choice: neither it nor the bubble beside it folds.
    const chartWidget = { ...choiceWidget, widgetId: "w2", type: "chart" } as KinWidget;
    const chart = { ...said(agent!, "chart", ""), widgetId: chartWidget.widgetId };
    const caption = said(agent!, "caption", "Red or Blue?");
    expect(
      kinWithoutChoiceEchoes([chart, caption], new Map([["w2", chartWidget]]), []).map(
        (message) => message.messageId,
      ),
    ).toEqual(["chart", "caption"]);
  });

  it("keeps an echo something hangs off: a reaction, a reply to it, or its own reply", () => {
    const echo = said(agent!, "echo", "Red or Blue?");
    const ids = (messages: ReadonlyArray<KinMessage>, reactions: ReadonlyArray<KinReaction>) =>
      kinWithoutChoiceEchoes(messages, widgets, reactions).map((message) => message.messageId);
    const reaction = { messageId: echo.messageId, removedAt: null } as KinReaction;
    expect(ids([card, echo], [reaction])).toEqual(["card", "echo"]);
    expect(ids([card, echo], [{ ...reaction, removedAt: "2026-11-08T09:01:00.000Z" }])).toEqual([
      "card",
    ]);
    const reply = { ...said(human!, "reply", "Blue"), replyTo: echo.messageId };
    expect(ids([card, echo, reply], [])).toEqual(["card", "echo", "reply"]);
    const replying = { ...echo, replyTo: "earlier" as KinMessageId };
    expect(ids([card, replying], [])).toEqual(["card", "echo"]);
  });
});
