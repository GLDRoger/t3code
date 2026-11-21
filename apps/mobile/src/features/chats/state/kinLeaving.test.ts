import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { appAtomRegistry } from "../../../state/atom-registry";
import { kinLeavingAtom, kinLetGo } from "./kinLeaving";

const studio = EnvironmentId.make("studio-desktop");

describe("kinLetGo", () => {
  it("hides a computer while it is let go, then not: done, or failed", async () => {
    for (const outcome of ["done", "failed"] as const) {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const letting = kinLetGo(studio, () => promise);
      expect(appAtomRegistry.get(kinLeavingAtom), outcome).toEqual([studio]);
      if (outcome === "done") resolve();
      else reject(new Error("removal failed"));
      await letting.catch(() => undefined);
      // Signed out, then joined again as someone else: the same id shows again.
      expect(appAtomRegistry.get(kinLeavingAtom), outcome).toEqual([]);
    }
  });
});
