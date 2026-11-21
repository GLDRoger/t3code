import {
  KIN_PROFILE_NAME_MAX,
  KIN_PROFILE_SKILLS_MAX,
  KIN_PROFILE_TALK_MAX,
  KIN_ROLE_TAGS_MAX,
  KinGithubLogin,
  type KinAgentId,
  type KinLeadProfile,
  type KinPersonProfile,
  type KinPersonQuietHours,
  type KinWorkHours,
} from "@t3tools/contracts";

import * as Schema from "effect/Schema";

import { kinFailure } from "./kinAnswers.ts";
import { kinZoneName } from "./kinTimeZone.ts";

export { KIN_PROFILE_NAME_MAX, KIN_PROFILE_SKILLS_MAX, KIN_PROFILE_TALK_MAX };

export const KIN_PROFILE_COPY = {
  runsWorkspace: "Runs this workspace",
  skillsExample: "SwiftUI, App Store releases",
  title: "Profile",
  mine: "Your profile",
  edit: "Edit profile",
  /** Settings → Profile's one sentence. */
  purpose: "How your teammates and agents see you, and when Kin can reach you.",
  editOf: (what: string) => `Edit ${what.toLowerCase()}`,
  saveProfile: "Save profile",
  pictureLabel: "Picture",
  save: "Save",
  saveUsername: "Save username",
  saving: "Saving…",
  failed: "Couldn't save.",
  loadFailed: "Couldn't load this profile.",
  nameLabel: "Name",
  tagsLabel: "Roles",
  tagsHint: "Short words such as tech, design or sales. Separate them with commas.",
  skillsLabel: "Skills",
  skillsHint: "Everyone on the team and their agents can read this.",
  talkLabel: "How to talk to me",
  talkHint: "Agents read this before they write to you. Only you can change it.",
  noTalk: "Not said yet",
  hoursLabel: "Working hours",
  timeZoneLabel: "Time zone",
  quietLabel: "Quiet hours",
  quietHint:
    "Nothing that can wait reaches you then, on your own clock. Something urgent, with its reason, still does.",
  holdLabel: "Hold non-urgent messages outside my working hours",
  holdHint:
    "Agents' notes, passed-on messages and task hand-overs wait for your next working hours, in order. Replies to what you just wrote and messages from people arrive as usual.",
  holding: "Holds non-urgent messages outside working hours",
  noHours: "Not set",
  noSkills: "Nothing yet",
  noTags: "No roles yet",
  /** Web's profile rows: one word for every empty value. */
  rowEmpty: "Not set",
  pictureAdd: "Add picture",
  pictureChange: "Change picture",
  pictureRemove: "Remove picture",
  pictureFailed: "The picture didn't upload. Try a smaller image.",
} as const;

export const KIN_GITHUB_LOGIN = {
  label: "GitHub username",
  none: "Not set",
  mineHint: "Kin uses it to find your pull requests when you ask an agent to review them.",
  theirHint: "Kin uses it to find their pull requests when they ask an agent to review them.",
  set: "Add GitHub username…",
  change: "Change",
  remove: "Remove",
  removeTitle: "Remove the GitHub username?",
  removeDetail: (mine: boolean) =>
    mine
      ? "Kin stops finding your pull requests until you add it again."
      : "Kin stops finding their pull requests until it's added again.",
  save: "Save",
  saveUsername: "Save username",
  saving: "Saving…",
  invalid:
    "That isn't a GitHub username. It is 1 to 39 letters, digits and single hyphens, and doesn't start or end with a hyphen.",
  taken: "That GitHub username is already on file for someone else.",
  failed: "Couldn't save the GitHub username.",
} as const;

const isGithubLogin = Schema.is(KinGithubLogin);

/** What was typed, as the host takes it: a username, or null to clear it. A leading @ is dropped. */
export function kinGithubLoginInput(
  text: string,
):
  | { readonly ok: true; readonly login: string | null }
  | { readonly ok: false; readonly problem: string } {
  const typed = text.trim();
  if (typed === "") return { ok: true, login: null };
  const login = typed.replace(/^@/, "");
  return isGithubLogin(login)
    ? { ok: true, login }
    : { ok: false, problem: KIN_GITHUB_LOGIN.invalid };
}

/** Where the row shows, the host refuses a username only when someone else has it, never saying whose. */
export const kinGithubLoginFailure = (cause: unknown) =>
  kinFailure(cause, KIN_GITHUB_LOGIN.failed, { refused: KIN_GITHUB_LOGIN.taken }).text;

export const KIN_TEAM_AGENT_COPY = {
  label: "Team agent",
  off: "Off",
  detail: "Everyone on your team can chat with this agent. It sees only what each person may see.",
  detailRestricted:
    "Everyone on your team can chat with this agent, except the people restricted from it under Who can message. It sees only what each person may see.",
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

/** A profile lists the person's open tasks, unless it is yours or opened over a screen that does. */
export const kinProfileShowsTasks = (input: {
  readonly mine: boolean;
  readonly overTheirTasks: boolean;
}): boolean => !input.mine && !input.overTheirTasks;

export interface KinProfileDraft {
  readonly displayName: string;
  readonly tags: string;
  readonly skills: string;
  readonly talkStyle: string;
  readonly days: ReadonlyArray<number>;
  readonly start: string;
  readonly end: string;
  readonly timeZone: string;
  readonly quietFrom: string;
  readonly quietTo: string;
  readonly holdOutside: boolean;
}

/**
 * What a profile's holding fields mean when the person set none: the company's quiet hours
 * (`KinPeopleProfilesResult.quietHours`), and the switch on for everyone but the owner.
 */
export interface KinProfileHolding {
  readonly companyQuiet?: KinPersonQuietHours | undefined;
  readonly isOwner: boolean;
}

const KIN_QUIET_DEFAULT: KinPersonQuietHours = { from: "22:00", to: "07:00" };

/** Their quiet hours and whether they hold messages outside their working hours, as they stand. */
function kinProfileHolding(profile: KinPersonProfile, holding: KinProfileHolding) {
  return {
    quiet: profile.quietHours ?? holding.companyQuiet ?? KIN_QUIET_DEFAULT,
    holdOutside: profile.holdOutsideHours ?? !holding.isOwner,
  };
}

/** "22:00–07:00 · Holds non-urgent messages outside working hours". */
export function kinQuietLine(profile: KinPersonProfile, holding: KinProfileHolding): string {
  const held = kinProfileHolding(profile, holding);
  return [
    `${held.quiet.from}–${held.quiet.to}`,
    held.holdOutside && profile.workHours !== null ? KIN_PROFILE_COPY.holding : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** Where the platform can't list its zones (Hermes), the ones most teams are in. */
const COMMON_TIME_ZONES = [
  "Asia/Kolkata",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Dhaka",
  "Asia/Kathmandu",
  "Asia/Colombo",
  "Asia/Singapore",
  "Asia/Jakarta",
  "Asia/Manila",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Seoul",
  "Asia/Tokyo",
  "Australia/Perth",
  "Australia/Sydney",
  "Australia/Melbourne",
  "Pacific/Auckland",
  "Europe/London",
  "Europe/Dublin",
  "Europe/Lisbon",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Amsterdam",
  "Europe/Madrid",
  "Europe/Rome",
  "Europe/Stockholm",
  "Europe/Warsaw",
  "Europe/Athens",
  "Europe/Istanbul",
  "Europe/Moscow",
  "Africa/Cairo",
  "Africa/Lagos",
  "Africa/Nairobi",
  "Africa/Johannesburg",
  "America/Sao_Paulo",
  "America/Buenos_Aires",
  "America/Santiago",
  "America/Bogota",
  "America/Lima",
  "America/Mexico_City",
  "America/New_York",
  "America/Toronto",
  "America/Chicago",
  "America/Denver",
  "America/Phoenix",
  "America/Los_Angeles",
  "America/Vancouver",
  "America/Anchorage",
  "Pacific/Honolulu",
  "UTC",
];

const platformTimeZones = (): ReadonlyArray<string> => {
  try {
    const listed = Intl.supportedValuesOf("timeZone");
    return listed.length > 0 ? listed : COMMON_TIME_ZONES;
  } catch {
    return COMMON_TIME_ZONES;
  }
};

const KIN_TIME_ZONES_SHOWN = 40;

/**
 * Time zones to pick from, matching `query` ("new york" finds America/New_York): this device's
 * first, then the one held, then the rest. The held one is kept even if the list lacks it.
 */
export function kinTimeZoneChoices(held: string, query: string): ReadonlyArray<string> {
  const words = query
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/g, " ");
  const all = [
    ...new Set([deviceTimeZone(), held, ...platformTimeZones()].map(kinZoneName)),
  ].filter((zone) => zone.trim() !== "");
  return all
    .filter((zone) => words === "" || zone.toLowerCase().replace(/[_/]+/g, " ").includes(words))
    .slice(0, KIN_TIME_ZONES_SHOWN);
}

const deviceTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
};

export function kinProfileDraft(
  profile: KinPersonProfile,
  holding: KinProfileHolding = { isOwner: false },
): KinProfileDraft {
  const held = kinProfileHolding(profile, holding);
  return {
    quietFrom: held.quiet.from,
    quietTo: held.quiet.to,
    holdOutside: held.holdOutside,
    displayName: profile.displayName,
    tags: profile.roleTags.join(", "),
    skills: profile.skills,
    talkStyle: profile.talkStyle ?? "",
    days: profile.workHours?.days ?? [],
    start: profile.workHours?.start ?? "09:00",
    end: profile.workHours?.end ?? "18:00",
    timeZone: profile.timeZone ?? "",
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
  /** Only the person sets when Kin holds messages for them; others' saves leave it alone. */
  holding?: KinProfileHolding & { readonly mine: boolean },
):
  | {
      readonly ok: true;
      readonly changes: {
        displayName?: string;
        roleTags?: ReadonlyArray<string>;
        skills?: string;
        talkStyle?: string;
        timeZone?: string | null;
        workHours?: KinWorkHours | null;
        quietHours?: KinPersonQuietHours;
        holdOutsideHours?: boolean;
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
  const talkStyle = draft.talkStyle.trim();
  if (talkStyle.length > KIN_PROFILE_TALK_MAX)
    return { ok: false, problem: `Keep this under ${KIN_PROFILE_TALK_MAX} characters.` };
  if (draft.days.length > 0 && (!TIME.test(draft.start) || !TIME.test(draft.end)))
    return { ok: false, problem: "Write times as 24-hour HH:MM, such as 09:30." };
  const mine = holding?.mine === true;
  if (mine && (!TIME.test(draft.quietFrom) || !TIME.test(draft.quietTo)))
    return { ok: false, problem: "Write quiet hours as 24-hour HH:MM, such as 22:00." };
  const held = holding === undefined ? undefined : kinProfileHolding(profile, holding);
  const quietHours = { from: draft.quietFrom, to: draft.quietTo };
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
      ...(talkStyle === (profile.talkStyle ?? "") ? {} : { talkStyle }),
      ...(timeZone === profile.timeZone ? {} : { timeZone }),
      ...(same(workHours, profile.workHours) ? {} : { workHours }),
      ...(!mine || held === undefined || same(quietHours, held.quiet) ? {} : { quietHours }),
      ...(!mine || held === undefined || draft.holdOutside === held.holdOutside
        ? {}
        : { holdOutsideHours: draft.holdOutside }),
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
