import type { KinShell } from "@t3tools/contracts";

/** The company's built-in sections, in the host's fixed order. */
export type KinSectionId = "clients" | "deals" | "money" | "invoices" | "docs";

/** The sections a person may switch, in the order Settings › Sections lists them. */
export const KIN_SWITCHABLE_SECTIONS = ["clients", "deals", "money", "invoices"] as const;
export type KinSwitchableSection = (typeof KIN_SWITCHABLE_SECTIONS)[number];

/** What each section needs on to be on, as the host's `sectionOn` decides it. */
const NEEDS: Readonly<Record<KinSectionId, ReadonlyArray<KinSectionId>>> = {
  clients: [],
  deals: ["clients"],
  money: [],
  invoices: ["money"],
  docs: [],
};

const KIN_NAMES: Readonly<Record<KinSectionId, string>> = {
  clients: "Clients",
  deals: "Deals",
  money: "Money",
  invoices: "Invoices and quotes",
  docs: "Docs",
};

const held = (shell: KinShell | null | undefined, id: KinSectionId) =>
  shell?.sections.find((section) => section.id === id);

/** The section's own switch as stored, whatever the sections it needs say. */
export function kinSectionSwitchOn(shell: KinShell | null | undefined, id: KinSectionId): boolean {
  return held(shell, id)?.on ?? true;
}

/**
 * Whether a section is on, from `kin.access.me`'s `shell`: the one rule every screen asks. A host
 * older than the shell (none sent), one not answered yet, and a section it doesn't name are all on.
 * Deals needs Clients, and Invoices and quotes needs Money, as the host decides.
 */
export function kinSectionOn(shell: KinShell | null | undefined, id: KinSectionId): boolean {
  return (
    kinSectionSwitchOn(shell, id) && NEEDS[id].every((need) => kinSectionSwitchOn(shell, need))
  );
}

/** The sections that keep this one off though its own switch is on; empty when none do. */
function kinSectionHeldOffBy(
  shell: KinShell | null | undefined,
  id: KinSectionId,
): ReadonlyArray<KinSectionId> {
  return NEEDS[id].filter((need) => !kinSectionSwitchOn(shell, need));
}

/** The section's name as this company says it: "Patients" for a renamed Clients. */
export function kinSectionName(shell: KinShell | null | undefined, id: KinSectionId): string {
  return (id === "clients" ? held(shell, id)?.name : undefined) ?? KIN_NAMES[id];
}

/** One of the section's records in a sentence: "client", or "patient" once renamed. */
export function kinSectionNoun(shell: KinShell | null | undefined, id: "clients"): string {
  const section = held(shell, id);
  return section?.noun ?? (section?.name === undefined ? "client" : lowerFirst(section.name));
}

/** Whether the company calls Clients something of its own. */
export const kinSectionRenamed = (shell: KinShell | null | undefined): boolean =>
  held(shell, "clients")?.name !== undefined;

const upperFirst = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);
// An acronym ("NGOs") keeps its capitals inside a sentence.
const lowerFirst = (word: string) =>
  /^\p{Lu}\p{Lu}/u.test(word) ? word : word.charAt(0).toLowerCase() + word.slice(1);

/**
 * Kin's own words about the Clients section, said with this company's name for it: "Search
 * clients" reads "Search patients". Only for text that names the section, never a person's or an
 * agent's words, and never "client" in another sense (an email client).
 */
export function kinSectionNamed(shell: KinShell | null | undefined, text: string): string {
  if (!kinSectionRenamed(shell)) return text;
  const plural = kinSectionName(shell, "clients");
  const one = kinSectionNoun(shell, "clients");
  return text.replace(/\b(Clients|clients|Client|client)\b/g, (word) =>
    word === "Clients"
      ? upperFirst(plural)
      : word === "clients"
        ? lowerFirst(plural)
        : word === "Client"
          ? upperFirst(one)
          : one,
  );
}

const renamedWords = new WeakMap<object, Map<string, unknown>>();

const namedDeep = (shell: KinShell, value: unknown): unknown => {
  if (typeof value === "string") return kinSectionNamed(shell, value);
  if (typeof value === "function")
    return (...args: ReadonlyArray<unknown>) => namedDeep(shell, value(...args));
  if (Array.isArray(value)) return value.map((one) => namedDeep(shell, one));
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(
      Object.entries(value).map(([key, one]) => [key, namedDeep(shell, one)]),
    );
  return value;
};

/**
 * One of Kin's copy objects about Clients with every word said in this company's name for it, as
 * `kinSectionNamed` says each. The same object while Clients keeps Kin's name; built once per name.
 */
export function kinSectionNamedWords<Words extends object>(
  shell: KinShell | null | undefined,
  words: Words,
): Words {
  if (shell == null || !kinSectionRenamed(shell)) return words;
  const name = `${kinSectionName(shell, "clients")}/${kinSectionNoun(shell, "clients")}`;
  const byName = renamedWords.get(words) ?? new Map<string, unknown>();
  renamedWords.set(words, byName);
  const held = byName.get(name) ?? namedDeep(shell, words);
  byName.set(name, held);
  // namedDeep keeps the shape: each string stays a string, each function returns what it did.
  return held as Words;
}

/**
 * A client or project picker's own words, with a client picker's said in this company's name for
 * Clients: its label, what picking nothing says, and its extra row ("No client"). Records' names
 * and everything else pass through untouched.
 */
export function kinPickerNamed<
  Picker extends {
    readonly noun: "client" | "project";
    readonly label: string;
    readonly placeholder?: string;
    readonly none?: string;
    readonly extra?: { readonly key: string; readonly title: string };
  },
>(shell: KinShell | null | undefined, picker: Picker): Picker {
  if (picker.noun !== "client" || !kinSectionRenamed(shell)) return picker;
  const named = (text: string) => kinSectionNamed(shell, text);
  return {
    ...picker,
    label: named(picker.label),
    ...(picker.placeholder === undefined ? {} : { placeholder: named(picker.placeholder) }),
    ...(picker.none === undefined ? {} : { none: named(picker.none) }),
    ...(picker.extra === undefined
      ? {}
      : { extra: { ...picker.extra, title: named(picker.extra.title) } }),
  };
}

const LIST_SECTIONS = new Map<string, KinSectionId>([
  ["clients", "clients"],
  ["contacts", "clients"],
  ["projects", "clients"],
  ["milestones", "clients"],
  ["deals", "deals"],
  ["expenses", "money"],
  ["receipts", "money"],
  ["dates", "money"],
  ["bank_transactions", "money"],
  ["subscriptions", "money"],
  ["invoices", "invoices"],
  ["quotes", "invoices"],
]);

const KEY_SECTIONS = new Map<string, KinSectionId>([
  ["C", "clients"],
  ["CT", "clients"],
  ["P", "clients"],
  ["M", "clients"],
  ["DL", "deals"],
  ["EXP", "money"],
  ["RCT", "money"],
  ["DT", "money"],
  ["BNK", "money"],
  ["BTX", "money"],
  ["BANK", "money"],
  ["BKTX", "money"],
  ["BK9", "money"],
  ["INV", "invoices"],
  ["QT", "invoices"],
]);

/**
 * The section a built-in list or a record belongs to, as the host's section tables say; null for
 * one that belongs to none (tasks, goals, docs, a list an agent set up).
 */
export function kinSectionOf(of: { readonly list: string } | { readonly key: string }) {
  const id =
    "list" in of
      ? LIST_SECTIONS.get(of.list)
      : KEY_SECTIONS.get(/^([A-Z][A-Z0-9]{0,7})-\d+$/.exec(of.key.trim().toUpperCase())?.[1] ?? "");
  return id ?? null;
}

/** Whether a list shows while its section is off: a list that belongs to none always does. */
export function kinSectionListed(shell: KinShell | null | undefined, list: string) {
  const id = kinSectionOf({ list });
  return id === null || kinSectionOn(shell, id);
}

/**
 * A change to one section from Settings: its switch, or its name (blank for Kin's own); for a
 * list section also its place in the phone's dock, or leaving the sidebar. A list section not
 * held yet is added by switching it on.
 */
export type KinSectionChange =
  | { readonly id: KinSectionId | KinListSectionId; readonly on: boolean }
  | { readonly id: "clients"; readonly name: string; readonly noun: string }
  | { readonly id: KinListSectionId; readonly dock: boolean }
  | { readonly id: KinListSectionId; readonly remove: true };

/** What `kin.shell.set` takes for one change: every section as held, that one changed. */
export function kinShellChanged(shell: KinShell, change: KinSectionChange) {
  const changed = (section: KinShell["sections"][number]) => {
    if ("on" in change) return { ...section, on: change.on };
    if ("dock" in change) {
      const { dock: _dock, ...rest } = section;
      return change.dock ? { ...rest, dock: true } : rest;
    }
    if ("remove" in change) return section;
    const { name: _name, noun: _noun, ...rest } = section;
    const name = change.name.trim();
    return name === "" ? rest : { ...rest, name, noun: change.noun.trim() };
  };
  const named = shell.sections.some((section) => section.id === change.id);
  return {
    rev: shell.rev,
    shell: {
      sections:
        "remove" in change
          ? shell.sections.filter((section) => section.id !== change.id)
          : named
            ? shell.sections.map((section) =>
                section.id === change.id ? changed(section) : section,
              )
            : [...shell.sections, changed({ id: change.id, on: true })],
    },
  };
}

// A company's own lists as sections: `list:<list id>` in the shell, after Kin's own.

/** A list section's id in the shell. */
export type KinListSectionId = `list:${string}`;

const LIST_SECTION = /^list:([a-z][a-z0-9_]{1,39})$/;

export const kinListSectionId = (list: string): KinListSectionId => `list:${list}`;

/** The list a section shows, or null for one of Kin's own sections (or an id this build can't read). */
export function kinListOfSection(id: string): string | null {
  return LIST_SECTION.exec(id)?.[1] ?? null;
}

export const kinIsListSection = (id: string): id is KinListSectionId =>
  kinListOfSection(id) !== null;

export interface KinListSection {
  readonly id: KinListSectionId;
  readonly list: string;
  readonly on: boolean;
  /** In the phone's dock, when there is room for it. */
  readonly dock: boolean;
}

/**
 * The list sections in the shell's order, as the host filtered them for this viewer: only lists
 * they reach, never an archived one's. None from a host older than list sections.
 */
export function kinListSections(shell: KinShell | null | undefined): ReadonlyArray<KinListSection> {
  const seen = new Set<string>();
  return (shell?.sections ?? []).flatMap((section) => {
    const list = kinListOfSection(section.id);
    if (list === null || seen.has(list)) return [];
    seen.add(list);
    return [{ id: kinListSectionId(list), list, on: section.on, dock: section.dock === true }];
  });
}

/** The places the phone's dock holds, Chats included. */
const KIN_DOCK_PLACES = 5;

/**
 * The phone's dock: this person's own places, then each list section that is on and marked for the
 * dock, in the shell's order, while places are left. Never more than five; a list section left out
 * is reached in Lists.
 */
export function kinDockWithLists<Tab extends string>(
  tabs: ReadonlyArray<Tab>,
  shell: KinShell | null | undefined,
): ReadonlyArray<Tab | KinListSectionId> {
  const room = Math.max(0, KIN_DOCK_PLACES - tabs.length);
  const docked = kinListSections(shell)
    .filter((section) => section.on && section.dock)
    .slice(0, room)
    .map((section) => section.id);
  return [...tabs, ...docked];
}

/**
 * Room for list sections in the company's dock, as Settings offers it: Chats, Tasks and Docs always
 * have a place, Money and Clients while they are on, and a list section takes one they leave.
 */
export function kinDockRoom(shell: KinShell | null | undefined): {
  readonly room: number;
  readonly used: number;
  readonly full: boolean;
} {
  const kins = 3 + Number(kinSectionOn(shell, "money")) + Number(kinSectionOn(shell, "clients"));
  const room = Math.max(0, KIN_DOCK_PLACES - kins);
  const used = kinListSections(shell).filter((section) => section.on && section.dock).length;
  return { room, used, full: used >= room };
}

/**
 * Whether a list section has its place in the phone's dock now: on, marked for it, and among the
 * ones the dock has room for. One marked but left out reads as not in the dock.
 */
export function kinListSectionDocked(
  shell: KinShell | null | undefined,
  id: KinListSectionId,
): boolean {
  const { room } = kinDockRoom(shell);
  return kinListSections(shell)
    .filter((section) => section.on && section.dock)
    .slice(0, room)
    .some((section) => section.id === id);
}

/**
 * Whether a list can be shown as a section, as the host decides it: a company's own list that is
 * live, not one of Kin's own (they have their place already) and not paid over time.
 */
export function kinListCanBeSection(def: {
  readonly list: string;
  readonly name: string;
  readonly builtIn: boolean;
  readonly archivedAt: string | null;
  readonly payments?: true | undefined;
}): boolean {
  return (
    !def.builtIn &&
    def.archivedAt === null &&
    def.payments !== true &&
    kinSectionOf({ list: def.list }) === null &&
    !KINS_OWN_LISTS.has(def.list) &&
    def.name.trim().toLowerCase() !== "bank transactions"
  );
}

const KINS_OWN_LISTS = new Set(["work", "goals", "docs", "dates", "subscriptions", "payments"]);

/** Settings › Sections' part for a company's own lists, written once for the web and the phone. */
export const KIN_LIST_SECTIONS = {
  title: "Your lists as sections",
  detail:
    "A list shown as a section has a place of its own in the sidebar, for everyone who can see the list.",
  dock: "In the phone's dock",
  dockFull: "The dock holds five places. Turn one off first.",
  remove: "Remove from sidebar",
  removeDetail: "The list itself stays under Lists.",
  add: "Show a list as a section",
  addPick: "Choose a list",
  addSave: "Show",
} as const;

/** What `kin.shell.set` takes to switch one section: every section as held, that one changed. */
export const kinShellSwitched = (shell: KinShell, id: KinSectionId, on: boolean) =>
  kinShellChanged(shell, { id, on });

/** A section's switch, written once for the web and the phone. */
export interface KinSectionSwitchWords {
  /** The switch's own title where it sits alone on the section's page. */
  readonly title: string;
  /** What turning it off does, in one sentence. */
  readonly detail: string;
  readonly kept: string;
  /** Said only where an installed phone app is older than the switch and keeps the place. */
  readonly olderPhones: string;
  /** Above the section's other settings while it is off. */
  readonly inactive: string;
  /** On a record of the section opened by its link while it is off. */
  readonly off: string;
  readonly offOwner: string;
  readonly offMember: string;
}

const KEPT = "Nothing is deleted, and you can turn it back on at any time.";
const IN_SECTIONS = "Settings › Sections";

const sectionWords = (
  id: Exclude<KinSwitchableSection, "deals">,
  detail: string,
): KinSectionSwitchWords => ({
  title: KIN_NAMES[id],
  detail,
  kept: KEPT,
  olderPhones: `Teammates on an older version of the phone app keep seeing ${KIN_NAMES[id]} until they update.`,
  inactive: `${KIN_NAMES[id]} is off, so these settings aren't used until you turn it back on.`,
  off: `${KIN_NAMES[id]} is turned off for this company.`,
  offOwner: `You can turn it on in ${IN_SECTIONS}.`,
  offMember: `An owner can turn it on in ${IN_SECTIONS}.`,
});

export const KIN_SECTION_SWITCHES: Readonly<Record<KinSwitchableSection, KinSectionSwitchWords>> = {
  clients: sectionWords(
    "clients",
    "Turning this off hides Clients and Projects for everyone in the company: their places, the client and project pickers, and Kin's client and project nudges. Deals go with them.",
  ),
  deals: {
    title: "We run deals",
    detail:
      "Turning this off hides Deals for everyone in the company: the Deals tab, deals on client and project pages, deals in search, and Kin's deal nudges.",
    kept: KEPT,
    olderPhones:
      "Teammates on an older version of the phone app keep seeing Deals until they update.",
    inactive: "Deals is off, so these settings aren't used until you turn it back on.",
    off: "Deals is turned off for this company.",
    offOwner: "You can turn it on in Settings › Deals.",
    offMember: "An owner can turn it on in Settings › Deals.",
  },
  money: sectionWords(
    "money",
    "Turning this off hides Money for everyone in the company: its place, money on client and project pages, and Kin's money nudges and morning money lines. Bank alerts are still recorded, without notices. Invoices and quotes go with it.",
  ),
  invoices: sectionWords(
    "invoices",
    "Turning this off hides invoices and quotes for everyone in the company: making them, their lists in Money, invoices on client pages, and Kin's overdue-invoice nudges.",
  ),
};

/** Settings › Sections, written once for the web and the phone. */
export const KIN_SECTIONS_PAGE = {
  title: "Sections",
  intro:
    "The parts of Kin your company uses. A section you turn off leaves everyone's sidebar, phone, search and forms; nothing is deleted, and you can turn it back on at any time. Chats, Tasks and Docs are always on.",
  olderPhones:
    "Teammates on an older version of the phone app keep seeing a section that is off, with its client and project pickers, until they update.",
  olderHost: "This computer's Kin is older than sections. Update it to choose them.",
  onlyOwner: {
    title: "Sections aren't open to you",
    detail: "The owner or a co-owner chooses the sections this company uses.",
  },
  rename: {
    title: "Call it…",
    detail:
      "What your company calls the people Kin lists under Clients, such as Patients or Donors. Kin uses it on every screen.",
    name: "Name",
    namePlaceholder: "Patients",
    noun: "One of them",
    nounPlaceholder: "patient",
    save: "Save name",
    backToKins: "Use Kin's name",
    needsNoun: "Say what one of them is called too, such as patient.",
    tooLong: "A name can be at most 40 characters.",
    oneLine: "A name is one line of plain text.",
  },
} as const;

/** Why a section reads as off though its own switch is on; null when nothing holds it off. */
export function kinSectionHeldOffLine(
  shell: KinShell | null | undefined,
  id: KinSectionId,
): string | null {
  const by = kinSectionHeldOffBy(shell, id).map((one) => kinSectionName(shell, one));
  if (by.length === 0 || !kinSectionSwitchOn(shell, id)) return null;
  return by.length === 1
    ? `Off because ${by[0]} is off.`
    : `Off because ${by.slice(0, -1).join(", ")} and ${by.at(-1)} are off.`;
}

/** The problem with a name for Clients before it is sent; null when it can go. */
export function kinSectionNameProblem(name: string, noun: string): string | null {
  const plural = name.trim();
  const one = noun.trim();
  if (/\p{Cc}/u.test(name + noun)) return KIN_SECTIONS_PAGE.rename.oneLine;
  if (plural.length > 40 || one.length > 40) return KIN_SECTIONS_PAGE.rename.tooLong;
  if (plural !== "" && one === "") return KIN_SECTIONS_PAGE.rename.needsNoun;
  return null;
}

/**
 * What an off section's place or record says, opened by its link: that it is off, and where to
 * turn it on (an owner) or who can (anyone else). Null while it is on.
 */
export function kinSectionOffNotice(
  shell: KinShell | null | undefined,
  id: KinSectionId,
  ownerLevel: boolean,
): { readonly title: string; readonly detail: string } | null {
  if (id === "docs" || kinSectionOn(shell, id)) return null;
  // A section held off by another is turned on where that one is.
  const by = kinSectionSwitchOn(shell, id) ? (kinSectionHeldOffBy(shell, id)[0] ?? id) : id;
  const words = KIN_SECTION_SWITCHES[by === "docs" ? id : by];
  return {
    title: kinSectionNamed(shell, words.off),
    detail: ownerLevel ? words.offOwner : words.offMember,
  };
}

/** The quiet line on a record of an off section, opened by its link; null while it is on. */
export function kinSectionOffLine(
  shell: KinShell | null | undefined,
  id: KinSectionId,
  ownerLevel: boolean,
): string | null {
  const notice = kinSectionOffNotice(shell, id, ownerLevel);
  return notice === null ? null : `${notice.title} ${notice.detail}`;
}
