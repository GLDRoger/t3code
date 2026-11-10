import type { KinMessage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinIntroVisible } from "./kinIntro.ts";

const from = (author: KinMessage["author"]) => ({ author }) as KinMessage;
const lead = from({ _tag: "agent", agentId: "lead" } as never);
const mine = from({ _tag: "human", personId: "owner" } as never);
const someoneElse = from({ _tag: "human", personId: "guest" } as never);

const base = {
  ownsLead: true,
  agentName: "Tech lead",
  viewerPersonId: "owner",
  messages: [lead, someoneElse],
  pendingCount: 0,
  historyIncomplete: false,
};

describe("kinIntroVisible", () => {
  it.each([
    ["shows until the owner has said anything", {}, true],
    ["hides once the owner's message is in the feed", { messages: [lead, mine] }, false],
    ["hides while the owner's first send is still in the outbox", { pendingCount: 1 }, false],
    ["hides while older messages could hold the owner's", { historyIncomplete: true }, false],
    ["shows only to the lead's owner", { ownsLead: false }, false],
    ["needs the lead's name to introduce it", { agentName: null }, false],
    ["needs to know who the viewer is", { viewerPersonId: null }, false],
  ] as const)("%s", (_name, overrides, visible) => {
    expect(kinIntroVisible({ ...base, ...overrides })).toBe(visible);
  });
});
