import { describe, expect, it } from "vite-plus/test";

import { resolveRenameHunks } from "./kin-sync.ts";

const hunk = (ours: string, base: string, theirs: string) =>
  `before\n<<<<<<< ours\n${ours}||||||| base\n${base}=======\n${theirs}>>>>>>> theirs\nafter\n`;

describe("resolveRenameHunks", () => {
  it("takes upstream's edit and renames it when Kin only renamed the line", () => {
    const result = resolveRenameHunks(
      hunk("Restart Kin.\n", "Restart T3 Code.\n", "Restart T3 Code to apply.\n"),
    );
    expect(result).toEqual({ text: "before\nRestart Kin to apply.\nafter\n", left: 0 });
  });

  it("keeps Kin's side when upstream did not change the hunk", () => {
    const result = resolveRenameHunks(hunk("kinCommand,\n", "", ""));
    expect(result).toEqual({ text: "before\nkinCommand,\nafter\n", left: 0 });
  });

  it("leaves a hunk where both sides made real changes", () => {
    const text = hunk("const a = kin();\n", "const a = 1;\n", "const a = 2;\n");
    expect(resolveRenameHunks(text)).toEqual({ text, left: 1 });
  });

  it("does not treat Kin identifiers as the product name", () => {
    const text = hunk("KinService.layer,\n", "", "GuestShareService.layer,\n");
    expect(resolveRenameHunks(text).left).toBe(1);
  });
});
