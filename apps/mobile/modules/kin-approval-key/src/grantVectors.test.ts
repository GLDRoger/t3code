import * as NodeFS from "node:fs";

import { stableStringify } from "@t3tools/shared/relaySigning";
import { describe, expect, it } from "vite-plus/test";

// The Swift and Java parsers run these through test/native/run.sh; this ties the vectors they
// accept to the encoder the server uses, so a grant the server writes is one the phone accepts.
const vectors: {
  cases: ReadonlyArray<{ name: string; header?: string; payload?: string; prompt?: string }>;
} = JSON.parse(
  NodeFS.readFileSync(new URL("../fixtures/grant-vectors.json", import.meta.url), "utf8"),
);

describe("grant vectors", () => {
  it("accept exactly what stableStringify writes", () => {
    const accepted = vectors.cases.filter((vector) => vector.prompt !== undefined);
    expect(accepted.length).toBeGreaterThan(10);
    for (const { name, header = "", payload = "" } of accepted) {
      expect({ name, header: stableStringify(JSON.parse(header)) }).toEqual({ name, header });
      expect({ name, payload: stableStringify(JSON.parse(payload)) }).toEqual({ name, payload });
    }
  });
});
