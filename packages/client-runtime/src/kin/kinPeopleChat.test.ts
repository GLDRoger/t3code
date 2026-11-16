import { kinPeopleChatTeamId, KinPersonId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinMessageablePeople, kinPeopleChatWith } from "./kinPeopleChat.ts";

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
});
