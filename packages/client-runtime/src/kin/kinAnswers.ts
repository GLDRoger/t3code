import { EnvironmentAuthorizationError, KinChatError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

/**
 * The one mapping from a host's answer to what a person reads on any Kin screen, web and phone
 * (`t3code/kin-failure-words` keeps the words here). Only a request that never reached the host
 * says to check the connection and offers Retry; a refusal says so plainly, and something no
 * longer there is the screen's empty or already-handled state, not an error.
 */
export type KinFailure =
  /** The host refused this reader: their words, no Retry. */
  | { readonly kind: "refused"; readonly text: string; readonly retry: false }
  /** Nothing matches, or it is no longer there: show the empty or handled state. */
  | { readonly kind: "gone"; readonly text: string; readonly retry: false }
  /** The host took the request and said what is wrong with it: its words, no Retry. */
  | { readonly kind: "invalid"; readonly text: string; readonly retry: false }
  /** It changed since it was read: the latest shows, and the person decides again. */
  | { readonly kind: "changed"; readonly text: string; readonly retry: false }
  /** The host answered that Kin can't right now: worth another go in a moment. */
  | { readonly kind: "busy"; readonly text: string; readonly retry: true }
  /** The request never got an answer: the connection. */
  | { readonly kind: "offline"; readonly text: string; readonly retry: true };

/** A Retry button's label. Show it only where `failure.retry` is true. */
export const KIN_RETRY = "Try again";
/** A list's next page didn't come. */
export const KIN_MORE_FAILED = "Couldn't load more.";
/** The heading while the Kin host can't be reached. */
export const KIN_HOST_OFFLINE = "Kin is offline";
/** Under a heading that already says what failed, for a request that got no answer. */
export const KIN_CHECK_CONNECTION = "Check your connection to the server and try again.";
export const KIN_BUSY = "Kin isn't answering right now. Try again in a moment.";
export const KIN_CHANGED =
  "This changed while you were looking at it. Here is the latest, so check it and try again.";
/** A page with nothing held, once a connection failed or was lost. */
export const KIN_OFFLINE_PAGE = {
  title: "You're offline",
  detail: "This comes back when the connection does.",
};
/** Said before sending at all while the device is offline. */
export const KIN_OFFLINE_NOT_SENT = "You're offline. Try again when you're back.";

const isChatError = Schema.is(KinChatError);
const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/** The error in a Cause, a failed AsyncResult or a bare error. */
const errorOf = (cause: unknown): unknown =>
  Cause.isCause(cause)
    ? Cause.squash(cause)
    : typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        cause._tag === "Failure" &&
        "cause" in cause &&
        Cause.isCause(cause.cause)
      ? Cause.squash(cause.cause)
      : cause;

/**
 * What to say about a failed request. `what` says what didn't happen, as a sentence ("Couldn't
 * load this list."); `gone` replaces the host's words for something no longer there.
 */
export interface KinFailureWords {
  /** For something no longer there, in this screen's terms. */
  readonly gone?: string;
  /** For a refusal, where the host's own words aren't meant for a person. */
  readonly refused?: string;
  /** For Kin answering that it can't right now, where this screen knows why. */
  readonly busy?: string;
  /** For this device's session lacking the scope: "This device isn't allowed to change Work." */
  readonly device?: string;
}

/** Whether a host's message is for a person: words for an agent's tools (`list_define`, `dueAt`) aren't. */
export const kinPersonWords = (said: string) =>
  said !== "" && !/[a-z]+_[a-z]+|[a-z][A-Z]/.test(said);

export function kinFailure(cause: unknown, what: string, words: KinFailureWords = {}): KinFailure {
  const error = errorOf(cause);
  if (isAuthorizationError(error))
    return {
      kind: "refused",
      text: words.device ?? "This device isn't allowed to do that.",
      retry: false,
    };
  if (!isChatError(error))
    return { kind: "offline", text: `${what} ${KIN_CHECK_CONNECTION}`, retry: true };
  const said = error.message.trim();
  const own = kinPersonWords(said) ? said : null;
  switch (error.reason) {
    case "not_allowed":
      return {
        kind: "refused",
        text: words.refused ?? own ?? "You can't do that here.",
        retry: false,
      };
    case "not_found":
      return { kind: "gone", text: words.gone ?? "That isn't there any more.", retry: false };
    case "conflict":
      return { kind: "changed", text: KIN_CHANGED, retry: false };
    case "unavailable":
    case "disabled":
      return { kind: "busy", text: words.busy ?? `${what} ${KIN_BUSY}`.trim(), retry: true };
    default:
      return { kind: "invalid", text: own ?? `${what} Check the details.`, retry: false };
  }
}

/** A failure's text where only words fit, such as a toast: never offers a Retry it can't keep. */
export const kinFailureText = (cause: unknown, what: string, words?: KinFailureWords) =>
  kinFailure(cause, what, words).text;

/** `what` with a Try again, for a request that never got an answer (no cause to read). */
export const kinRetryText = (what: string) => `${what} ${KIN_RETRY}.`;

/** After a connected service's own failure the host passes on: the service, not this device. */
export const KIN_SERVICE_UNREACHED = "Check the address, or try again in a minute.";
export const KIN_SERVICE_SLOW = "Try again in a minute.";
