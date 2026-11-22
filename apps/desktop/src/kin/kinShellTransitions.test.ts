import { assert, describe, it } from "@effect/vitest";

import { makeKinShellTransitions } from "./kinShellTransitions.ts";

const ARJUN = "https://kin.ambermill.example";
const OTHER = "https://kin.other.example";
const INVITE_ROUTE = "/api/kin/invite/accept";

describe("makeKinShellTransitions", () => {
  it("drops a launch check that comes back after the person moved on", () => {
    const owner = makeKinShellTransitions(ARJUN);
    const launch = owner.begin();
    const join = owner.startJoin(OTHER, "/kin/invite", INVITE_ROUTE);
    assert.isFalse(owner.isCurrent(launch));
    assert.isFalse(owner.signedOut(launch, ARJUN));
    assert.strictEqual(owner.remembered(), ARJUN);
    assert.strictEqual(owner.hostOrigin(), OTHER);
    assert.isNotNull(owner.joined(join.generation));
  });

  it("keeps the old team until a new link works, then clears it", () => {
    const owner = makeKinShellTransitions(ARJUN);
    const spent = owner.startJoin(OTHER, "/kin/invite", INVITE_ROUTE);
    assert.deepStrictEqual(owner.failed(spent.generation), { origin: OTHER, previous: ARJUN });
    assert.strictEqual(owner.remembered(), ARJUN);
    assert.strictEqual(owner.hostOrigin(), ARJUN);
    assert.isNull(owner.joined(spent.generation));

    const working = owner.startJoin(OTHER, "/kin/invite", INVITE_ROUTE);
    owner.committed(working.generation);
    assert.isTrue(owner.attempt()?.committed);
    assert.deepStrictEqual(owner.joined(working.generation), { origin: OTHER, clear: ARJUN });
    assert.strictEqual(owner.remembered(), OTHER);
  });

  it("ignores an answer for a link the person has since left", () => {
    const owner = makeKinShellTransitions(null);
    const first = owner.startJoin(ARJUN, "/pair", "/api/auth/browser-session");
    owner.begin();
    assert.isNull(owner.joined(first.generation));
    assert.isNull(owner.failed(first.generation));
    assert.strictEqual(owner.remembered(), null);
  });

  it("signs out only the team the launch check asked about", () => {
    const owner = makeKinShellTransitions(ARJUN);
    const launch = owner.begin();
    assert.isTrue(owner.signedOut(launch, ARJUN));
    assert.strictEqual(owner.remembered(), null);
  });
});
