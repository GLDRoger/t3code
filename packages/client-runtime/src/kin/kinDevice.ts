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
    readonly computer: string;
    readonly teammate: boolean;
  }) =>
    `This phone signs out of ${input.team} on ${input.computer} and removes the chats it holds. ${
      input.teammate
        ? "To come back, ask your team for a new join link: it brings back your chats and tasks."
        : `To come back, connect this phone again from ${input.computer}.`
    }`,
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
