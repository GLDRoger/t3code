import { EnvironmentAuthorizationError, type EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import type { AsyncResult } from "effect/reactivity";

import type { KinSynced } from "./kinClient";
import type { KinHost } from "./kinHost";
import type { KinInboxState } from "./kinInboxModel";

/** What a Kin screen reading the inbox shows. */
export type KinInboxScreenState =
  | { readonly _tag: "loading" }
  /** The saved host is offline and nothing is cached yet. */
  | { readonly _tag: "offline" }
  | { readonly _tag: "noHost" }
  | { readonly _tag: "unauthorized" }
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
  if (host.probe._tag === "error") {
    return { _tag: "error", message: host.probe.message, retry: "orgs" };
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
