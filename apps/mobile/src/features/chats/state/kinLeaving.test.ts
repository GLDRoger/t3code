import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { appAtomRegistry } from "../../../state/atom-registry";
import { kinLeavingAtom, kinLetGo } from "./kinLeaving";

const studio = EnvironmentId.make("studio-desktop");

describe("kinLetGo", () => {
  it("hides a computer while it is let go, then not: done, or failed", async () => {
    for (const outcome of ["done", "failed"] as const) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const letting = kinLetGo([studio], () => promise);
      expect(appAtomRegistry.get(kinLeavingAtom), outcome).toEqual([studio]);
      if (outcome === "done") resolve();
      else reject(new Error("removal failed"));
      await letting.catch(() => undefined);
      // Signed out, then joined again as someone else: the same id shows again.
      expect(appAtomRegistry.get(kinLeavingAtom), outcome).toEqual([]);
    }

    // A team's computers hide together; one that fails doesn't keep the rest from going.
    const spare = EnvironmentId.make("spare-laptop");
    const removed: Array<EnvironmentId> = [];
    const letting = kinLetGo([studio, spare], async (id) => {
      expect(appAtomRegistry.get(kinLeavingAtom)).toContain(spare);
      removed.push(id);
      if (id === studio) throw new Error("removal failed");
    });
    await expect(letting).rejects.toThrow("removal failed");
    expect(removed).toEqual([studio, spare]);
    expect(appAtomRegistry.get(kinLeavingAtom)).toEqual([]);
  });
});
