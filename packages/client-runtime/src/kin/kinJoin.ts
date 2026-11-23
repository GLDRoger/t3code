import {
  KIN_WORK_RPC_SCOPES,
  kinOwnerLevel,
  sessionGrantsScope,
  sessionIsChatOnly,
  type AuthEnvironmentScope,
  type EnvironmentId,
  type KinPersonAccess,
  type KinShell,
  type SessionGrantInput,
} from "@t3tools/contracts";
import { kinDestinations, type KinDestination, type KinPlacesRefused } from "./kinNavigation.ts";
import { kinSectionOn } from "./kinShell.ts";
import { readKinJoinLink } from "@t3tools/shared/remote";

/** A join link a teammate gave the app, and the address it points at, shown before joining. */
export interface KinJoinTarget {
  readonly link: string;
  readonly address: string;
}

/** The join link in what was pasted, scanned or opened; null when there is none. */
export function kinJoinTarget(text: string): KinJoinTarget | null {
  const link = readKinJoinLink(text);
  return link === null ? null : { link, address: new URL(link).host };
}

/**
 * Whether a browser opening a join link should offer the phone app before spending the link.
 * iPadOS reports itself as a Mac, so an iPad joins in the browser like a computer does.
 */
export function kinJoinOffersApp(userAgent: string): boolean {
  return /iPhone|iPod|Android/i.test(userAgent);
}

export interface KinJoinSavedEnvironment {
  readonly environmentId: EnvironmentId;
  readonly httpBaseUrls: ReadonlyArray<string>;
  readonly chatOnly: boolean;
  readonly connected: boolean;
}

/**
 * Where this device already stands with the Kin a link points at, asked before the single-use
 * link is spent. `member` is a signed-in teammate; one whose access ended is `new`, so the link
 * signs them back in. `fullAccess` must never be swapped for a teammate's chat-only session.
 */
export type KinJoinStanding =
  | { readonly _tag: "new" }
  | { readonly _tag: "member"; readonly environmentId: EnvironmentId }
  | { readonly _tag: "fullAccess"; readonly environmentId: EnvironmentId };

const originOf = (url: string) => (URL.canParse(url) ? new URL(url).origin : null);

export function kinJoinStanding(
  target: KinJoinTarget,
  saved: ReadonlyArray<KinJoinSavedEnvironment>,
): KinJoinStanding {
  const origin = originOf(target.link);
  const match = saved.find((environment) =>
    environment.httpBaseUrls.some((url) => originOf(url) === origin),
  );
  if (match === undefined) return { _tag: "new" };
  if (!match.chatOnly) return { _tag: "fullAccess", environmentId: match.environmentId };
  return match.connected ? { _tag: "member", environmentId: match.environmentId } : { _tag: "new" };
}

export const KIN_JOIN_NO_LINK =
  "That doesn't look like a join link. Paste the whole link your team sent you.";
export const KIN_JOIN_UNREACHABLE =
  "Couldn't reach your team's Kin. Check your connection and try again. Your link hasn't been used.";
/**
 * What a teammate's browser or phone says once their access ended, wherever Kin finds it out;
 * `left` when they left the team themselves from this device.
 */
export const kinAccessEndedCopy = (device: "browser" | "phone", left = false) =>
  left
    ? ({
        title: "You left this team",
        detail: `This ${device} is signed out of your team's Kin. To come back, ask whoever runs it for a new join link: opening it brings you back with your chats and tasks.`,
        action: "Join with a new link",
      } as const)
    : ({
        title: "Your access to Kin has ended",
        detail: `Whoever runs your team's Kin removed your access or signed this ${device} out. Ask them for a new join link: opening it brings you back with your chats and tasks.`,
        action: "Join with a new link",
      } as const);
export const KIN_JOIN_UPDATE_APP = "Update this app to join your team's Kin, then try again.";
export const KIN_JOIN_FAILED =
  "Couldn't join. Try again, or ask your team for a new link if it keeps happening.";

/**
 * What a teammate reads when joining fails. A spent link keeps the sentence the connection layer
 * wrote for it; every other failure is retold here, because those are written for an owner pairing
 * a computer.
 */
export function kinJoinFailureMessage(error: unknown): string {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return KIN_JOIN_FAILED;
  if (error._tag === "ConnectionTransientError") return KIN_JOIN_UNREACHABLE;
  if (error._tag !== "ConnectionBlockedError" || !("reason" in error)) return KIN_JOIN_FAILED;
  if (error.reason === "unsupported") return KIN_JOIN_UPDATE_APP;
  return error.reason === "authentication" && "detail" in error && typeof error.detail === "string"
    ? error.detail
    : KIN_JOIN_FAILED;
}

/**
 * The saved environments whose session is a teammate's. A session answers for itself once it is
 * known; until then the device's last answer stands, so a cold start offline keeps its shape.
 */
export function kinChatOnlyEnvironments(input: {
  readonly saved: ReadonlyArray<EnvironmentId>;
  readonly session: (environmentId: EnvironmentId) => SessionGrantInput | null;
  readonly remembered: ReadonlySet<EnvironmentId>;
}): ReadonlyArray<EnvironmentId> {
  return input.saved.filter((environmentId) => {
    const session = input.session(environmentId);
    return session === null ? input.remembered.has(environmentId) : sessionIsChatOnly(session);
  });
}

/** `chatOnly` when every environment on the device is a teammate's: the app is then only Kin. */
export type KinAppShell = "loading" | "coding" | "chatOnly";

export function kinAppShell(input: {
  /** False until the saved environments and the remembered answers have loaded. */
  readonly ready: boolean;
  readonly saved: number;
  readonly chatOnly: number;
}): KinAppShell {
  if (!input.ready) return "loading";
  return input.saved > 0 && input.chatOnly === input.saved ? "chatOnly" : "coding";
}

/**
 * The host no longer accepts this session: the owner removed the teammate, or it ran out. Only a
 * new join link brings it back, so the app says so instead of retrying.
 */
export function kinAccessEnded(
  connection: {
    readonly phase: string;
    readonly lastFailure: { readonly _tag: string; readonly reason: string } | null;
  } | null,
): boolean {
  return (
    connection !== null &&
    connection.phase === "blocked" &&
    connection.lastFailure?._tag === "ConnectionBlockedError" &&
    connection.lastFailure.reason === "authentication"
  );
}

const grants = (session: SessionGrantInput | null) => (scope: AuthEnvironmentScope) =>
  session !== null && sessionGrantsScope(session, scope);

export type KinHomeTab = "chats" | "work" | "team" | "memory" | "settings";

/** The places a Kin home's dock draws. Settings is a button on Chats, Team and Memory its pages. */
export type KinDockTab = KinDestination;

/** Places the host has answered it won't show this viewer, which a grant can't tell apart. */
export type KinDockRefused = KinPlacesRefused;

/** The dock for a session: `kinDestinations`, with Work read from the session's grant. */
export function kinDockTabs(
  session: SessionGrantInput | null,
  ownerLevel: boolean,
  refused: KinDockRefused,
  reaches: KinPlaceReach | null = null,
): ReadonlyArray<KinDockTab> {
  return kinDestinations({
    work: grants(session)(KIN_WORK_RPC_SCOPES["kin.work.list"]),
    ownerLevel,
    refused,
    reaches,
  });
}

/**
 * Which places someone besides the owner reaches: switched on for them, or a project they lead,
 * while the company has that place's section on. Their own switches stay as set while it is off.
 */
export type KinPlaceReach = KinDockRefused;
export function kinPlaceReach(
  me: {
    readonly places?: KinDockRefused | undefined;
    readonly leads?: ReadonlyArray<unknown> | undefined;
    readonly shell?: KinShell | undefined;
  } | null,
): KinPlaceReach | null {
  if (me === null || me.places === undefined) return null;
  const lead = (me.leads?.length ?? 0) > 0;
  return {
    money: kinSectionOn(me.shell, "money") && (me.places.money || lead),
    clients: kinSectionOn(me.shell, "clients") && (me.places.clients || lead),
    docs: me.places.docs || lead,
  };
}

/**
 * What the viewer may reach, as one string: their kind, places and led projects. A read keyed on it
 * asks again the moment the owner switches a place, in either direction.
 */
export function kinViewerReachKey(me: {
  readonly access?: KinPersonAccess | undefined;
  readonly places?: KinDockRefused | undefined;
  readonly leads?: ReadonlyArray<{ readonly recordId: string }> | undefined;
}): string {
  const places =
    me.places === undefined ? "" : `${+me.places.money}${+me.places.clients}${+me.places.docs}`;
  const leads = (me.leads ?? []).map((lead) => lead.recordId).sort();
  return `${me.access ?? ""}:${places}:${leads.join(",")}`;
}

/**
 * Whether the viewer runs the company here: their stored kind once the host has said, and until
 * then a session with more than chat (the owner's own) is taken for the owner's.
 */
export function kinViewerOwnerLevel(
  access: KinPersonAccess | null,
  session: SessionGrantInput | null,
): boolean {
  if (access !== null) return kinOwnerLevel(access);
  return session !== null && session.authenticated && !sessionIsChatOnly(session);
}

/**
 * The tabs of a Kin-only home, in order: a tab whose page the host would refuse is never offered.
 * A member gets chats, work and settings; the owner and a co-owner also team and memory.
 */
export function kinHomeTabs(
  session: SessionGrantInput | null,
  ownerLevel: boolean,
): ReadonlyArray<KinHomeTab> {
  const allowed = grants(session);
  return [
    "chats",
    ...(allowed(KIN_WORK_RPC_SCOPES["kin.work.list"]) ? (["work"] as const) : []),
    ...(ownerLevel ? (["team", "memory"] as const) : []),
    "settings",
  ];
}
