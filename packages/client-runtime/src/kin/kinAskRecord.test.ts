import { KinAgentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinAskAgents, kinAskRecordDraft } from "./kinAskRecord.ts";

describe("kinAskRecordDraft", () => {
  it.each([
    ["a project", { key: "P-3", title: "Website relaunch" }, "About P-3 (Website relaunch): "],
    ["a record with no name", { key: "P-4", title: "  " }, "About P-4: "],
  ])("names %s by key and name", (_name, record, expected) => {
    expect(kinAskRecordDraft(record)).toBe(expected);
  });
});

describe("kinAskAgents", () => {
  const orgId = KinOrgId.make("ambermill");
  const lead = (agentId: string, retired?: true) => ({
    agentId: KinAgentId.make(agentId),
    name: agentId,
    ownerChatId: KinChatId.make(`own-${agentId}`),
    ...(retired ? { retired: { at: "2026-01-01T00:00:00.000Z" } } : {}),
  });
  const contact = (agentId: string) => ({
    orgId,
    agentId: KinAgentId.make(agentId),
    name: agentId,
    intro: "",
    chatId: KinChatId.make(`mine-${agentId}`),
  });
  const messageable = (agentId: string) => ({
    orgId,
    agentId: KinAgentId.make(agentId),
    name: agentId,
    intro: "",
    ownerName: "Rhea",
  });

  it("offers a teammate every agent the host lets them message, chat or not yet", () => {
    // Arjun has a chat with Sales, since restricted, and none with Chief of staff or Finance; the
    // host's list leaves out Sales and the retired Old.
    const result = {
      leads: [],
      contacts: [contact("sales"), contact("old")],
      messageable: [messageable("chief"), messageable("finance")],
    };
    expect(kinAskAgents(result)).toEqual([
      { agentId: "chief", name: "chief", chatId: null },
      { agentId: "finance", name: "finance", chatId: null },
    ]);
  });

  it("opens the chat the viewer already has with a listed agent", () => {
    const result = {
      leads: [lead("ops")],
      contacts: [contact("finance")],
      messageable: [messageable("ops"), messageable("finance"), messageable("chief")],
    };
    expect(kinAskAgents(result).map((agent) => agent.chatId)).toEqual([
      "own-ops",
      "mine-finance",
      null,
    ]);
  });

  it("on an older host, reaches live own agents and teammates' agents in the viewer's own chats", () => {
    const result = {
      leads: [lead("ops"), lead("old", true)],
      contacts: [contact("ops"), contact("sales")],
    };
    expect(kinAskAgents(result).map((agent) => agent.chatId)).toEqual(["own-ops", "mine-sales"]);
  });
});
