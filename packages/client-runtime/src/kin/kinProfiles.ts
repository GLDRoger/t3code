import {
  KIN_PROFILE_NAME_MAX,
  KIN_PROFILE_SKILLS_MAX,
  KIN_ROLE_TAGS_MAX,
  type KinAgentId,
  type KinLeadProfile,
  type KinPersonProfile,
  type KinWorkHours,
} from "@t3tools/contracts";

export { KIN_PROFILE_NAME_MAX, KIN_PROFILE_SKILLS_MAX };

export const KIN_PROFILE_COPY = {
  title: "Profile",
  mine: "Your profile",
  edit: "Edit profile",
  save: "Save",
  saving: "Saving…",
  failed: "Couldn't save.",
  loadFailed: "Couldn't load this profile.",
  nameLabel: "Name",
  tagsLabel: "Roles",
  tagsHint:
    "Short words for what you do, such as tech, design or sales. Separate them with commas.",
  skillsLabel: "Skills",
  skillsHint: "In your own words. Everyone on the team and their agents can read this.",
  hoursLabel: "Working hours",
  timeZoneLabel: "Time zone",
  noHours: "Not set",
  noSkills: "Nothing yet",
  noTags: "No roles yet",
  pictureAdd: "Add picture",
  pictureChange: "Change picture",
  pictureRemove: "Remove picture",
  pictureFailed: "The picture didn't upload. Try a smaller image.",
} as const;

export const KIN_TEAM_AGENT_COPY = {
  label: "Team agent",
  off: "Off",
  detail: "Everyone on your team can chat with this agent. It sees only what each person may see.",
  suggested: "Suggested",
  failed: "Couldn't change the team agent.",
} as const;

export const KIN_DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

const MAX_TAG_LENGTH = 24;

/** "Tech, iOS / sales" → ["tech", "ios", "sales"]: lowercase slugs, deduplicated, at most six. */
export function kinParseRoleTags(text: string): ReadonlyArray<string> {
  const tags: Array<string> = [];
  for (const raw of text.split(/[,/\n]+/)) {
    const tag = raw
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_TAG_LENGTH)
      .replace(/-+$/, "");
    if (tag !== "" && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, KIN_ROLE_TAGS_MAX);
}

/** "Mon–Fri 10:00–19:00", or the days listed when they don't run on. */
export function kinHoursLine(hours: KinWorkHours | null): string | null {
  if (hours === null || hours.days.length === 0) return null;
  const days = [...new Set(hours.days)].sort((a, b) => a - b);
  const run =
    days.length > 2 &&
    days.every((day, index) => index === 0 || day === (days[index - 1] ?? 0) + 1);
  const named = run
    ? `${KIN_DAY_LABELS[days[0] ?? 0]}–${KIN_DAY_LABELS[days.at(-1) ?? 0]}`
    : days.map((day) => KIN_DAY_LABELS[day]).join(", ");
  return `${named} ${hours.start}–${hours.end}`;
}

/** A Team row's or chat profile's second line: their roles, or nothing. */
export function kinRoleLine(tags: ReadonlyArray<string>): string {
  return tags.join(", ");
}

/** Anyone edits their own profile; the owner edits anyone's. The host checks the same. */
export function kinMayEditProfile(input: {
  readonly viewerPersonId: string | null;
  readonly ownerPersonId: string | null;
  readonly personId: string;
  /** The host's word on it (`KinPersonProfile.canEdit`); older hosts don't send it. */
  readonly canEdit?: boolean | undefined;
}): boolean {
  if (input.canEdit !== undefined) return input.canEdit;
  return (
    input.viewerPersonId !== null &&
    (input.viewerPersonId === input.personId || input.viewerPersonId === input.ownerPersonId)
  );
}

export interface KinProfileDraft {
  readonly displayName: string;
  readonly tags: string;
  readonly skills: string;
  readonly days: ReadonlyArray<number>;
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
}

const deviceTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
};

export function kinProfileDraft(profile: KinPersonProfile): KinProfileDraft {
  return {
    displayName: profile.displayName,
    tags: profile.roleTags.join(", "),
    skills: profile.skills,
    days: profile.workHours?.days ?? [1, 2, 3, 4, 5],
    start: profile.workHours?.start ?? "09:00",
    end: profile.workHours?.end ?? "18:00",
    timeZone: profile.timeZone ?? deviceTimeZone(),
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * What changed, for `kin.people.updateProfile`, or a problem to show. Hours are saved only once
 * days are picked; no days clears them.
 */
export function kinProfileChanges(
  profile: KinPersonProfile,
  draft: KinProfileDraft,
):
  | {
      readonly ok: true;
      readonly changes: {
        displayName?: string;
        roleTags?: ReadonlyArray<string>;
        skills?: string;
        timeZone?: string | null;
        workHours?: KinWorkHours | null;
      };
    }
  | { readonly ok: false; readonly problem: string } {
  const displayName = draft.displayName.trim();
  if (displayName === "") return { ok: false, problem: "Add a name." };
  if (displayName.length > KIN_PROFILE_NAME_MAX)
    return { ok: false, problem: `Keep the name under ${KIN_PROFILE_NAME_MAX} characters.` };
  const skills = draft.skills.trim();
  if (skills.length > KIN_PROFILE_SKILLS_MAX)
    return { ok: false, problem: `Keep skills under ${KIN_PROFILE_SKILLS_MAX} characters.` };
  if (draft.days.length > 0 && (!TIME.test(draft.start) || !TIME.test(draft.end)))
    return { ok: false, problem: "Write times as 24-hour HH:MM, such as 09:30." };
  const roleTags = kinParseRoleTags(draft.tags);
  const workHours: KinWorkHours | null =
    draft.days.length === 0
      ? null
      : {
          days: [...new Set(draft.days)].sort((a, b) => a - b),
          start: draft.start,
          end: draft.end,
        };
  const timeZone = draft.timeZone.trim() === "" ? null : draft.timeZone.trim();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return {
    ok: true,
    changes: {
      ...(displayName === profile.displayName ? {} : { displayName }),
      ...(same(roleTags, profile.roleTags) ? {} : { roleTags }),
      ...(skills === profile.skills ? {} : { skills }),
      ...(timeZone === profile.timeZone ? {} : { timeZone }),
      ...(same(workHours, profile.workHours) ? {} : { workHours }),
    },
  };
}

export interface KinTeamAgentChoice {
  readonly agentId: KinAgentId | null;
  readonly label: string;
  readonly suggested: boolean;
}

/** Off, then the owner's live agents, the Chief of staff marked as the suggestion. */
export function kinTeamAgentChoices(
  leads: ReadonlyArray<KinLeadProfile>,
): ReadonlyArray<KinTeamAgentChoice> {
  const live = leads.filter((lead) => lead.retired === undefined);
  const chief = live.find((lead) => lead.domain === "chief-of-staff") ?? null;
  return [
    { agentId: null, label: KIN_TEAM_AGENT_COPY.off, suggested: false },
    ...live.map((lead) => ({
      agentId: lead.agentId,
      label: lead.name,
      suggested: lead.agentId === chief?.agentId,
    })),
  ];
}

export const KIN_COMPANY_CHAT_COPY = {
  label: "Company chat",
  detail:
    "One chat with everyone on the team and your agents. The one you pick answers when nobody is named.",
  failed: "Couldn't change the company chat.",
} as const;

/** "Chief of staff", or "Off" when there is none or it was retired. */
export function kinTeamAgentLabel(
  leads: ReadonlyArray<KinLeadProfile>,
  teamAgentId: string | null | undefined,
): string {
  return (
    leads.find((lead) => lead.agentId === teamAgentId && lead.retired === undefined)?.name ??
    KIN_TEAM_AGENT_COPY.off
  );
}

/** The seed an avatar of this person carries, wherever it shows. */
export const kinPersonSeed = (personId: string) => `person:${personId}`;

/** The pictures people chose, by avatar seed, for every avatar slot to read. */
export function createKinPictures() {
  let bySeed: ReadonlyMap<string, string> = new Map();
  const listeners = new Set<() => void>();
  return {
    /** Replaces them all; a no-op when nothing changed, so readers don't repaint. */
    set: (next: ReadonlyMap<string, string>) => {
      if (next.size === bySeed.size && [...next].every(([seed, url]) => bySeed.get(seed) === url))
        return;
      bySeed = next;
      for (const listener of listeners) listener();
    },
    get: (seed: string) => bySeed.get(seed),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
