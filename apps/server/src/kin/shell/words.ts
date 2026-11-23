import type { KinShell } from "@t3tools/contracts";

import { encoded } from "../lead/quote.ts";
import { sectionName, sectionOn } from "./KinShell.ts";
import type { SectionId } from "./sections.ts";

export const BUILT_IN_SECTIONS = [
  "clients",
  "deals",
  "money",
  "invoices",
  "docs",
] as const satisfies readonly SectionId[];
/** Kin's own title for a section, whatever the company calls it. */
export const kinTitle = (id: SectionId) => sectionName({ rev: 0, sections: [] }, id);

const listed = (names: ReadonlyArray<string>) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** A watched number as the prompt names it. */
export interface NumberShown {
  readonly key: string;
  readonly name: string;
}
const named = (number: NumberShown) => `${encoded(number.name)} (${number.key})`;

/**
 * What an agent is told of a company set up unlike Kin's default: what is off, its own words, and
 * the numbers it watches (given only in a turn whose whole audience is owner level). Nothing for
 * the default sections and no numbers, so that prompt stays as it was.
 */
export const thisCompanyLines = (
  shell: KinShell,
  numbers: {
    readonly watched: ReadonlyArray<NumberShown>;
    readonly kept: ReadonlyArray<NumberShown>;
  } = { watched: [], kept: [] },
): ReadonlyArray<string> => {
  const clients = shell.sections.find((section) => section.id === "clients");
  const called = (id: SectionId) =>
    id === "clients" && clients?.name !== undefined
      ? `${kinTitle(id)} (called ${encoded(clients.name)} here)`
      : kinTitle(id);
  const off = BUILT_IN_SECTIONS.filter((id) => !sectionOn(shell, id)).map(called);
  const words =
    clients === undefined || !sectionOn(shell, "clients")
      ? []
      : clients.name !== undefined
        ? [
            `This company calls its clients ${encoded(clients.name)}${
              clients.noun === undefined ? "" : `, one ${encoded(clients.noun)}`
            }.`,
          ]
        : clients.noun === undefined
          ? []
          : [`This company calls a client a ${encoded(clients.noun)}.`];
  const { watched, kept } = numbers;
  return [
    ...(off.length === 0
      ? []
      : [
          `${listed(off)} ${off.length === 1 ? "is" : "are"} turned off for this company: don't offer, mention or ask about ${off.length === 1 ? "it" : "them"}.`,
        ]),
    ...words,
    ...(watched.length === 0
      ? []
      : [
          watched.length === 1
            ? `This company watches one number: ${named(watched[0]!)}. Read it with numbers_read.`
            : `This company watches these numbers: ${watched.map(named).join(", ")}. Read them with numbers_read.`,
        ]),
    ...(kept.length === 0
      ? []
      : [`You keep ${listed(kept.map(named))}: record each new value with number_record.`]),
  ];
};
