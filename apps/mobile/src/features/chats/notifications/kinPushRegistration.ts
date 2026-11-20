import type { KinHost } from "@t3tools/client-runtime/kin/kinHost";
import {
  KinPushError,
  type EnvironmentId,
  type KinOrgId,
  type KinOrgsListResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isKinPushError = Schema.is(KinPushError);

interface KinPushTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
  /** The person this session is in that org; a refusal holds only for them. */
  readonly personId: string;
  readonly token: string;
}

const targetKey = (target: KinPushTarget) =>
  `${target.environmentId}\u0000${target.orgId}\u0000${target.personId}\u0000${target.token}`;

/**
 * Tokens a host holds for another person. That answer is final for this person: the token isn't
 * sent to that org again until it or the signed-in person changes, and each refusal is noted once.
 */
export function createKinPushRefusals() {
  const refused = new Set<string>();
  return {
    isRefused: (target: KinPushTarget) => refused.has(targetKey(target)),
    /** True the first time `error` refuses `target` for good. */
    note: (target: KinPushTarget, error: unknown): boolean => {
      if (!isKinPushError(error) || error.reason !== "registered_to_someone_else") return false;
      const key = targetKey(target);
      if (refused.has(key)) return false;
      refused.add(key);
      return true;
    },
  };
}

/**
 * What push registration does with the OS permission. Connecting never prompts: the prompt waits
 * for a Kin moment that explains it (opening a chat, the Kin notifications row) and shows once.
 */
export function kinPushPermissionStep(
  permission: { readonly granted: boolean; readonly canAskAgain: boolean },
  request: { readonly wanted: boolean; readonly asked: boolean },
): "register" | "ask" | "wait" {
  if (permission.granted) return "register";
  return request.wanted && !request.asked && permission.canAskAgain ? "ask" : "wait";
}

/**
 * Where this phone's token goes: the usual Kin host once it answered. Never a computer standing
 * in for it, which can be another company's; a token it already holds stays there.
 */
export function kinPushHost(host: KinHost) {
  if (host._tag !== "host" || !host.connected || host.standInFor !== undefined) return null;
  return host.probe._tag === "ready"
    ? { environmentId: host.environmentId, orgs: host.probe.orgs }
    : null;
}

/**
 * The orgs to take this phone's token back from before it forgets `environmentId`: those its
 * live answer names, else those its last saved answer did.
 */
export function kinPushLeaveOrgs(
  host: KinHost,
  environmentId: EnvironmentId,
  cached: KinOrgsListResult | null,
): ReadonlyArray<KinOrgId> {
  const live =
    host._tag === "host" && host.environmentId === environmentId && host.probe._tag === "ready"
      ? host.probe.orgs.me
      : [];
  return [...new Set([...live, ...(cached?.me ?? [])].map(({ orgId }) => orgId))];
}

/**
 * Holds back push registration for a host this phone is forgetting. `fence` waits for any
 * registration already sent there, so the host sees it before the unregister that follows.
 */
export function createKinPushFence() {
  const fenced = new Set<EnvironmentId>();
  const inFlight = new Map<EnvironmentId, Set<Promise<unknown>>>();
  return {
    allows: (environmentId: EnvironmentId) => !fenced.has(environmentId),
    /** Call in the same tick as `allows` said yes, with the registration just sent. */
    track: (environmentId: EnvironmentId, sent: Promise<unknown>) => {
      const held = inFlight.get(environmentId) ?? new Set();
      inFlight.set(environmentId, held);
      held.add(sent);
      const done = () => held.delete(sent);
      sent.then(done, done);
    },
    fence: async (environmentId: EnvironmentId) => {
      fenced.add(environmentId);
      await Promise.allSettled(inFlight.get(environmentId) ?? []);
    },
    release: (environmentId: EnvironmentId) => {
      fenced.delete(environmentId);
    },
  };
}

/**
 * Whether leaving took this phone's alerts back: `nothing` when the host names no org of
 * this person's, `confirmed` when every org answered, else `unconfirmed`.
 */
export function kinPushLeaveOutcome(input: {
  readonly orgs: number;
  /** One per org; null when it timed out or couldn't be sent. */
  readonly answers: ReadonlyArray<boolean | null> | null;
}): "nothing" | "confirmed" | "unconfirmed" {
  if (input.orgs === 0) return "nothing";
  return input.answers !== null &&
    input.answers.length === input.orgs &&
    input.answers.every((ok) => ok === true)
    ? "confirmed"
    : "unconfirmed";
}
