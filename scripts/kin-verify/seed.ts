// @effect-diagnostics nodeBuiltinImport:off globalDate:off - writes an invented company into a dev instance.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { acceptInvite, ownerToken, originOf, runTurn } from "./actors.ts";
import { benchImport, benchTurns } from "./benchSeed.ts";
import { lookbookTurns } from "./lookbookSeed.ts";
import {
  type Instance,
  ORG,
  OWNER_PERSON,
  type SeedState,
  serverCli,
  writeSession,
} from "./instance.ts";
import { RpcConnection, VerifyError } from "./rpc.ts";

export const SEEDS = ["lifecycle", "empty", "bench", "lookbook"] as const;
export type SeedName = (typeof SEEDS)[number];

/** Days from today, as the YYYY-MM-DD the import reads. Every date is relative, so runs agree. */
const day = (offset: number) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toLocaleDateString("en-CA");
};
const at = (offset: number) => `${day(offset)}T12:00:00.000Z`;

/**
 * Asia/Kolkata while it is day there; at night a whole-hour zone where it is day on the same date.
 * Quiet hours (22:00 to 07:00, which no RPC changes) hold what a run sends, and dates stay the host's.
 */
const daytimeZone = (now = Date.now()) => {
  const today = new Date(now).toLocaleDateString("en-CA");
  const clock = (timeZone: string) => {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const part = (type: string) => parts.find((one) => one.type === type)!.value;
    return { date: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
  };
  const daytime = (zone: string) => {
    const { date, hour } = clock(zone);
    return date === today && hour >= 8 && hour <= 18;
  };
  if (daytime("Asia/Kolkata")) return "Asia/Kolkata";
  const zones = Array.from({ length: 27 }, (_, at) => at - 12).map((offset) =>
    offset === 0 ? "Etc/GMT" : `Etc/GMT${offset > 0 ? "-" : "+"}${Math.abs(offset)}`,
  );
  return zones.find(daytime) ?? "Asia/Kolkata";
};

const SCRIPT_MODEL = { instanceId: "kinVerifyScript", model: "script" };
const ALL_DAY = { days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" };

/** Invented: Ambermill Studio, a small app studio. Every address is `.example`. */
const TEAM = [
  { key: "meera", name: "Meera Iyer", tags: ["design"], access: "co_owner" },
  { key: "dev", name: "Dev Malhotra", tags: ["engineering"] },
  { key: "zoya", name: "Zoya Sheikh", tags: ["design"], places: { clients: true } },
  { key: "arjun", name: "Arjun Rao", tags: ["engineering"] },
] as const;

const AGENTS = [
  {
    key: "chief",
    name: "Chief of staff",
    domain: "chief",
    charter: "Runs the studio's day with the owner: tasks, people, clients.",
  },
  {
    key: "finance",
    name: "Finance",
    domain: "finance",
    charter: "Keeps the books: quotes, invoices, payments and reminders.",
  },
] as const;

function importLines(): string {
  const lines: Array<unknown> = [
    {
      format: "kin-import",
      version: 1,
      batch: "kin-verify-lifecycle",
      source: "kin-verify seed",
      lists: [
        { list: "invoices", template: "invoices" },
        {
          list: "quotes",
          name: "Quotes",
          noun: "Quote",
          amount: true,
          currency: "INR",
          sensitive: true,
          states: ["open", "waiting", "done", "dropped"],
        },
      ],
    },
    {
      client: {
        source: "c-lumen",
        name: "Lumen Grove Clinics",
        placeOfSupply: "Tamil Nadu",
        createdAt: day(-19),
      },
    },
    {
      client: {
        source: "c-orbit",
        name: "Orbit Dental Care",
        placeOfSupply: "Karnataka",
        terms: "Monthly retainer, net 15, renews yearly",
        createdAt: day(-361),
      },
    },
    {
      client: {
        source: "c-harbour",
        name: "Harbourline Logistics",
        placeOfSupply: "Maharashtra",
        createdAt: day(-259),
      },
    },
    {
      project: {
        source: "p-lumen",
        name: "Lumen Grove patient booking app",
        client: "c-lumen",
        state: "open",
        target: day(91),
        createdAt: day(-14),
      },
    },
    {
      project: {
        source: "p-orbit",
        name: "Orbit Dental care retainer",
        client: "c-orbit",
        state: "open",
        createdAt: day(-356),
      },
    },
    {
      project: {
        source: "p-harbour",
        name: "Harbourline driver app redesign",
        client: "c-harbour",
        state: "done",
        createdAt: day(-251),
        closedAt: day(-62),
      },
    },
    ...[
      ["w1", "Design the booking flow screens", 11],
      ["w2", "Patient onboarding copy and walkthrough", 18],
      ["w3", "Clinic staff training deck", 25],
      ["w4", "Set up the appointments API", 14],
      ["w5", "SMS reminder integration", 23],
      ["w6", "Beta release to two pilot clinics", 32],
    ].map(([source, title, due]) => ({
      entry: {
        source,
        list: "work",
        title,
        project: "p-lumen",
        due: day(Number(due)),
        createdAt: day(-13),
      },
    })),
    {
      entry: {
        source: "inv-orbit",
        list: "invoices",
        title: "Retainer, Orbit Dental Care",
        state: "waiting",
        client: "c-orbit",
        project: "p-orbit",
        date: day(-27),
        due: day(-12),
        amount: "47200.00",
        number: "INV/26-27/004",
        createdAt: day(-27),
      },
    },
    {
      entry: {
        source: "q-lumen",
        list: "quotes",
        title: "Lumen Grove booking app, fixed price",
        state: "done",
        client: "c-lumen",
        project: "p-lumen",
        date: day(-17),
        amount: "1062000.00",
        createdAt: day(-17),
      },
    },
    {
      entry: {
        source: "q-orbit",
        list: "quotes",
        title: "Orbit Dental recall dashboard",
        state: "waiting",
        client: "c-orbit",
        date: day(-6),
        amount: "354000.00",
        createdAt: day(-6),
      },
    },
  ];
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

interface WorkRecord {
  readonly key: string;
  readonly title?: string;
  readonly rev?: number;
}

/** Writes the named seed through the real entry points: RPCs as the owner, invites, `kin import`. */
export async function seed(
  instance: Instance,
  name: SeedName,
  environmentId: string,
): Promise<SeedState> {
  const owner = await RpcConnection.open(originOf(instance), await ownerToken(instance));
  const people: Record<string, { personId: string; displayName: string }> = {
    owner: { personId: OWNER_PERSON, displayName: name === "empty" ? "Owner" : "Rhea Kapoor" },
  };
  const agents: Record<string, { agentId: string; name: string; ownerChatId: string }> = {};
  try {
    if (name === "empty")
      return { name, seededAt: new Date().toISOString(), people, agents, environmentId };
    await owner.call("kin.people.setOwnerName", { orgId: ORG, displayName: "Rhea Kapoor" });
    const zone = daytimeZone();
    await owner.call("kin.triggers.setTimeZone", { orgId: ORG, timeZone: zone });
    const profile = (await owner.call("kin.work.companyProfile", { orgId: ORG })) as {
      rev: number;
    };
    await owner.call("kin.work.setCompanyProfile", {
      orgId: ORG,
      rev: profile.rev,
      legalName: "Ambermill Studio LLP",
      tradeName: "Ambermill",
      address: "4 Example Lane, Bengaluru 560001",
      placeOfSupply: "Karnataka",
      // Without one, Money asks for the country before anything else.
      country: "IN",
      homeCurrency: "INR",
    });
    for (const agent of AGENTS) {
      const created = (await owner.call("kin.lead.create", {
        orgId: ORG,
        name: agent.name,
        domain: agent.domain,
        charter: agent.charter,
        model: SCRIPT_MODEL,
      })) as { agentId: string; ownerChatId: string };
      agents[agent.key] = {
        agentId: created.agentId,
        name: agent.name,
        ownerChatId: created.ownerChatId,
      };
    }
    await owner.call("kin.org.setTeamAgent", { orgId: ORG, agentId: agents.chief!.agentId });
    for (const person of TEAM) {
      const invite = (await owner.call("kin.people.createInvite", {
        orgId: ORG,
        displayName: person.name,
      })) as { secret: string };
      const accepted = await acceptInvite(instance, invite.secret, `kin-verify ${person.key}`);
      writeSession(instance, person.key, accepted.accessToken);
      people[person.key] = { personId: accepted.person.personId, displayName: person.name };
      if ("access" in person)
        await owner.call("kin.people.setAccess", {
          orgId: ORG,
          personId: accepted.person.personId,
          access: person.access,
        });
      if ("places" in person)
        await owner.call("kin.people.setPlaces", {
          orgId: ORG,
          personId: accepted.person.personId,
          ...person.places,
        });
    }
    // Everyone works all day, so whether a message lands never depends on the hour a run starts.
    for (const [key, person] of Object.entries(people))
      await owner.call("kin.people.updateProfile", {
        orgId: ORG,
        personId: person.personId,
        timeZone: zone,
        workHours: ALL_DAY,
        ...(key === "owner" ? {} : { roleTags: TEAM.find((one) => one.key === key)!.tags }),
      });

    const file = NodePath.join(instance.meta, "seed-import.jsonl");
    NodeFS.writeFileSync(file, importLines());
    const imported = serverCli(instance, [
      "kin",
      "import",
      "--file",
      file,
      "--apply",
      "--person",
      OWNER_PERSON,
    ]);
    if (imported.status !== 0)
      throw new VerifyError(
        `kin import failed: ${(imported.stderr || imported.stdout).trim().split("\n").at(-1)}`,
      );

    const keyOf = async (title: string) => {
      const found = (await owner.call("kin.search", { orgId: ORG, text: title, limit: 5 })) as {
        hits?: ReadonlyArray<{ key?: string; title?: string }>;
      };
      const hit = found.hits?.find((one) => one.title === title);
      if (hit?.key === undefined)
        throw new VerifyError(`seed: no record titled "${title}" after import`);
      return hit.key;
    };
    const person = (key: string) => ({ _tag: "person", personId: people[key]!.personId });
    const give = [
      ["Design the booking flow screens", "zoya"],
      ["Patient onboarding copy and walkthrough", "zoya"],
      ["Clinic staff training deck", "zoya"],
      ["Set up the appointments API", "dev"],
      ["SMS reminder integration", "arjun"],
    ] as const;
    for (const [title, to] of give)
      await owner.call("kin.work.assign", { orgId: ORG, key: await keyOf(title), to: person(to) });
    const projectKey = await keyOf("Lumen Grove patient booking app");
    const project = (await owner.call("kin.work.project", { orgId: ORG, key: projectKey })) as {
      project?: WorkRecord;
      record?: WorkRecord;
      rev?: number;
    };
    const rev = project.project?.rev ?? project.record?.rev ?? project.rev ?? 0;
    await owner.call("kin.work.updateProject", {
      orgId: ORG,
      key: projectKey,
      rev,
      owner: person("dev"),
      members: [person("zoya"), person("arjun")],
    });
    await owner.call("kin.work.create", {
      orgId: ORG,
      list: "milestones",
      clientRequestId: "kin-verify-milestone-1",
      project: projectKey,
      title: "Booking flow ready",
      dueAt: at(14),
    });
    const retainerKey = await keyOf("Orbit Dental care retainer");
    const retainer = (await owner.call("kin.work.project", { orgId: ORG, key: retainerKey })) as {
      project?: WorkRecord;
      record?: WorkRecord;
      rev?: number;
    };
    await owner.call("kin.work.updateProject", {
      orgId: ORG,
      key: retainerKey,
      rev: retainer.project?.rev ?? retainer.record?.rev ?? retainer.rev ?? 0,
      renewsOn: day(9),
      // On a project he doesn't lead, so his New task picker has one to leave out.
      members: [person("dev")],
    });
    await owner.call("kin.goals.save", {
      orgId: ORG,
      clientRequestId: "kin-verify-goal-1",
      title: "Sign two new clinics this quarter",
      measure: "manual",
      target: "2",
      current: 1,
      startsOn: day(-30),
      dueOn: day(60),
    });
    if (name === "bench") benchImport(instance);
  } finally {
    owner.close();
  }
  return { name, seededAt: new Date().toISOString(), people, agents, environmentId };
}

/** What needs a running lead loop: a doc written by an agent through its real tool. */
export async function seedTurns(instance: Instance, name: SeedName) {
  if (name === "empty") return;
  const [doc] = await runTurn(instance, {
    agent: "chief",
    person: "owner",
    calls: [
      {
        name: "doc_create",
        arguments: {
          title: "Lumen Grove booking app: brief",
          kind: "spec",
          client: "Lumen Grove Clinics",
          sourceEventId: "$event",
          body: "## Goal\nPatients book, move and cancel clinic appointments from their phone.\n\n## Scope\nBooking flow, reminders by SMS, a staff view.\n",
        },
      },
    ],
    reply: "Wrote the brief.",
  });
  const response = doc?.response as {
    result?: { isError?: boolean; content?: ReadonlyArray<{ text?: string }> };
  };
  if (response?.result === undefined || response.result.isError === true)
    throw new VerifyError(`seed: doc_create failed: ${JSON.stringify(doc).slice(0, 300)}`);
  if (name === "bench") await benchTurns(instance);
  if (name === "lookbook") await lookbookTurns(instance);
}
