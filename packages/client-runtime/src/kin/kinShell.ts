import type { KinShell } from "@t3tools/contracts";

/** The company's built-in sections, in the host's fixed order. */
export type KinSectionId = "clients" | "deals" | "money" | "invoices" | "docs";

/**
 * Whether a section is on, from `kin.access.me`'s `shell`: the one rule every screen asks. A host
 * older than the shell (none sent), one not answered yet, and a section it doesn't name are all on.
 */
export function kinSectionOn(shell: KinShell | null | undefined, id: KinSectionId): boolean {
  return shell?.sections.find((section) => section.id === id)?.on ?? true;
}

/** What `kin.shell.set` takes to switch one section: every section as held, that one changed. */
export function kinShellSwitched(shell: KinShell, id: KinSectionId, on: boolean) {
  const held = shell.sections.some((section) => section.id === id);
  return {
    rev: shell.rev,
    shell: {
      sections: held
        ? shell.sections.map((section) => (section.id === id ? { ...section, on } : section))
        : [...shell.sections, { id, on }],
    },
  };
}

/** A section's switch, written once for the web and the phone. */
export interface KinSectionSwitchWords {
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

export const KIN_SECTION_SWITCHES: Readonly<Partial<Record<KinSectionId, KinSectionSwitchWords>>> =
  {
    deals: {
      title: "We run deals",
      detail:
        "Turning this off hides Deals for everyone in the company: the Deals tab, deals on client and project pages, deals in search, and Kin's deal nudges.",
      kept: "Nothing is deleted, and you can turn it back on at any time.",
      olderPhones:
        "Teammates on an older version of the phone app keep seeing Deals until they update.",
      inactive: "Deals is off, so these settings aren't used until you turn it back on.",
      off: "Deals is turned off.",
      offOwner: "You can turn it on in Settings › Deals.",
      offMember: "The owner can turn it on in Settings › Deals.",
    },
  };

/** The quiet line on a record of an off section, opened by its link; null while it is on. */
export function kinSectionOffLine(
  shell: KinShell | null | undefined,
  id: KinSectionId,
  ownerLevel: boolean,
): string | null {
  const words = KIN_SECTION_SWITCHES[id];
  if (words === undefined || kinSectionOn(shell, id)) return null;
  return `${words.off} ${ownerLevel ? words.offOwner : words.offMember}`;
}
