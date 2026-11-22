import type { KinShell } from "@t3tools/contracts";

import { encoded } from "../lead/quote.ts";
import type { SectionId } from "./sections.ts";

/** Kin's own words for each built-in section: its title, many of them and one of them. */
const SECTION_WORDS = {
  clients: { title: "Clients", many: "clients", one: "client" },
  deals: { title: "Deals", many: "deals", one: "deal" },
  money: { title: "Money", many: "money", one: "money" },
  invoices: { title: "Invoices and quotes", many: "invoices and quotes", one: "invoice" },
  docs: { title: "Docs", many: "docs", one: "doc" },
} satisfies Record<SectionId, { title: string; many: string; one: string }>;
const WORDS = new Map(Object.entries(SECTION_WORDS));
export const wordsOf = (id: string) => WORDS.get(id);

const listed = (names: ReadonlyArray<string>) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * What an agent is told of a company set up unlike Kin's default: what is off, and its own words
 * for what is on. Nothing for the default shell, so its prompt stays as it was.
 */
export const thisCompanyLines = (shell: KinShell): ReadonlyArray<string> => {
  const known = shell.sections.flatMap((section) => {
    const words = wordsOf(section.id);
    return words === undefined ? [] : [{ section, words }];
  });
  const off = known
    .filter(({ section }) => !section.on)
    .map(({ section, words }) => section.name ?? words.title);
  const named = known.flatMap(({ section, words }) => {
    if (!section.on) return [];
    if (section.name !== undefined)
      return [
        `This company calls its ${words.many} ${encoded(section.name)}${
          section.noun === undefined ? "" : `, one ${encoded(section.noun)}`
        }.`,
      ];
    return section.noun === undefined
      ? []
      : [`This company calls a ${words.one} a ${encoded(section.noun)}.`];
  });
  return [
    ...(off.length === 0
      ? []
      : [
          `${listed(off)} ${off.length === 1 ? "is" : "are"} turned off for this company: don't offer, mention or ask about ${off.length === 1 ? "it" : "them"}.`,
        ]),
    ...named,
  ];
};
