import { KinChatId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinAskAgents, kinAskRecordDraft } from "./kinAskRecord.ts";

describe("kinAskRecordDraft", () => {
  it.each([
    ["a project", { key: "P-3", title: "Website relaunch" }, "About P-3 (Website relaunch): "],
    ["a record with no name", { key: "P-4", title: "  " }, "About P-4: "],
    [
      "an issued invoice",
      { key: "INV-1", title: "Retainer", number: "INV/26-27/004" },
      "About INV/26-27/004 (INV-1) (Retainer): ",
    ],
    ["a draft invoice", { key: "INV-2", title: "Retainer" }, "About INV-2 (Retainer): "],
    ["an issued quote", { key: "Q-3", title: "", number: "2026-17" }, "About 2026-17 (Q-3): "],
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
