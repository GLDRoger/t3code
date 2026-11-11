import { sessionIsChatOnly, type EnvironmentId, type SessionGrantInput } from "@t3tools/contracts";
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
