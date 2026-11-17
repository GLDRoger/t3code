import { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { makeKinClient } from "./kinClient.ts";
import { kinAskAboutAgent, kinLiveOrPlain, makeKinScreenReads } from "./kinScreenReads.ts";

const target = { environmentId: EnvironmentId.make("kin-host"), orgId: KinOrgId.make("org") };

function setup() {
  const runtime = Atom.runtime(
    Layer.empty as unknown as Layer.Layer<EnvironmentRegistry.EnvironmentRegistry>,
  );
  const registry = AtomRegistry.make();
  const { kinClient } = makeKinClient(runtime, registry);
  return Object.assign(makeKinScreenReads(kinClient, registry), { registry });
}

describe("kinLiveOrPlain", () => {
  it.each([
    [true, true, "live"],
    [true, false, "plain"],
    [true, null, "waiting"],
    // A teammate never asks for the owner-level stream; the host would refuse it anyway.
    [false, true, "plain"],
    [false, null, "plain"],
  ] as const)("owner level %s, host streams %s: %s", (ownerLevel, streamed, where) => {
    expect(kinLiveOrPlain(ownerLevel, streamed)).toBe(where);
  });
});

describe("makeKinScreenReads", () => {
  it("gives a teammate's Money the plain read and the owner level the stream", () => {
    const reads = setup();
    expect(reads.moneyLive(target, "summary", false, true)).toBeNull();
    expect(reads.moneyLive(target, "summary", true, null)).toBeUndefined();
    const live = reads.moneyLive(target, "summary", true, true);
    expect(live).not.toBeNull();
    // Each part has one atom per host and org, whichever screen asks.
    expect(reads.moneyLive(target, "summary", true, true)?.atom).toBe(live?.atom);
    const plain = reads.money(target, "screen");
    expect(reads.chosen(live, plain, true).atom).toBe(live?.atom);
    expect(reads.chosen(null, plain, true).atom).toBe(plain);
    expect(reads.chosen(undefined, plain, true).atom).toBeNull();
    expect(reads.chosen(live, plain, false).atom).toBeNull();
  });

  it("hides a fact answered here until the live read says where it stands", () => {
    const reads = setup();
    reads.markAnswered(target, "fact-1", true);
    reads.markAnswered(target, "fact-2", true);
    reads.markAnswered(target, "fact-1", false);
    expect(reads.registry.get(reads.answered(target))).toEqual(["fact-2"]);
  });
});

describe("kinAskAboutAgent", () => {
  const leads = [
    { agentId: "agent-finance", name: "Finance", domain: "money" },
    { agentId: "agent-chief", name: "Chief of staff", domain: "everything" },
    { agentId: "agent-old", name: "Social", domain: "posts", retired: true },
  ];
  it("opens the agent a row names while it works, else the Chief of staff", () => {
    expect(kinAskAboutAgent(leads, "agent-finance")?.name).toBe("Finance");
    expect(kinAskAboutAgent(leads, "agent-old")?.name).toBe("Chief of staff");
    expect(kinAskAboutAgent(leads, null)?.name).toBe("Chief of staff");
    expect(kinAskAboutAgent([], null)).toBeNull();
  });
});
