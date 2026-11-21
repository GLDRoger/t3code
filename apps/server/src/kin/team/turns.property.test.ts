import { assert, it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Schema from "effect/Schema";

import * as Turns from "./turns.ts";

const AGENTS = ["social", "finance", "chief", "growth"] as const;
const INTENTS = ["answer", "evidence", "objection", "decision", "question"] as const;
const ENDS = [null, null, null, "decide", "park", "bring"] as const;
/** One agent's move when its turn comes: each number picks part of what it says, or a pass. */
const moves = Arbitrary.schema(
  Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000 }))).check(
    Schema.isMaxLength(400),
  ),
);
const pick = <T>(list: ReadonlyArray<T>, n: number) => list[n % list.length]!;

/**
 * Plays a discussion with agents moving as `seeds` say: a refused message counts as a pass, as
 * ending a turn without team_say would be. Returns what the rules must keep true.
 */
const play = (seeds: ReadonlyArray<number>, decider: string) => {
  let d = Turns.opened({ openedBy: "social", decider, chair: "chief" });
  let steps = 0;
  let objections = 0;
  let mostPitches = 0;
  for (const seed of [...seeds, ...Array.from({ length: 200 }, () => 0)]) {
    if (d.final) break;
    steps++;
    const holder = d.turn!;
    const pass = seed % 5 === 0 && holder.kind !== "closing";
    const said: Turns.Said = {
      agentId: holder.agentId,
      intent: pick(INTENTS, seed >> 3),
      to: AGENTS.filter((_, i) => (seed >> (6 + i)) % 2 === 1).slice(0, (seed >> 10) % 3),
      widen: (seed >> 12) % 4 === 0,
      end:
        holder.kind === "closing"
          ? (pick(["decide", "park", "bring"], seed >> 13) as Turns.Ending)
          : pick(ENDS, seed >> 14),
      stakes: AGENTS.filter((_, i) => (seed >> (17 + i)) % 2 === 1),
    };
    if (pass || Turns.sayRefusal(d, said) !== null) {
      d = Turns.afterPass(d, holder.agentId);
      continue;
    }
    if (holder.kind === "object") objections++;
    d = Turns.afterSay(d, said);
    const queued = [d.turn, ...d.pending].filter((turn) => turn?.kind === "pitch_in").length;
    mostPitches = Math.max(mostPitches, queued);
  }
  return { d, steps, objections, mostPitches };
};

it.prop(
  "every discussion ends decided, parked or brought to the owner, within its caps",
  [moves],
  ([seeds]) => {
    const { d, steps } = play(seeds, "finance");
    return (
      d.final &&
      ["decided", "parked", "escalated"].includes(d.state) &&
      d.messages <= Turns.TEAM_MAX_MESSAGES + 1 &&
      steps <= 400
    );
  },
);

it.prop(
  "one uninvited agent at most per message, and one objection at most per discussion",
  [moves],
  ([seeds]) => {
    const { mostPitches, objections, d } = play(seeds, "chief");
    return mostPitches <= 1 && objections <= 1 && d.final;
  },
);

it.prop(
  "only the decider or the Chief of staff decides, and the question widens once",
  [moves],
  ([seeds]) => {
    let d = Turns.opened({ openedBy: "social", decider: "finance", chair: "chief" });
    for (const seed of seeds) {
      if (d.final) break;
      const holder = d.turn!;
      const said: Turns.Said = {
        agentId: holder.agentId,
        intent: pick(INTENTS, seed),
        to: [],
        widen: seed % 2 === 0,
        end: pick(ENDS, seed >> 2),
        stakes: [],
      };
      const refusal = Turns.sayRefusal(d, said);
      if (
        said.end === "decide" &&
        !["finance", "chief"].includes(holder.agentId) &&
        refusal === null
      )
        return false;
      if (said.widen && d.widened && refusal === null) return false;
      d = refusal === null ? Turns.afterSay(d, said) : Turns.afterPass(d, holder.agentId);
    }
    return true;
  },
);

it.prop(
  "agents start two at once and six a day at most; the owner's own ask always opens",
  [moves],
  ([seeds]) =>
    seeds.every((seed) => {
      const input = {
        byOwner: seed % 2 === 0,
        agentStartedToday: seed % 9,
        openNow: (seed >> 4) % 4,
        overShare: (seed >> 6) % 3 === 0,
      };
      const refused = Turns.openRefusal(input) !== null;
      const allowed =
        input.byOwner ||
        (!input.overShare &&
          input.agentStartedToday < Turns.TEAM_AGENT_STARTED_PER_DAY &&
          input.openNow < Turns.TEAM_OPEN_AT_ONCE);
      return refused === !allowed;
    }),
);

it.prop(
  "spending past the unit cap, or a day idle, leaves only the closing turn",
  [moves],
  ([seeds]) => {
    const d = Turns.opened({ openedBy: "social", decider: "finance", chair: "chief" });
    const spent = Turns.afterUnits(d, Turns.TEAM_UNITS_CAP + (seeds[0] ?? 0));
    const idle = Turns.afterIdle(d);
    // Ten warm owner-seat turns (about 32,800 units each) reach the chair check, not the cap.
    const talked = Turns.afterUnits(d, 10 * 32_800);
    return (
      talked.state === "open" &&
      talked.turn?.kind !== "closing" &&
      spent.turn?.kind === "closing" &&
      idle.turn?.kind === "closing" &&
      Turns.afterIdle(idle).state === "parked"
    );
  },
);

// The model check (verification/kin/discussion): an objection that also decided invited a second
// objection, and a decision at the message limit invited one that ran past it.
it("an objection can't also decide, and a decision at the limit stands", () => {
  const said = (agentId: string, extra: Partial<Turns.Said> = {}): Turns.Said => ({
    agentId,
    intent: "answer",
    to: [],
    widen: false,
    end: null,
    stakes: [],
    ...extra,
  });
  let d = Turns.opened({ openedBy: "social", decider: "finance", chair: "chief" });
  d = Turns.afterSay(d, said("social"));
  d = Turns.afterSay(d, said("finance", { end: "decide", intent: "decision" }));
  assert.deepStrictEqual(d.turn, { agentId: "social", kind: "object" });
  assert.isNotNull(Turns.sayRefusal(d, said("social", { intent: "objection", end: "decide" })));
  const full = {
    ...Turns.opened({ openedBy: "social", decider: "finance", chair: "chief" }),
    messages: Turns.TEAM_MAX_MESSAGES - 1,
    speakers: ["social"],
    turn: { agentId: "finance", kind: "decider" as const },
  };
  const decided = Turns.afterSay(full, said("finance", { end: "decide", intent: "decision" }));
  assert.isTrue(decided.final);
  assert.strictEqual(decided.state, "decided");
});
