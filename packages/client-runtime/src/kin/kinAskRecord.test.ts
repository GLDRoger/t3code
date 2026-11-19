import { KinChatId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinAskAgents, kinAskRecordDraft } from "./kinAskRecord.ts";

describe("kinAskRecordDraft", () => {
  it.each([
    [
      "a task",
      { key: "T-12", title: "Fix the payments test" },
      "About T-12 (Fix the payments test): ",
    ],
    // The canvas drafted nothing for a project, which had no card to name.
    ["a project", { key: "P-3", title: "Website relaunch" }, "About P-3 (Website relaunch): "],
    ["a record with no name", { key: "P-4", title: "  " }, "About P-4: "],
  ])("names %s by key and name", (_name, record, expected) => {
    expect(kinAskRecordDraft(record)).toBe(expected);
  });
});

describe("kinAskAgents", () => {
  const lead = (agentId: string, retired?: true) => ({
    agentId,
    name: agentId,
    ownerChatId: KinChatId.make(`own-${agentId}`),
    ...(retired ? { retired: { at: "2026-01-01T00:00:00.000Z" } } : {}),
  });
  const contact = (agentId: string) => ({
    agentId,
    name: agentId,
    chatId: KinChatId.make(`mine-${agentId}`),
  });

  it("reaches live own agents and teammates' agents in the viewer's own chats", () => {
    const result = {
      leads: [lead("ops"), lead("old", true)],
      contacts: [contact("ops"), contact("sales")],
    };
    expect(kinAskAgents(result).map((agent) => agent.chatId)).toEqual(["own-ops", "mine-sales"]);
  });
});
