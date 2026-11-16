// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - writes a large invented company for kin-bench.
/**
 * The `bench` seed: Ambermill (the lifecycle seed) at the size a busy studio reaches in a year,
 * so lists and long chats are realistic. Written through the real entry points: `kin import` for
 * clients, projects, tasks and money; people's RPCs for a 2,000-message group; scripted agent
 * turns for docs and the cards in that group.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { agentOf, database, rpcAs, runTurn } from "./actors.ts";
import { type Instance, ORG, OWNER_PERSON, readSeed, serverCli, sleep } from "./instance.ts";
import { type RpcConnection, VerifyError } from "./rpc.ts";

export const BENCH = {
  clients: 200,
  projects: 40,
  tasks: 500,
  docs: 300,
  messages: 2_000,
  months: 12,
  group: "Studio floor",
  /** The newest text in the long chat, which "last message visible" waits for. */
  lastLine: "bench: the last message in the studio floor",
} as const;

const day = (offset: number) => {
  const date = new Date();
  date.setDate(date.getDate() + offset);
  return date.toLocaleDateString("en-CA");
};

/** A small deterministic generator, so every run seeds the same company. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const FIRST = ["Lumen", "Orbit", "Harbour", "Cedar", "Kestrel", "Saffron", "Indigo", "Marble"];
const SECOND = ["Grove", "Dental", "Logistics", "Foods", "Clinics", "Labs", "Textiles", "Travel"];
const KIND = ["Studio", "Care", "Partners", "Works", "Collective", "Group", "Co", "Hub"];
const STATES = ["Karnataka", "Maharashtra", "Tamil Nadu", "Delhi", "Kerala", "Telangana"];
const VERBS = ["Design", "Review", "Write", "Ship", "Test", "Plan", "Fix", "Draft", "Update"];
const THINGS = [
  "the onboarding screens",
  "the pricing page copy",
  "the booking API",
  "the release notes",
  "the clinic dashboard",
  "the SMS templates",
  "the staff training deck",
  "the invoice export",
  "the accessibility pass",
  "the analytics events",
];
const CATEGORIES = ["software", "travel", "rent", "hardware", "contractors", "meals", "fees"];
const LINES = [
  "Morning! Picking up the booking flow today.",
  "Can someone look at the staging build? The calendar is off by a day.",
  "Pushed the fix, it should be on staging in ten minutes.",
  "Client call moved to 4 pm, same link.",
  "I have the first draft of the onboarding copy, sharing in a bit.",
  "Lunch order going in at 1, reply with what you want.",
  "Who has the Figma file for the clinic dashboard?",
  "The SMS provider says our sender id is approved.",
  "Heads up: I'm out tomorrow afternoon for a doctor's appointment.",
  "Looks good to me, ship it.",
  "We need the logo files in SVG, not PNG, for the app icon.",
  "Retro notes from Friday: fewer meetings, earlier reviews, and the release checklist actually used before every build instead of after the first bug report comes in from a clinic.",
  "Thanks, that's exactly what they asked for.",
  "Did anyone hear back from Orbit about the recall dashboard quote?",
  "I'll take the accessibility pass on the booking screens.",
];

function importLines(): string {
  const next = random(7);
  const pick = <A>(list: ReadonlyArray<A>) => list[Math.floor(next() * list.length)]!;
  const rows: Array<unknown> = [
    {
      format: "kin-import",
      version: 1,
      batch: "kin-bench",
      source: "kin-bench seed",
      lists: [{ list: "expenses", template: "expenses" }],
    },
  ];
  for (let index = 0; index < BENCH.clients; index++)
    rows.push({
      client: {
        source: `bc-${index}`,
        name: `${pick(FIRST)} ${pick(SECOND)} ${pick(KIND)} ${index + 1}`,
        placeOfSupply: pick(STATES),
        createdAt: day(-Math.floor(next() * 365)),
      },
    });
  for (let index = 0; index < BENCH.projects; index++)
    rows.push({
      project: {
        source: `bp-${index}`,
        name: `Project ${index + 1}: ${pick(THINGS).replace("the ", "")}`,
        client: `bc-${index * 5}`,
        state: index % 5 === 4 ? "done" : "open",
        createdAt: day(-Math.floor(next() * 300) - 10),
        ...(index % 5 === 4 ? { closedAt: day(-Math.floor(next() * 9) - 1) } : {}),
      },
    });
  for (let index = 0; index < BENCH.tasks; index++) {
    const done = next() < 0.35;
    rows.push({
      entry: {
        source: `bw-${index}`,
        list: "work",
        title: `${pick(VERBS)} ${pick(THINGS)} (${index + 1})`,
        project: `bp-${index % BENCH.projects}`,
        state: done ? "done" : next() < 0.2 ? "waiting" : "open",
        due: day(Math.floor(next() * 60) - 20),
        createdAt: day(-Math.floor(next() * 90) - 1),
        ...(done ? { closedAt: day(-Math.floor(next() * 10) - 1) } : {}),
        ...(next() < 0.3 ? { notes: `${pick(LINES)} ${pick(LINES)}` } : {}),
      },
    });
  }
  for (let month = 0; month < BENCH.months; month++) {
    const base = -30 * month;
    for (let index = 0; index < 20; index++)
      rows.push({
        entry: {
          source: `be-${month}-${index}`,
          list: "expenses",
          title: `${pick(VERBS)} ${pick(THINGS).replace("the ", "")}`,
          category: pick(CATEGORIES),
          state: "done",
          date: day(base - Math.floor(next() * 28)),
          amount: `${Math.floor(next() * 90_000) + 500}.00`,
          createdAt: day(base - 28),
        },
      });
    for (let index = 0; index < 8; index++) {
      const amount = Math.floor(next() * 400_000) + 20_000;
      const paid = month > 0 && next() < 0.8;
      const date = day(base - Math.floor(next() * 28));
      rows.push({
        entry: {
          source: `bi-${month}-${index}`,
          list: "invoices",
          title: `Invoice ${month}-${index}: ${pick(THINGS).replace("the ", "")}`,
          client: `bc-${(month * 8 + index) % BENCH.clients}`,
          project: `bp-${(month * 8 + index) % BENCH.projects}`,
          state: paid ? "done" : "waiting",
          date,
          due: day(base - Math.floor(next() * 28) + 15),
          amount: `${amount}.00`,
          number: `BN/${month}/${index}`,
          createdAt: date,
          ...(paid
            ? {
                payments: [
                  {
                    source: `bpay-${month}-${index}`,
                    amount: `${amount}.00`,
                    paidOn: day(base + 5),
                  },
                ],
              }
            : {}),
        },
      });
    }
  }
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

/** Clients, projects, tasks and a year of money, through `kin import`; then some tasks handed out. */
export function benchImport(instance: Instance) {
  const file = NodePath.join(instance.meta, "bench-import.jsonl");
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
      `bench import failed: ${(imported.stderr || imported.stdout).trim().split("\n").at(-1)}`,
    );
}

/** Hands a third of the open bench tasks to the four teammates, as the owner would. */
async function assignSome(instance: Instance) {
  const seed = readSeed(instance)!;
  const team = ["meera", "dev", "zoya", "arjun"].map((key) => seed.people[key]!.personId);
  const db = database(instance);
  const keys = (
    db
      .prepare(
        `SELECT key FROM kin_records WHERE org_id = ? AND register_id = 'work' AND state = 'open' AND title LIKE '% (%)' ORDER BY key`,
      )
      .all(ORG) as Array<{ key: string }>
  ).map((row) => row.key);
  db.close();
  const owner = await rpcAs(instance, "owner");
  try {
    for (const [index, key] of keys.entries())
      if (index % 3 === 0)
        await owner.call("kin.work.assign", {
          orgId: ORG,
          key,
          to: { _tag: "person", personId: team[index % team.length] },
        });
  } finally {
    owner.close();
  }
}

/** Waits until no wake-up runs, so the next message starts a turn of its own. */
export async function quiet(instance: Instance) {
  for (let waited = 0; waited < 120_000; waited += 500) {
    const db = database(instance);
    const running = (
      db.prepare(`SELECT COUNT(*) AS n FROM kin_wakeups WHERE status = 'running'`).get() as {
        n: number;
      }
    ).n;
    db.close();
    if (running === 0) return sleep(1000);
    await sleep(500);
  }
}

/** A scripted turn of `agent` answering a message in a group that mentions it. */
async function groupTurn(
  instance: Instance,
  chatId: string,
  agentMember: string,
  calls: ReadonlyArray<{ name: string; arguments?: unknown }>,
) {
  const id = NodeCrypto.randomBytes(6).toString("hex");
  const turns = NodePath.join(instance.meta, "turns");
  NodeFS.mkdirSync(turns, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(turns, `${id}.json`),
    JSON.stringify({ calls, reply: "Here." }),
  );
  const owner = await rpcAs(instance, "owner");
  let seq: number;
  try {
    seq = (
      (await owner.call("kin.messages.send", {
        chatId,
        clientMessageId: `kin-bench-${id}`,
        body: `[kv:${id}] numbers please`,
        mentions: [agentMember],
      })) as { seq: number }
    ).seq;
  } finally {
    owner.close();
  }
  const result = NodePath.join(turns, `${id}.result.json`);
  const db = database(instance);
  try {
    for (let waited = 0; waited < 120_000; waited += 250) {
      if (
        NodeFS.existsSync(result) &&
        db
          .prepare(
            `SELECT 1 FROM kin_messages WHERE chat_id = ? AND seq > ? AND author_kind = 'agent' LIMIT 1`,
          )
          .get(chatId, seq) !== undefined
      )
        return JSON.parse(NodeFS.readFileSync(result, "utf8")) as { results: Array<unknown> };
      await sleep(250);
    }
  } finally {
    db.close();
  }
  throw new VerifyError("bench: the group card turn did not finish in 120 s");
}

const chartCall = (index: number) => ({
  name: "kin_chart",
  arguments: {
    chart: index % 2 === 0 ? "bar" : "line",
    title: `Tasks closed per week, round ${index + 1}`,
    unit: { kind: "count" },
    labelType: "category",
    labels: ["W1", "W2", "W3", "W4", "W5", "W6"],
    series: [{ name: "Closed", values: [4, 7, 5, 9, 6, 8].map((value) => value + index) }],
  },
});
const askCall = (index: number) => ({
  name: "kin_ask",
  arguments: {
    question: `Which build goes to the pilot clinics this week (${index + 1})?`,
    options: [{ label: "Tuesday's build" }, { label: "Thursday's build" }],
  },
});

/**
 * The long chat: a group of the five people, 2,000 messages written by them in rounds, with the
 * Chief of staff added between rounds for a turn that posts chart and choice cards.
 */
async function longChat(instance: Instance) {
  const seed = readSeed(instance)!;
  const keys = ["owner", "meera", "dev", "zoya", "arjun"];
  const rpcs = new Map<string, RpcConnection>();
  for (const key of keys) rpcs.set(key, await rpcAs(instance, key));
  try {
    const owner = rpcs.get("owner")!;
    const group = (await owner.call("kin.groups.create", {
      orgId: ORG,
      title: BENCH.group,
      agentIds: [],
      personIds: keys.filter((key) => key !== "owner").map((key) => seed.people[key]!.personId),
    })) as { chatId: string };
    const chief = agentOf(instance, "chief");
    const rounds = 5;
    const perRound = BENCH.messages / rounds;
    let sent = 0;
    const cards: Array<unknown> = [];
    for (let round = 0; round < rounds; round++) {
      for (let index = 0; index < perRound; index++, sent++) {
        const author = keys[(sent * 7 + (sent >> 3)) % keys.length]!;
        const last = sent === BENCH.messages - 1;
        await rpcs.get(author)!.call("kin.messages.send", {
          chatId: group.chatId,
          clientMessageId: `kin-bench-${sent}`,
          body: last ? BENCH.lastLine : `${LINES[sent % LINES.length]} (#${sent + 1})`,
        });
      }
      if (round === rounds - 1) break;
      const member = (await owner.call("kin.groups.addMember", {
        chatId: group.chatId,
        principal: { _tag: "agent", agentId: chief.agentId },
      })) as { memberId: string };
      await quiet(instance);
      const turn = await groupTurn(instance, group.chatId, member.memberId, [
        chartCall(round),
        askCall(round),
        chartCall(round + 10),
      ]);
      cards.push(...turn.results);
      await owner.call("kin.groups.removeMember", {
        chatId: group.chatId,
        memberId: member.memberId,
      });
    }
    const failed = cards.filter((one) => JSON.stringify(one).includes('"isError":true'));
    if (failed.length > 0)
      throw new VerifyError(
        `bench: a card call failed: ${JSON.stringify(failed[0]).slice(0, 300)}`,
      );
    return group.chatId;
  } finally {
    for (const rpc of rpcs.values()) rpc.close();
  }
}

/** 300 docs across the company and clients, written by the Chief of staff in batches of 50. */
async function docs() {
  const calls = Array.from({ length: BENCH.docs }, (_, index) => ({
    name: "doc_create",
    arguments: {
      title: `${["Brief", "Meeting notes", "Runbook", "Proposal", "Report"][index % 5]} ${index + 1}`,
      kind: ["spec", "notes", "playbook", "proposal", "report"][index % 5],
      ...(index % 3 === 0 ? { company: true } : {}),
      body: `## Summary\n${LINES[index % LINES.length]}\n\n## Details\n${LINES.slice(0, 6).join("\n\n")}\n\n## Next\n- ${THINGS[index % THINGS.length]}\n`,
      ...(index % 50 === 0 ? { card: true } : {}),
    },
  }));
  const batches: Array<typeof calls> = [];
  for (let index = 0; index < calls.length; index += 50)
    batches.push(calls.slice(index, index + 50));
  return batches;
}

/** The bench seed's parts that need the lead runner: docs, cards and the long group. */
export async function benchTurns(instance: Instance) {
  for (const batch of await docs()) {
    // A message sent while a wake-up runs joins it, and its tools then name the wrong event:
    // wait for quiet, and redo once from the first call that failed.
    let calls = batch;
    let failed: unknown;
    for (let attempt = 0; attempt < 2 && calls.length > 0; attempt++) {
      await quiet(instance);
      const results = await runTurn(instance, {
        agent: "chief",
        person: "owner",
        calls,
        reply: "Filed.",
        timeoutMs: 300_000,
      });
      const at = results.findIndex(
        (one) => one.error !== undefined || JSON.stringify(one.response).includes('"isError":true'),
      );
      failed = at === -1 ? undefined : results[at];
      calls = at === -1 ? [] : calls.slice(at);
    }
    if (failed !== undefined)
      throw new VerifyError(`bench: doc_create failed: ${JSON.stringify(failed).slice(0, 300)}`);
  }
  await assignSome(instance);
  await longChat(instance);
}
