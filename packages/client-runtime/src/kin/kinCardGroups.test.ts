import type { KinMessage, KinWidget } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinGroupCardRows } from "./kinCardGroups.ts";
import { buildKinFeedRows, type KinFeedRow, type KinFeedViewer } from "./kinChatFeed.ts";

const viewer: KinFeedViewer = {
  personId: "rhea" as never,
  agentNames: new Map([
    ["chief", "Chief of staff"],
    ["finance", "Finance"],
  ]),
};

const AT = Date.parse("2026-11-20T09:00:00.000Z");
let seq = 0;
const message = (
  widgetId: string | null,
  overrides: { readonly agent?: string; readonly body?: string; readonly human?: boolean } = {},
): KinMessage => {
  seq += 1;
  return {
    orgId: "org",
    chatId: "chat",
    messageId: `m${seq}`,
    seq,
    author: overrides.human
      ? { _tag: "human", personId: "rhea", memberId: "member-rhea" }
      : {
          _tag: "agent",
          agentId: overrides.agent ?? "chief",
          ownerPersonId: "rhea",
          threadId: "thread-chief",
          memberId: `member-${overrides.agent ?? "chief"}`,
        },
    authorRole: overrides.human ? "owner" : "member",
    kind: "text",
    intent: "answer",
    body: overrides.body ?? "",
    mentions: [],
    replyTo: null,
    widgetId,
    floorRunId: null,
    status: "posted",
    createdAt: new Date(AT + seq * 1000).toISOString(),
    editedAt: null,
  } as unknown as KinMessage;
};

const widget = (widgetId: string, type: string, state: unknown): KinWidget =>
  ({
    orgId: "org",
    chatId: "chat",
    widgetId,
    messageId: "m",
    widgetClass: "native",
    type,
    revision: 1,
    state,
    source: null,
    feed: null,
    awaiting: [],
    pinnedAt: null,
    closedAt: null,
    updatedAt: "2026-11-20T09:00:00.000Z",
  }) as unknown as KinWidget;

const task = (id: string, status = "working") =>
  widget(`task:${id}`, "task", {
    taskId: id,
    environmentId: "env-home",
    threadId: `thread-${id}`,
    remoteEnvironmentId: null,
    title: `Draft the ${id} invoice`,
    model: null,
    status,
    pullRequests: [],
    lastError: status === "failed" ? "The ledger was locked." : null,
    updatedAt: "2026-11-20T09:00:00.000Z",
  });

const question = (id: string, answered: boolean) =>
  widget(`choice:${id}`, "choice", {
    question: "Start both invoice drafts now?",
    detail: null,
    options: [
      { optionId: "both", label: "Start both", kind: "yes" },
      { optionId: "later", label: "Later", kind: "no" },
    ],
    answer: answered
      ? {
          optionId: "both",
          personId: "rhea",
          via: "tap",
          emoji: null,
          answeredAt: "2026-11-20T09:01:00.000Z",
        }
      : null,
  });

type Step =
  | { readonly card: KinWidget; readonly agent?: string; readonly body?: string }
  | { readonly text: string; readonly human?: boolean };

/** Builds the feed, groups it, and names each row: `Q+T+T` for a group, `msg`, `card`. */
function shape(steps: ReadonlyArray<Step>, reacted: ReadonlyArray<number> = []) {
  const widgets = new Map<string, KinWidget>();
  const messages = steps.map((step) => {
    if ("text" in step) return message(null, { body: step.text, human: step.human === true });
    widgets.set(step.card.widgetId, step.card);
    return message(step.card.widgetId, {
      ...(step.agent === undefined ? {} : { agent: step.agent }),
      ...(step.body === undefined ? {} : { body: step.body }),
    });
  });
  const rows = buildKinFeedRows(messages, viewer, new Set(), new Date(AT)).filter(
    (row) => row.type !== "day",
  );
  const reactedIds = new Set(reacted.map((index) => messages[index]!.messageId));
  const grouped = kinGroupCardRows(rows, widgets, reactedIds);
  return {
    rows,
    widgets,
    grouped,
    names: grouped.map((row) =>
      row.type === "cards"
        ? [row.question === null ? [] : ["Q"], row.tasks.map(() => "T")].flat().join("+")
        : row.type === "message" && row.message.widgetId !== null
          ? "card"
          : "msg",
    ),
  };
}

describe("kinGroupCardRows", () => {
  it.each<[string, ReadonlyArray<Step>, ReadonlyArray<string>]>([
    [
      "an answered question and the two tasks it started",
      [{ card: question("a", true) }, { card: task("a") }, { card: task("b") }],
      ["Q+T+T"],
    ],
    [
      "a question asked on the agent's own reply, whose words stay above the card",
      [
        { card: question("a", true), body: "Both drafts are ready to start." },
        { card: task("a") },
        { card: task("b") },
      ],
      ["Q+T+T"],
    ],
    [
      "a task card with words of its own, which leads its own card",
      [{ card: task("a") }, { card: task("b"), body: "This one needs the ledger." }],
      ["T", "T"],
    ],
    ["tasks alone", [{ card: task("a") }, { card: task("b") }], ["T+T"]],
    ["one task", [{ card: task("a") }], ["T"]],
    [
      "a question still waiting, which stays as it is",
      [{ card: question("a", false) }, { card: task("a") }],
      ["card", "T"],
    ],
    [
      "an answered question with nothing after it",
      [{ card: question("a", true) }, { text: "Thanks", human: true }],
      ["card", "msg"],
    ],
    [
      "a message in between",
      [
        { card: question("a", true) },
        { card: task("a") },
        { text: "Starting the second one too." },
        { card: task("b") },
      ],
      ["Q+T", "msg", "T"],
    ],
    [
      "two agents",
      [{ card: question("a", true) }, { card: task("a", "done"), agent: "finance" }],
      ["card", "T"],
    ],
    [
      "a failed task among others",
      [
        { card: task("a", "failed") },
        { card: task("b", "done") },
        { card: task("c", "cancelled") },
      ],
      ["T+T+T"],
    ],
  ])("groups %s", (_name, steps, names) => {
    expect(shape(steps).names).toEqual(names);
  });

  it("keeps a card with reactions where its reactions show: only leading a group", () => {
    const steps: ReadonlyArray<Step> = [{ card: task("a") }, { card: task("b") }];
    expect(shape(steps, [0]).names).toEqual(["T+T"]);
    expect(shape(steps, [1]).names).toEqual(["T", "T"]);
  });

  it("keeps the group's identity when a task changes state, so only that row redraws", () => {
    const first = shape([{ card: question("a", true) }, { card: task("a") }, { card: task("b") }]);
    const widgets = new Map(first.widgets);
    const done = task("b", "done");
    widgets.set(done.widgetId, done);
    const again = kinGroupCardRows(first.rows as ReadonlyArray<KinFeedRow>, widgets);
    expect(again).toHaveLength(1);
    expect(again[0]).toBe(first.grouped[0]);
  });
});
