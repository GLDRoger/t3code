import { EnvironmentAuthorizationError, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import type { AsyncResult } from "effect/reactivity";

import type { KinSynced } from "./kinStreams";
import type { KinHost } from "./kinHost";
import type { KinInboxRow, KinInboxState, KinInboxView } from "./kinInboxModel";

/** What a Kin screen reading the inbox shows. */
export type KinInboxScreenState =
  | { readonly _tag: "loading" }
  /** The saved host is offline and nothing is cached yet. */
  | { readonly _tag: "offline" }
  | { readonly _tag: "noHost" }
  | { readonly _tag: "unauthorized" }
  /** The host runs Kin but maps this session to no person. */
  | { readonly _tag: "noIdentity" }
  | {
      readonly _tag: "error";
      readonly message: string;
      /** The failed read: the host probe or the inbox stream. */
      readonly retry: "orgs" | "inbox";
    }
  | {
      readonly _tag: "ready";
      readonly environmentId: EnvironmentId;
      readonly connected: boolean;
      readonly inbox: KinSynced<KinInboxState>;
    };

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

function causeMessage(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.length > 0 ? error.message : "Kin didn't answer.";
}

/** `inbox` is null until a host is known. */
export function kinInboxScreenState(
  host: KinHost,
  inbox: AsyncResult.AsyncResult<KinSynced<KinInboxState>, unknown> | null,
): KinInboxScreenState {
  if (host._tag === "searching") return { _tag: "loading" };
  if (host._tag === "none") return { _tag: "noHost" };
  if (host.probe._tag === "unauthorized") return { _tag: "unauthorized" };
  if (host.probe._tag === "noIdentity") return { _tag: "noIdentity" };
  if (host.probe._tag === "error" && !host.probe.transient) {
    return { _tag: "error", message: host.probe.message, retry: "orgs" };
  }
  // A transient probe failure says nothing about Kin, so a live or cached inbox still shows.
  if (host.probe._tag === "error" && inbox?._tag !== "Success") {
    return { _tag: "error", message: "Couldn't reach Kin.", retry: "orgs" };
  }
  if (inbox === null || inbox._tag === "Initial") {
    return host.connected ? { _tag: "loading" } : { _tag: "offline" };
  }
  if (inbox._tag === "Success") {
    return {
      _tag: "ready",
      environmentId: host.environmentId,
      connected: host.connected,
      inbox: inbox.value,
    };
  }
  if (!host.connected) return { _tag: "offline" };
  if (isAuthorizationError(Cause.squash(inbox.cause))) return { _tag: "unauthorized" };
  return { _tag: "error", message: causeMessage(inbox.cause), retry: "inbox" };
}

/** The time `selectKinInboxView` sorts by (kinInboxModel's `activityAt`). */
const activityAt = (row: KinInboxRow) => row.chat.lastMessageAt ?? row.chat.createdAt;

type KinReadyScreenState = Extract<KinInboxScreenState, { readonly _tag: "ready" }>;

/** The stale-data notice over a ready inbox, or null while it is live and connected. */
export function kinInboxNotice(
  state: KinReadyScreenState,
  formatTime: (date: Date) => string,
): { readonly offline: boolean; readonly message: string } | null {
  const { savedAt } = state.inbox;
  if ((state.connected && state.inbox.live) || savedAt === null) return null;
  const status = state.connected ? "Updating" : "Offline";
  return {
    offline: !state.connected,
    message: `${status}. Last updated ${formatTime(new Date(savedAt))}.`,
  };
}

/** The home row's second line. */
export function kinHomeSubtitle(
  state: KinInboxScreenState,
  view: KinInboxView | null,
): string | null {
  if (view !== null && view.waitingCount > 0) return `Waiting on you · ${view.waitingCount}`;
  switch (state._tag) {
    case "offline":
      return "Offline";
    case "unauthorized":
      return "This device can't read Kin chats";
    case "noIdentity":
      return "Kin doesn't know you on this server yet";
    case "error":
      return "Couldn't load chats";
    case "ready": {
      if (!state.connected) return "Offline";
      // Rows put waiting chats first, so pick the newest by activity, not the first row.
      const latest = view?.rows.reduce<KinInboxRow | null>(
        (best, row) => (best === null || activityAt(row) > activityAt(best) ? row : best),
        null,
      );
      return latest?.chat.lastMessage?.body ?? "No messages yet";
    }
    default:
      return null;
  }
}
