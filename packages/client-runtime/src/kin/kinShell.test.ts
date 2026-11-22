import type { KinShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { kinSearchHint, kinSearchPlaceholder } from "./kinDocs.ts";
import {
  kinPickerNamed,
  kinSectionHeldOffLine,
  kinSectionNamed,
  kinSectionNamedWords,
  kinSectionNameProblem,
  kinSectionListed,
  kinSectionOf,
  kinSectionOffLine,
  kinSectionOn,
  kinShellChanged,
  kinShellSwitched,
} from "./kinShell.ts";

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

const off = (...ids: ReadonlyArray<string>): KinShell => ({
  rev: 5,
  sections: defaults.sections.map((one) => (ids.includes(one.id) ? { ...one, on: false } : one)),
});
const patients: KinShell = {
  rev: 6,
  sections: defaults.sections.map((one) =>
    one.id === "clients" ? { ...one, name: "Patients", noun: "patient" } : one,
  ),
};

describe("kinSectionOn follows what each section needs, as the host's sectionOn", () => {
  it.each([
    // shell, clients, deals, money, invoices
    ["all on", defaults, [true, true, true, true]],
    [
      "Clients off: Deals and Invoices go with it",
      off("clients", "invoices"),
      [false, false, true, false],
    ],
    ["Clients off, Deals still stored on", off("clients"), [false, false, true, false]],
    [
      "Money off: Invoices goes with it, though stored on",
      off("money"),
      [true, true, false, false],
    ],
    ["Invoices off alone", off("invoices"), [true, true, true, false]],
  ] as const)("%s", (_, shell, [clients, deals, money, invoices]) => {
    expect(
      (["clients", "deals", "money", "invoices"] as const).map((id) => kinSectionOn(shell, id)),
    ).toEqual([clients, deals, money, invoices]);
    expect(kinSectionOn(shell, "docs")).toBe(true);
  });

  it("says why a section whose own switch is on reads as off", () => {
    expect(kinSectionHeldOffLine(off("money"), "invoices")).toBe("Off because Money is off.");
    expect(kinSectionHeldOffLine(off("clients", "money"), "invoices")).toBe(
      "Off because Clients and Money are off.",
    );
    expect(kinSectionHeldOffLine(off("clients"), "deals")).toBe("Off because Clients is off.");
    expect(kinSectionHeldOffLine(defaults, "deals")).toBeNull();
    // Named as the company names it.
    const named: KinShell = {
      rev: 7,
      sections: patients.sections.map((one) =>
        one.id === "clients" ? { ...one, on: false } : one,
      ),
    };
    expect(kinSectionHeldOffLine(named, "deals")).toBe("Off because Patients is off.");
  });
});

describe("kinSectionOffLine", () => {
  it.each([
    ["clients", off("clients", "invoices"), "Clients is turned off for this company."],
    ["money", off("money"), "Money is turned off for this company."],
    ["invoices", off("invoices"), "Invoices and quotes is turned off for this company."],
    // Held off by another section: the line names the one to turn on.
    ["invoices", off("money"), "Money is turned off for this company."],
    ["deals", off("clients"), "Clients is turned off for this company."],
  ] as const)("%s in %#", (id, shell, line) => {
    expect(kinSectionOffLine(shell, id, true)).toBe(
      `${line} You can turn it on in Settings › Sections.`,
    );
    expect(kinSectionOffLine(shell, id, false)).toBe(
      `${line} An owner can turn it on in Settings › Sections.`,
    );
  });

  it("says the company's own name, as the host's refusal does", () => {
    const named: KinShell = {
      rev: 8,
      sections: patients.sections.map((one) =>
        one.id === "clients" ? { ...one, on: false } : one,
      ),
    };
    expect(kinSectionOffLine(named, "clients", false)).toBe(
      "Patients is turned off for this company. An owner can turn it on in Settings › Sections.",
    );
  });
});

describe("kinSectionNamed", () => {
  it("says Kin's words about Clients in the company's name, capitals kept", () => {
    expect(kinSectionNamed(patients, "Clients")).toBe("Patients");
    expect(kinSectionNamed(patients, "Search clients")).toBe("Search patients");
    expect(kinSectionNamed(patients, "New client")).toBe("New patient");
    expect(kinSectionNamed(patients, "Client stays Kestrel")).toBe("Patient stays Kestrel");
    expect(kinSectionNamed(patients, "Add the client in Clients first.")).toBe(
      "Add the patient in Patients first.",
    );
    expect(kinSectionNamed(patients, "its client's contacts")).toBe("its patient's contacts");
    // Only whole words: a word that merely contains it is left alone.
    expect(kinSectionNamed(patients, "clientele")).toBe("clientele");
    // An acronym keeps its capitals in a sentence.
    const ngos: KinShell = {
      rev: 1,
      sections: [{ id: "clients", on: true, name: "NGOs", noun: "NGO" }],
    };
    expect(kinSectionNamed(ngos, "Search clients")).toBe("Search NGOs");
    expect(kinSectionNamed(ngos, "New client")).toBe("New NGO");
  });

  it("changes nothing with Kin's name, or from a host older than sections", () => {
    expect(kinSectionNamed(defaults, "Search clients")).toBe("Search clients");
    expect(kinSectionNamed(undefined, "Search clients")).toBe("Search clients");
    const words = { title: "Clients", add: (name: string) => `Add ${name} as a client` };
    expect(kinSectionNamedWords(defaults, words)).toBe(words);
    const named = kinSectionNamedWords(patients, words);
    expect(named.title).toBe("Patients");
    expect(named.add("Acme")).toBe("Add Acme as a patient");
    // Built once per name.
    expect(kinSectionNamedWords(patients, words)).toBe(named);
  });

  it("names a client picker's own words and never a record's", () => {
    const picker = {
      noun: "client" as const,
      label: "Client",
      placeholder: "No client",
      extra: { key: "none", title: "No client" },
      choices: [{ key: "C-1", title: "Client Partners Ltd" }],
    };
    const named = kinPickerNamed(patients, picker);
    expect([named.label, named.placeholder, named.extra.title]).toEqual([
      "Patient",
      "No patient",
      "No patient",
    ]);
    expect(named.choices).toBe(picker.choices);
    expect(kinPickerNamed(patients, { ...picker, noun: "project" as const }).label).toBe("Client");
  });

  it("searches only the sections that are on, in the company's words", () => {
    expect(kinSearchPlaceholder(defaults)).toBe("Search tasks, clients, docs and money");
    expect(kinSearchPlaceholder(patients)).toBe("Search tasks, patients, docs and money");
    expect(kinSearchPlaceholder(off("clients", "invoices"))).toBe("Search tasks, docs and money");
    expect(kinSearchPlaceholder(off("money"))).toBe("Search tasks, clients and docs");
    expect(kinSearchHint({ all: false, leads: [] }, defaults).detail).toBe(
      "Tasks, clients, contacts, projects, docs and money you can see, by any words in them.",
    );
  });
});

describe("kinShellChanged renames Clients, and back", () => {
  it("sends the name and the singular with every section as held", () => {
    expect(
      kinShellChanged(defaults, { id: "clients", name: " Patients ", noun: "patient" }).shell
        .sections[0],
    ).toEqual({ id: "clients", on: true, name: "Patients", noun: "patient" });
    // Use Kin's name: the labels leave, the switch stays as it was.
    expect(kinShellChanged(patients, { id: "clients", name: "", noun: "" })).toEqual({
      rev: 6,
      shell: { sections: defaults.sections },
    });
  });

  it("asks for the singular with the name, one line and 40 characters at most", () => {
    expect(kinSectionNameProblem("Patients", "patient")).toBeNull();
    expect(kinSectionNameProblem("", "")).toBeNull();
    expect(kinSectionNameProblem("Patients", " ")).toBe(
      "Say what one of them is called too, such as patient.",
    );
    expect(kinSectionNameProblem("P".repeat(41), "patient")).toBe(
      "A name can be at most 40 characters.",
    );
    expect(kinSectionNameProblem("Pati\nents", "patient")).toBe(
      "A name is one line of plain text.",
    );
  });
});

describe("kinSectionOf", () => {
  it("places a built-in list or a record in its section, as the host's tables do", () => {
    expect(
      [
        { list: "projects" },
        { list: "quotes" },
        { list: "expenses" },
        { list: "work" },
        { key: "INV-12" },
        { key: "P-3" },
        { key: "EXP-1" },
        { key: "W-4" },
        { key: "constructor-1" },
      ].map(kinSectionOf),
    ).toEqual(["clients", "invoices", "money", null, "invoices", "clients", "money", null, null]);
  });

  it("keeps a page's lists only while their section is on", () => {
    const lists = ["quotes", "expenses", "leads"];
    expect(lists.filter((list) => kinSectionListed(off("money"), list))).toEqual(["leads"]);
    expect(lists.filter((list) => kinSectionListed(off("invoices"), list))).toEqual([
      "expenses",
      "leads",
    ]);
    expect(lists.filter((list) => kinSectionListed(defaults, list))).toEqual(lists);
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
      "Deals is turned off for this company. You can turn it on in Settings › Deals.",
    );
    expect(kinSectionOffLine(dealsOff, "deals", false)).toBe(
      "Deals is turned off for this company. An owner can turn it on in Settings › Deals.",
    );
  });
});
