import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { postKey, signed } from "./agentMark.ts";
import {
  decideTriggers,
  TRIAGE_REPLIES,
  type DecideContext,
  type ThreadComment,
  type ThreadSnapshot,
} from "./githubTriggers.ts";

const repo = "tidewater/dispatch";
const issue: ThreadSnapshot = {
  repo,
  number: 14,
  item: "issue",
  url: `https://github.com/${repo}/issues/14`,
  title: "Digest arrives early",
  body: "The digest arrives at 03:00.",
  author: "zoya",
  authorBot: false,
  association: "COLLABORATOR",
  open: true,
  draft: false,
  createdAt: 20,
  labels: [],
  comments: [],
  reviewRequested: false,
};
const stranger = { author: "stranger-one", association: "NONE" };
const context: DecideContext = {
  ownerLogin: "rhea",
  agents: [],
  defaultAgentId: "tech",
  mentions: false,
  since: 10,
  draftSeen: false,
  writes: (login) => ["zoya", "arjun", "rhea"].includes(login),
  triageFrom: 20,
  appOn: true,
};
const prior = { kinSaid: 30, repliesLeft: TRIAGE_REPLIES };
const comment = (fields: Partial<ThreadComment> = {}): ThreadComment => ({
  id: 2,
  kind: "issue",
  body: "This is on Android.",
  author: "arjun",
  bot: false,
  association: "COLLABORATOR",
  createdAt: 31,
  ...fields,
});
const initial = ["triage", `triage:${repo}#14`, true];
const outside = ["triage", `triage:${repo}#14`, false];
const reply = ["triage_reply", `triage_reply:${repo}#14:c2`, true];
const outsideReply = ["triage_reply", `triage_reply:${repo}#14:c2`, false];
const label = ["label", `label:${repo}#14`, true];
const call = ["call", `call:${repo}#14:body`, true];
const handled = [`triage:${repo}#14`];
const beforeTransfer = ["triage:tidewater/intake#14"];
const marked = signed("A digest report", "Tech lead");

type Row = readonly [
  name: string,
  issue: Partial<ThreadSnapshot>,
  context: Partial<DecideContext>,
  expected: ReadonlyArray<ReadonlyArray<string | boolean>>,
  handled?: ReadonlyArray<string>,
];
const rows: ReadonlyArray<Row> = [
  ["new issue by Zoya", {}, {}, [initial]],
  ["new issue by a stranger", stranger, {}, [outside]],
  ["new issue by a stranger without the App", stranger, { appOn: false }, []],
  ["new issue by a stranger with unknown App coverage", stranger, { appOn: undefined }, []],
  ["new issue by Zoya without the App", {}, { appOn: false }, [initial]],
  ["new issue by a typed bot", { author: "automation", authorBot: true }, {}, []],
  ["new issue by a login ending in [bot]", { author: "renovate[bot]" }, {}, []],
  ["new issue by the Kin App", { author: "tidewater-kin" }, { botLogin: "tidewater-kin" }, []],
  ["new issue with a Kin marker", { body: marked }, {}, []],
  ["new issue recorded in agent posts", {}, { agentPosts: new Set([postKey(issue.body)]) }, []],
  ["kin label applied by a writer", { labels: ["kin"] }, { labeledBy: "arjun" }, [label]],
  [
    "kin label applied by a stranger",
    { labels: ["kin"] },
    { labeledBy: "stranger-one" },
    [initial],
  ],
  ["body calls Kin as a writer", { body: "/kin" }, {}, [call]],
  ["body calls Kin as a stranger", { ...stranger, body: "/kin" }, {}, [outside]],
  ["edit adds a writer's call", { body: "/kin" }, {}, [call], handled],
  ["edit without a call", { body: "The digest is early every Monday." }, {}, [], handled],
  ["reopened issue", {}, {}, [], handled],
  ["closed before the first look", { open: false }, {}, []],
  [
    "transfer with a new repo and number",
    { number: 15 },
    {},
    [["triage", `triage:${repo}#15`, true]],
    beforeTransfer,
  ],
  ["transfer created before triage began", { number: 15, createdAt: 19 }, {}, [], beforeTransfer],
  ["old issue with a new comment", { createdAt: 19, comments: [comment()] }, {}, []],
  ["issue older than the watch", {}, { since: 21 }, []],
  ["pull request starts a review", { item: "pull" }, {}, [["review", `review:${repo}#14`, true]]],
  [
    "reply from the writer who opened the issue",
    { comments: [comment({ author: "zoya" })] },
    prior,
    [reply],
    handled,
  ],
  [
    "inside reply without the App",
    { comments: [comment()] },
    { ...prior, appOn: false },
    [reply],
    handled,
  ],
  [
    "reply from a stranger on a writer's issue",
    { comments: [comment(stranger)] },
    prior,
    [outsideReply],
    handled,
  ],
  [
    "reply from a writer on a stranger's issue",
    { ...stranger, comments: [comment()] },
    prior,
    [outsideReply],
    handled,
  ],
  [
    "reply to a writer and a stranger uses the newest key and the outside seat",
    { comments: [comment(), comment({ ...stranger, id: 1 })] },
    prior,
    [outsideReply],
    handled,
  ],
  [
    "outside reply without the App",
    { comments: [comment(stranger)] },
    { ...prior, appOn: false },
    [],
    handled,
  ],
  [
    "outside reply with unknown App coverage",
    { ...stranger, comments: [comment()] },
    { ...prior, appOn: undefined },
    [],
    handled,
  ],
  ["comment from a typed bot", { comments: [comment({ bot: true })] }, prior, [], handled],
  [
    "comment from a login ending in [bot]",
    { comments: [comment({ author: "renovate[bot]" })] },
    prior,
    [],
    handled,
  ],
  ["comment with Kin's marker", { comments: [comment({ body: marked })] }, prior, [], handled],
  [
    "comment at the same time as Kin's latest post",
    { comments: [comment({ createdAt: 30 })] },
    prior,
    [],
    handled,
  ],
  [
    "writer's comment calls Kin",
    { comments: [comment({ body: "/kin" })] },
    prior,
    [["call", `call:${repo}#14:c2`, true]],
    handled,
  ],
  ["fourth reply", { comments: [comment()] }, { ...prior, repliesLeft: 0 }, [], handled],
  ["triage switched off for an issue", {}, { triageFrom: undefined }, []],
  [
    "triage switched off for a reply",
    { comments: [comment()] },
    { ...prior, triageFrom: undefined },
    [],
    handled,
  ],
];

describe("issue triage triggers", () => {
  it.effect.each(rows)("%s", ([_name, snapshot, overrides, expected, previous = []]) =>
    Effect.sync(() => {
      const triggers = decideTriggers({ ...issue, ...snapshot }, { ...context, ...overrides });
      expect(
        triggers
          .filter(({ key }) => !previous.includes(key))
          .map(({ kind, key, inside }) => [kind, key, inside]),
      ).toEqual(expected);
    }),
  );
});
