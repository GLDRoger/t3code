import { describe, expect, it } from "@effect/vitest";

import { resolveKinCliName } from "./cliName.ts";

describe("resolveKinCliName", () => {
  it("reads the launcher env, the desktop path, and the invoked argv", () => {
    expect(resolveKinCliName({ env: { KIN_CLI_NAME: "kin" }, argv: ["node", "/bin/t3"] })).toBe(
      "kin",
    );
    expect(resolveKinCliName({ env: { T3CODE_CLI_PATH: "/opt/Kin/bin/kin" } })).toBe("kin");
    expect(resolveKinCliName({ argv: ["node", "/usr/local/bin/kin.mjs"] })).toBe("kin");
    expect(resolveKinCliName({ argv: ["node", "/usr/local/bin/t3"] })).toBe("t3");
    expect(resolveKinCliName({})).toBe("t3");
  });
});
