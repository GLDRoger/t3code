import { EnvironmentId, KinOrgId, type KinRefreshes } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { kinRefreshTriggers } from "./kinRefresh.ts";

const target = { environmentId: EnvironmentId.make("env"), input: { orgId: KinOrgId.make("org") } };

function setup() {
  const revisions = Atom.make<AsyncResult.AsyncResult<KinRefreshes, unknown>>(
    AsyncResult.initial(),
  );
  const elsewhere = Atom.make<AsyncResult.AsyncResult<KinRefreshes, unknown>>(
    AsyncResult.initial(),
  );
  const session = Atom.make(1);
  const triggers = kinRefreshTriggers(
    ({ input }) => (input.orgId === target.input.orgId ? revisions : elsewhere),
    () => session,
  );
  const registry = AtomRegistry.make();
  const heard = (revision: KinRefreshes) => registry.set(revisions, AsyncResult.success(revision));
  return { registry, revisions, session, triggers, heard };
}

describe("kinRefreshTriggers", () => {
  it("moves a read's signal only when its own topic moves, or on a new session of an older host", () => {
    const { registry, revisions, session, triggers, heard } = setup();
    const memory = triggers("memory")(target);
    const company = triggers("company")(target);
    const other = triggers("memory")({ ...target, input: { orgId: KinOrgId.make("other") } });
    const unmount = [memory, company, other].map((atom) => registry.mount(atom));
    const read = () => [registry.get(memory), registry.get(company), registry.get(other)];
    expect(read()).toEqual(["0:0", "0:0", "0:0"]);
    // The first revisions are where things stand, not a change.
    heard({ memory: 3, company: 1 });
    expect(read()).toEqual(["0:0", "0:0", "0:0"]);
    heard({ memory: 4, company: 1, people: 9 });
    expect(read()).toEqual(["0:1", "0:0", "0:0"]);
    expect(registry.get(triggers.moves("memory")(target))).toBe(1);
    // Reconnecting, or a host that can't say, changes nothing.
    registry.set(revisions, AsyncResult.initial(true));
    expect(read()).toEqual(["0:1", "0:0", "0:0"]);
    heard({ memory: 4, company: 1 });
    expect(read()).toEqual(["0:1", "0:0", "0:0"]);
    // A host that doesn't name its run can't resume: each new session reads again.
    registry.set(session, 2);
    expect(read()).toEqual(["1:1", "1:0", "1:0"]);
    for (const stop of unmount) stop();
  });

  it("resumes across sessions on a host that names its run, and moves every topic in a new run", () => {
    const { registry, session, triggers, heard } = setup();
    const memory = triggers("memory")(target);
    const company = triggers("company")(target);
    const unmount = [memory, company].map((atom) => registry.mount(atom));
    const read = () => [registry.get(memory), registry.get(company)];
    heard({ memory: 3, company: 1, boot: "a" });
    expect(read()).toEqual(["0:0", "0:0"]);
    registry.set(session, 2);
    heard({ memory: 3, company: 1, boot: "a" });
    expect(read()).toEqual(["0:0", "0:0"]);
    // The host restarted: its numbers start over, and may even match the old ones.
    registry.set(session, 3);
    heard({ memory: 3, company: 1, boot: "b" });
    expect(read()).toEqual(["0:1", "0:1"]);
    for (const stop of unmount) stop();
  });

  it("keeps a move a read missed while nothing watched it", () => {
    const { registry, triggers, heard } = setup();
    const memory = triggers("memory")(target);
    const watched = registry.mount(memory);
    heard({ memory: 1 });
    const before = registry.get(memory);
    watched();
    heard({ memory: 2 });
    registry.mount(memory);
    expect(registry.get(memory)).not.toBe(before);
  });

  it("keeps whether the host streams a read through a reconnect", () => {
    const { registry, revisions, triggers, heard } = setup();
    const pulse = triggers.serves("pulse")(target);
    const unmount = registry.mount(pulse);
    expect(registry.get(pulse)).toBeNull();
    heard({ streams: ["pulse"] });
    expect(registry.get(pulse)).toBe(true);
    // Reconnecting: what the host said still stands, so nothing reading it starts over.
    registry.set(revisions, AsyncResult.initial(true));
    expect(registry.get(pulse)).toBe(true);
    heard({});
    expect(registry.get(pulse)).toBe(false);
    unmount();
  });
});
