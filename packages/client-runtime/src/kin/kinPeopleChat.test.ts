import {
  KinAgentId,
  KinChatId,
  KinOrgId,
  kinPeopleChatTeamId,
  KinPersonId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinMessageablePeople, kinNewChatList, kinPeopleChatWith } from "./kinPeopleChat.ts";

const zoya = KinPersonId.make("zoya");
const arjun = KinPersonId.make("arjun");
const person = (personId: KinPersonId) => ({ principal: { _tag: "person" as const, personId } });

describe("kinPeopleChat", () => {
  it("names the other person in a chat between two, and nobody in any other chat", () => {
    const members = [person(zoya), person(arjun)] as never;
    const chat = { kind: "team_group" as const, teamId: kinPeopleChatTeamId(arjun, zoya), members };
    expect(kinPeopleChatWith(chat, new Set([zoya]))).toBe(arjun);
    expect(kinPeopleChatWith(chat, new Set([arjun]))).toBe(zoya);
    expect(kinPeopleChatWith({ ...chat, teamId: "launch" }, new Set([zoya]))).toBeNull();
  });

  it("offers everyone else on the team, by name", () => {
    const people = [
      { personId: zoya, displayName: "Zoya" },
      { personId: arjun, displayName: "Arjun" },
      { personId: KinPersonId.make("meera"), displayName: "Meera" },
    ];
    expect(kinMessageablePeople(people, zoya).map((one) => one.displayName)).toEqual([
      "Arjun",
      "Meera",
    ]);
  });

  it("lists people, then the agents the host says the viewer may message, headed when both show", () => {
    const orgId = KinOrgId.make("ambermill");
    const people = [
      { personId: zoya, displayName: "Zoya" },
      { personId: arjun, displayName: "Arjun" },
    ];
    const agent = (id: string, name: string, intro: string) => ({
      orgId,
      agentId: KinAgentId.make(id),
      name,
      intro,
      ownerName: "Rhea",
    });
    // The host lists only live agents the viewer isn't restricted from: Temp (retired) and
    // Finance (restricted) are not in it.
    const leads = {
      leads: [],
      contacts: [],
      messageable: [
        agent("chief", "Chief of staff", "  Keeps track of who has what. "),
        agent("ops", "Ops", " "),
      ],
    };
    const list = kinNewChatList(people, arjun, leads);
    expect(list.people.map((one) => one.displayName)).toEqual(["Zoya"]);
    expect(list.agents).toEqual([
      { agentId: "chief", name: "Chief of staff", intro: "Keeps track of who has what." },
      { agentId: "ops", name: "Ops", intro: null },
    ]);
    expect([list.peopleTitle, list.agentsTitle]).toEqual(["People", "Agents"]);
    expect(list.agentsNote).toBe("Rhea runs this workspace and can see chats with agents.");
    // Alone, a kind gets no heading.
    const alone = kinNewChatList(people.slice(1), arjun, leads);
    expect([alone.people, alone.peopleTitle, alone.agentsTitle]).toEqual([[], null, null]);
    // The owner's own agents tell her nothing about who else reads them.
    const own = {
      ...leads,
      leads: [
        {
          agentId: KinAgentId.make("chief"),
          name: "Chief of staff",
          ownerChatId: KinChatId.make("c1"),
        },
        { agentId: KinAgentId.make("ops"), name: "Ops", ownerChatId: KinChatId.make("c2") },
      ],
    };
    expect(kinNewChatList(people, KinPersonId.make("rhea"), own).agentsNote).toBeNull();
    // An older host without the list: the viewer's own live agents and the chats they have.
    const temp = {
      agentId: KinAgentId.make("temp"),
      name: "Temp",
      ownerChatId: KinChatId.make("c3"),
      retired: {},
    };
    const chief = { ...agent("chief", "Chief of staff", ""), chatId: KinChatId.make("c4") };
    const older = kinNewChatList(people, arjun, { leads: [temp], contacts: [chief] });
    expect(older.agents).toEqual([{ agentId: "chief", name: "Chief of staff", intro: null }]);
    expect(kinNewChatList(people, arjun, null).agents).toEqual([]);
  });
});
