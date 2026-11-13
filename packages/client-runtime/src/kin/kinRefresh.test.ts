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
  it("moves a read's signal only when its own topic moves, or on a new session", () => {
    const { registry, revisions, session, triggers, heard } = setup();
    const memory = triggers("memory")(target);
    const company = triggers("company")(target);
    const other = triggers("memory")({ ...target, input: { orgId: KinOrgId.make("other") } });
    const unmount = [memory, company, other].map((atom) => registry.mount(atom));
    const read = () => [registry.get(memory), registry.get(company), registry.get(other)];
    expect(read()).toEqual(["1:0", "1:0", "1:0"]);
    // The first revisions are where things stand, not a change.
    heard({ memory: 3, company: 1 });
    expect(read()).toEqual(["1:0", "1:0", "1:0"]);
    heard({ memory: 4, company: 1, people: 9 });
    expect(read()).toEqual(["1:1", "1:0", "1:0"]);
    // Reconnecting, or a host that can't say, changes nothing.
    registry.set(revisions, AsyncResult.initial(true));
    expect(read()).toEqual(["1:1", "1:0", "1:0"]);
    heard({ memory: 4, company: 1 });
    expect(read()).toEqual(["1:1", "1:0", "1:0"]);
    registry.set(session, 2);
    expect(read()).toEqual(["2:1", "2:0", "2:0"]);
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
});
