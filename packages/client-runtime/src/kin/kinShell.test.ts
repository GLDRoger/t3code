import type { KinShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinSectionOffLine, kinSectionOn, kinShellSwitched } from "./kinShell.ts";

const defaults: KinShell = {
  rev: 0,
  sections: [
    { id: "clients", on: true },
    { id: "deals", on: true },
    { id: "money", on: true },
    { id: "invoices", on: true },
    { id: "docs", on: true },
  ],
};
const dealsOff: KinShell = {
  rev: 1,
  sections: defaults.sections.map((one) => (one.id === "deals" ? { ...one, on: false } : one)),
};

describe("kinSectionOn", () => {
  it.each([
    ["an older host that sends no shell", undefined, true],
    ["a viewer the host hasn't answered yet", null, true],
    ["the default shell", defaults, true],
    ["a shell that doesn't name deals", { rev: 2, sections: [{ id: "money", on: false }] }, true],
    ["Deals switched off", dealsOff, false],
  ] as const)("deals for %s: %s", (_, shell, on) => {
    expect(kinSectionOn(shell, "deals")).toBe(on);
  });

  it("keeps every other section on while Deals is off", () => {
    expect(
      (["clients", "money", "invoices", "docs"] as const).map((id) => kinSectionOn(dealsOff, id)),
    ).toEqual([true, true, true, true]);
  });
});

describe("kinShellSwitched", () => {
  it("sends every section as held, at the read revision, with only the one switched", () => {
    expect(kinShellSwitched(defaults, "deals", false)).toEqual({
      rev: 0,
      shell: { sections: dealsOff.sections },
    });
    expect(kinShellSwitched(dealsOff, "deals", true)).toEqual({
      rev: 1,
      shell: { sections: defaults.sections },
    });
  });

  it("keeps a section's name and dock, and adds one the shell didn't name", () => {
    const named: KinShell = { rev: 4, sections: [{ id: "clients", on: true, name: "Patients" }] };
    expect(kinShellSwitched(named, "deals", false).shell.sections).toEqual([
      { id: "clients", on: true, name: "Patients" },
      { id: "deals", on: false },
    ]);
  });
});

describe("kinSectionOffLine", () => {
  it("says nothing while Deals is on, and where to turn it on once off", () => {
    expect(kinSectionOffLine(defaults, "deals", true)).toBeNull();
    expect(kinSectionOffLine(undefined, "deals", false)).toBeNull();
    expect(kinSectionOffLine(dealsOff, "deals", true)).toBe(
      "Deals is turned off. You can turn it on in Settings › Deals.",
    );
    expect(kinSectionOffLine(dealsOff, "deals", false)).toBe(
      "Deals is turned off. The owner can turn it on in Settings › Deals.",
    );
  });
});
