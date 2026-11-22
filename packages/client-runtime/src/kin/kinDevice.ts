/** What a Kin client calls the thing it runs on, in sentences about that device. */
export type KinDevice = "browser" | "phone";

/** Sentences both clients say about the device they run on and the server it is paired with. */
export const KIN_DEVICE_COPY = {
  leaveTeam: "Leave this team",
  leaveTeamTitle: "Leave this team?",
  pairAgain: "Pair it again with the server that runs Kin.",
  pairToOpen: "Pair it with the server this chat is on to open it.",
  cantReadChats: (device: KinDevice) => `This ${device} can't read Kin chats`,
  cantAct: (device: KinDevice, act: "answer" | "confirm") =>
    `This ${device} can't ${act} here. Pair it again with the server that runs Kin.`,
  unknownEnvironment: (device: KinDevice) =>
    `That thread is on an environment this ${device} doesn't know.`,
  /** The phone keeps chats on the device for offline reading; leaving removes them. */
  leave: (device: KinDevice) =>
    `You'll be signed out on this ${device}${device === "phone" ? " and its chats will be removed from it" : ""}. To come back, ask your team for a new join link: it brings back your chats and tasks.`,
} as const;

/**
 * Who is signing out, by where their phone can be removed: `owner` paired it from T3 Code;
 * `coOwner` joined with a link and may remove their own devices; `teammate` joined with a link.
 */
export type KinPhoneLeaver = "owner" | "coOwner" | "teammate";

/** "A", "A and B", "A, B and C". */
const kinNameList = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** What the phone's "This phone" page says about the computers and teams it holds. */
export const KIN_THIS_PHONE_COPY = {
  title: "This phone",
  yourKin: "Your Kin",
  yourKinFooter: "The computer your Kin runs on. This phone talks to it directly.",
  otherTeams: "Other teams on this phone",
  approve: "Approve from this phone",
  approveFooter:
    "Your agents ask before anything that needs your say. You approve on this phone with Face ID.",
  about: "About",
  signOut: (team: string) => `Sign out of ${team}`,
  signOutTitle: (team: string) => `Sign out of ${team}?`,
  /** `teammate` came in with a join link, so only a new one brings them back. */
  signOutDetail: (input: {
    readonly team: string;
    /** Every computer this phone holds for the team, the pressed one first. */
    readonly computers: ReadonlyArray<string>;
    readonly teammate: boolean;
  }) =>
    `${
      input.computers.length > 1
        ? `This phone signs out of ${input.team} on every computer it holds for it, ${kinNameList(input.computers)}, and removes the chats they hold.`
        : `This phone signs out of ${input.team} on ${input.computers[0]} and removes the chats it holds.`
    } ${
      input.teammate
        ? "To come back, ask your team for a new join link: it brings back your chats and tasks."
        : `To come back, connect this phone again from ${input.computers[0]}.`
    }`,
  /** Signed out, but these computers didn't take this phone's notices back. */
  stillNotifiesTitle: (team: string) => `${team} may still notify this phone`,
  stillNotifiesDetail: (input: {
    readonly computers: ReadonlyArray<string>;
    readonly leaver: KinPhoneLeaver;
  }) => {
    const names = kinNameList(input.computers);
    const where = {
      teammate: "Ask whoever runs your Kin to remove this phone from your devices.",
      coOwner: "To stop them, remove this phone under Your devices from another device.",
      owner: `To stop them, remove this phone under Authorized clients in Settings → Sharing & access on ${names}.`,
    }[input.leaver];
    return `You're signed out here, but ${names} didn't answer, so Kin couldn't stop ${
      input.computers.length > 1 ? "their" : "its"
    } notices. ${where}`;
  },
  forget: "Forget",
  forgetTitle: (computer: string) => `Forget ${computer}?`,
  forgetDetail:
    "This phone stops trying to reach it and removes the chats it holds from it. To use it again, connect this phone to it again.",
} as const;

/** The question a join link asks on a phone already signed in to that Kin as a person. */
export const kinJoinSwitchCopy = (signedIn: string | null) =>
  ({
    title:
      signedIn === null ? "Switch who uses this phone?" : `Switch this phone from ${signedIn}?`,
    detail: `This link signs in the person it was made for. ${
      signedIn ?? "Whoever is signed in now"
    } is signed out on this phone, and the chats it holds are removed.`,
    already:
      signedIn === null
        ? "This phone is signed in to your team's Kin. If this link is for someone else, you can sign in with it instead."
        : `This phone is signed in to your team's Kin as ${signedIn}. If this link is for someone else, you can sign in with it instead.`,
    action: "Switch",
  }) as const;

/** One computer this phone holds, as Kin last knew it there. */
export interface KinHeldComputer<Id extends string = string> {
  readonly environmentId: Id;
  /** The computer's name as it calls itself. */
  readonly label: string;
  /** The company and person it answered with, live or last saved; null when it never answered. */
  readonly identity: { readonly orgId: string; readonly personId: string } | null;
  /** It answered this phone as Kin just now. */
  readonly answering: boolean;
}

/**
 * The held computers a newer pairing of the same Kin replaced: one that is not answering while
 * another pairing, with the same computer name, company and person, answers. Being unreachable
 * alone never counts, so a computer that is only off for now stays.
 */
export function kinReplacedComputers<Id extends string>(
  held: ReadonlyArray<KinHeldComputer<Id>>,
): ReadonlyArray<Id> {
  const sameKin = (a: KinHeldComputer<Id>, b: KinHeldComputer<Id>) =>
    a.label === b.label &&
    a.identity !== null &&
    b.identity !== null &&
    a.identity.orgId === b.identity.orgId &&
    a.identity.personId === b.identity.personId;
  return held
    .filter(
      (old) =>
        !old.answering &&
        held.some(
          (newer) =>
            newer.environmentId !== old.environmentId && newer.answering && sameKin(old, newer),
        ),
    )
    .map((old) => old.environmentId);
}

/** A computer This phone lists, as its Sign out sees it. */
export interface KinExitCandidate<Id extends string = string> {
  readonly environmentId: Id;
  readonly label: string;
  /** The team it answered with, live or last saved; null when it never said. */
  readonly team: string | null;
  readonly connected: boolean;
}

/**
 * The computers that carry a "Sign out of <team>": one per team, the one Kin opens on first, then
 * a connected one. A row that isn't connected and never named its team is no team to leave, so
 * it offers Forget instead.
 */
export function kinSignOutExits<Id extends string>(
  computers: ReadonlyArray<KinExitCandidate<Id>>,
  host: Id | null,
): ReadonlyArray<Id> {
  const rank = (one: KinExitCandidate<Id>) =>
    one.environmentId === host ? 0 : one.connected ? 1 : 2;
  const teamOf = (one: KinExitCandidate<Id>) => one.team ?? one.label;
  return computers
    .filter((one) => one.environmentId === host || one.team !== null || one.connected)
    .sort((a, b) => rank(a) - rank(b))
    .filter((one, index, all) => all.findIndex((other) => teamOf(other) === teamOf(one)) === index)
    .map((one) => one.environmentId);
}

/**
 * What one "Sign out of <team>" leaves: every computer this phone holds for that team, the pressed
 * one first. Leaving only that one would hand its Sign out to the next copy of the team.
 */
export function kinSignOutGroup<Id extends string>(
  computers: ReadonlyArray<KinExitCandidate<Id>>,
  exitId: Id,
): ReadonlyArray<Id> {
  const exit = computers.find((one) => one.environmentId === exitId);
  if (exit === undefined) return [];
  const teamOf = (one: KinExitCandidate<Id>) => one.team ?? one.label;
  return [
    exitId,
    ...computers
      .filter((one) => one.environmentId !== exitId && teamOf(one) === teamOf(exit))
      .map((one) => one.environmentId),
  ];
}

/**
 * Who this phone is signed in as on the Kin a join link points at, from that host's directory;
 * null when the host never said, so the question asks without a name rather than guess one.
 */
export function kinJoinSignedInAs(
  me: ReadonlyArray<{ readonly displayName?: string | undefined }> | null,
): string | null {
  const name = me?.[0]?.displayName?.trim() ?? "";
  return name === "" ? null : name;
}
