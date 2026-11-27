import { describe, expect, it } from "vite-plus/test";

import { kinCoalesced } from "./kinCoalesced";

describe("kinCoalesced", () => {
  it("runs once more after a pass that triggers came during, never dropping or piling them", async () => {
    const passes: Array<() => void> = [];
    const run = () => new Promise<void>((resolve) => passes.push(resolve));
    const trigger = kinCoalesced(run);
    trigger();
    // Three pushes arrive while the first check is still with the host.
    trigger();
    trigger();
    trigger();
    expect(passes).toHaveLength(1);
    passes[0]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(passes).toHaveLength(2);
    passes[1]!();
    await Promise.resolve();
    await Promise.resolve();
    expect(passes).toHaveLength(2);
    // Idle again: the next trigger runs at once.
    trigger();
    expect(passes).toHaveLength(3);
  });
});
