import {
  KinAgentId,
  KinOrgId,
  KinPersonId,
  KinRecordId,
  type KinRecord,
  type KinWorkPrincipal,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { KIN_WORK_DEFAULT_FILTER, type KinWorkNames } from "./kinWork.ts";
import { kinWorkGroupWithin, kinWorkGroups, kinWorkGroupsShown } from "./kinWorkGroups.ts";

// Invented people: Rhea owns the company, Meera is a co-owner, Dev leads Lumen, Zoya is on it.
const person = (id: string) => ({ _tag: "person", personId: KinPersonId.make(id) }) as const;
const rhea = person("rhea");
const meera = person("meera");
const dev = person("dev");
const zoya = person("zoya");
const finance = { _tag: "agent", agentId: KinAgentId.make("finance") } as const;
const lumen = { recordId: KinRecordId.make("p1"), key: "P-1", title: "Invented Lumen app" };
const orbit = { recordId: KinRecordId.make("p2"), key: "P-2", title: "Invented Orbit retainer" };
const namesFor = (me: KinWorkPrincipal & { _tag: "person" }): KinWorkNames => ({
  people: new Map([
    [rhea.personId, "Rhea"],
    [meera.personId, "Meera"],
    [dev.personId, "Dev"],
    [zoya.personId, "Zoya"],
  ]),
  agents: new Map([[finance.agentId, "Finance"]]),
  me: me.personId,
  owner: rhea.personId,
  zone: "UTC",
});
let n = 0;
const task = (patch: Partial<KinRecord>): KinRecord => {
  n += 1;
  return {
    recordId: KinRecordId.make(`r${n}`),
    orgId: KinOrgId.make("invented-org"),
    key: `W-${n}`,
    title: `Invented task ${n}`,
    state: "open",
    waitingOn: null,
    owner: rhea,
    category: null,
    side: "ours",
    dueAt: null,
    dueAllDay: false,
    late: false,
    confirmed: true,
    sensitive: false,
    working: false,
    pullRequest: null,
    rev: 1,
    createdAt: "2026-11-10T08:00:00.000Z",
    updatedAt: "2026-11-10T08:00:00.000Z",
    closedAt: null,
    ...patch,
  };
};

// One company's open tasks, as each of them could hold them in their list.
const zoyas = task({ owner: zoya, givenBy: rhea, project: lumen });
const zoyaWaits = task({ owner: zoya, state: "waiting", waitingOn: dev, project: lumen });
const devs = task({ owner: dev, givenBy: rhea, project: lumen });
const devGaveZoya = task({ owner: zoya, givenBy: dev, project: lumen });
const financeHas = task({ owner: finance, givenBy: zoya, project: lumen });
const rheas = task({ owner: rhea, project: orbit });
const meerasLoose = task({ owner: meera, givenBy: rhea });
const all = [zoyas, zoyaWaits, devs, devGaveZoya, financeHas, rheas, meerasLoose];

/** Each line as text: "# On me 2", "@ Dev 1", or a task's key. */
const shape = (me: KinWorkPrincipal & { _tag: "person" }) =>
  kinWorkGroups(all, namesFor(me)).map((item) =>
    item.type === "section"
      ? `# ${item.title} ${item.count}`
      : item.type === "who"
        ? `@ ${item.name} ${item.count}`
        : item.key,
  );

describe("kinWorkGroups", () => {
  it("a member: what she holds, whom she waits on, the agent she gave work, then her projects", () => {
    expect(shape(zoya)).toEqual([
      "# On me 2",
      zoyas.key,
      devGaveZoya.key,
      "# On others 1",
      "@ Dev 1",
      zoyaWaits.key,
      "# On agents 1",
      "@ Finance 1",
      financeHas.key,
      `# Invented Lumen app 1`,
      devs.key,
      "# Invented Orbit retainer 1",
      rheas.key,
      "# Not in a project 1",
      meerasLoose.key,
    ]);
  });

  it("a lead: what he gave and holds; the owner: everything she gave, by person", () => {
    expect(shape(dev)).toEqual([
      "# On me 1",
      devs.key,
      "# On others 1",
      "@ Zoya 1",
      devGaveZoya.key,
      "# Invented Lumen app 3",
      zoyas.key,
      zoyaWaits.key,
      financeHas.key,
      "# Invented Orbit retainer 1",
      rheas.key,
      "# Not in a project 1",
      meerasLoose.key,
    ]);
    expect(shape(rhea)).toEqual([
      "# On me 1",
      rheas.key,
      "# On others 3",
      "@ Dev 1",
      devs.key,
      "@ Meera 1",
      meerasLoose.key,
      "@ Zoya 1",
      zoyas.key,
      "# Invented Lumen app 3",
      zoyaWaits.key,
      devGaveZoya.key,
      financeHas.key,
    ]);
  });

  it("a co-owner with nothing of her own sees the company by project", () => {
    expect(shape(meera).slice(0, 2)).toEqual(["# On me 1", meerasLoose.key]);
    expect(shape(meera)).not.toContain("# On others 0");
  });

  it("a row under its project's heading doesn't name the project again", () => {
    const items = kinWorkGroups(all, namesFor(zoya)).filter((item) => item.type === "task");
    const under = items.find((item) => item.key === devs.key)!;
    const own = items.find((item) => item.key === zoyas.key)!;
    expect(kinWorkGroupWithin(under, KIN_WORK_DEFAULT_FILTER).project?.key).toBe("P-1");
    expect(kinWorkGroupWithin(own, KIN_WORK_DEFAULT_FILTER).project).toBeNull();
  });

  it("groups only the plain list", () => {
    expect(kinWorkGroupsShown(KIN_WORK_DEFAULT_FILTER, zoya.personId)).toBe(true);
    expect(kinWorkGroupsShown({ ...KIN_WORK_DEFAULT_FILTER, text: "copy" }, zoya.personId)).toBe(
      false,
    );
    expect(kinWorkGroupsShown({ ...KIN_WORK_DEFAULT_FILTER, owner: dev }, zoya.personId)).toBe(
      false,
    );
    expect(kinWorkGroupsShown(KIN_WORK_DEFAULT_FILTER, null)).toBe(false);
  });
});
