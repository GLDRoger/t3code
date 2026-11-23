import type { KinShell } from "@t3tools/contracts";

import { encoded } from "../lead/quote.ts";
import { cadenceText, limitText, named, namedList } from "../numbers/words.ts";
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

/** A watched number as the prompt names it, with its limits. */
export interface NumberShown {
  readonly key: string;
  readonly name: string;
  readonly unit?: string | undefined;
  readonly above?: string | undefined;
  readonly below?: string | undefined;
}
/** A number this agent keeps, and the feed it fetches it on, if one runs. */
export interface NumberKept {
  readonly key: string;
  readonly name: string;
  readonly feed?:
    | { readonly source: string; readonly every: "day" | "week" | "month"; readonly at: string }
    | undefined;
}
const watchedName = (number: NumberShown) => {
  const limit = limitText(number);
  return limit === undefined ? named(number) : `${encoded(number.name)} (${number.key}, ${limit})`;
};
const keptLines = (kept: ReadonlyArray<NumberKept>) => {
  const feeds = new Map<string, Array<NumberKept>>();
  for (const number of kept) {
    const feed = number.feed === undefined ? "" : JSON.stringify(number.feed);
    feeds.set(feed, [...(feeds.get(feed) ?? []), number]);
  }
  return [...feeds.values()]
    .toSorted((a, b) => Number(a[0]!.feed !== undefined) - Number(b[0]!.feed !== undefined))
    .map((numbers) => {
      const feed = numbers[0]!.feed;
      const record = `You keep ${namedList(numbers)}: record each new value with number_record`;
      return feed === undefined
        ? `${record}.`
        : `${record}; you fetch ${numbers.length === 1 ? "it" : "them"} ${cadenceText(feed.every)} at ${feed.at} from ${encoded(feed.source)}.`;
    });
};

/**
 * What an agent is told of a company set up unlike Kin's default: what is off, its own words, and
 * the numbers it watches (given only in a turn whose whole audience is owner level). Nothing for
 * the default sections and no numbers, so that prompt stays as it was.
 */
export const thisCompanyLines = (
  shell: KinShell,
  numbers: {
    readonly watched: ReadonlyArray<NumberShown>;
    readonly kept: ReadonlyArray<NumberKept>;
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
            ? `This company watches one number: ${watchedName(watched[0]!)}. Read it with numbers_read.`
            : `This company watches these numbers: ${watched.map(watchedName).join(", ")}. Read them with numbers_read.`,
        ]),
    ...keptLines(kept),
  ];
};
