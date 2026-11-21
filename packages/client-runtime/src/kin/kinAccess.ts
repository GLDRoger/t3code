import {
  kinAccessAllows,
  kinOwnerLevel,
  kinRpcAccess,
  type EnvironmentId,
  type KinAccessMeInput,
  type KinAccessMeResult,
  type KinPersonAccess,
  type KinRpcAccess,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import type { EnvironmentRpcInput, EnvironmentUnaryRpcTag } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily, createEnvironmentRpcCommand } from "../state/runtime.ts";
import { createEnvironmentSessionAtoms } from "../state/session.ts";
import type { KinLink } from "./kinHost.ts";
import { createKinRefreshTriggers, kinDirectoryOrgsAtom } from "./kinRefresh.ts";

/**
 * Whether this session may make a call, once that is known. `unknown` until the session's scopes
 * and, for an owner-level call, the viewer's kind have arrived: not yet known is never a refusal.
 */
export type KinPermission = "unknown" | "granted" | "refused" | "failed";

export function kinPermission(input: {
  /** The session's scopes have arrived (or their read failed). */
  readonly sessionKnown: boolean;
  readonly scopesGranted: boolean;
  /** `undefined` until the host has said; null when it answered with no kind. */
  readonly kind: KinPersonAccess | null | undefined;
  readonly access: KinRpcAccess | undefined;
  /** The last read of the scopes or the kind failed without an answer, and none is in flight. */
  readonly failed: boolean;
}): KinPermission {
  const pending = input.failed ? "failed" : "unknown";
  if (!input.sessionKnown) return pending;
  if (!input.scopesGranted) return "refused";
  if (input.access === undefined || input.access === "person") return "granted";
  if (input.kind === undefined) return pending;
  return kinAccessAllows(input.kind, input.access) ? "granted" : "refused";
}

/**
 * What a page gated on one permission shows before its own reads: null once it may read. Until
 * the permission is known it is loading, offline once a connection failed, or failed once its
 * read failed on a live link; never a refusal.
 */
export type KinGate = "loading" | "offline" | "refused" | "failed" | null;
/** The heading on a gate whose read of what this person may open failed. */
export const KIN_GATE_FAILED = "Couldn't load this page";

export function kinGate(permission: KinPermission, link: KinLink): KinGate {
  if (permission === "refused") return "refused";
  if (permission === "granted") return null;
  if (link === "offline") return "offline";
  return permission === "failed" ? "failed" : "loading";
}

// A session read the host refused is an answer; a transport failure retries and says nothing.
const SESSION_REFUSED = new Set([
  "EnvironmentAuthInvalidError",
  "EnvironmentScopeRequiredError",
  "EnvironmentOperationForbiddenError",
]);
const errorTag = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "";
// The host answering the kind read with a refusal is an answer; anything else says nothing.
const KIND_ANSWERED = new Set([
  "KinChatError",
  ...SESSION_REFUSED,
  "EnvironmentAuthorizationError",
]);
const failedWithoutAnswer = (
  result: AsyncResult.AsyncResult<unknown, unknown>,
  answered: ReadonlySet<string>,
) =>
  result._tag === "Failure" &&
  !result.waiting &&
  !answered.has(errorTag(Cause.squash(result.cause)));

/** The viewer's own kind in the org the directory named, or null until the host has said. */
function makeKinAccess<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  const refreshes = createKinRefreshTriggers(runtime);
  const triggers = new Map<string, Atom.Atom<string>>();
  const read = createEnvironmentRpcCommand(runtime, {
    label: "kin:access:read",
    tag: "kin.access.me",
  });
  const query = createKinQueryAtomFamily(runtime, {
    label: "kin:access",
    execute: Effect.fn("KinAccess.me")(function* (input: KinAccessMeInput) {
      const registry = yield* AtomRegistry.AtomRegistry;
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const environmentId = supervisor.target.environmentId;
      // A failed read would leave a co-owner on a member's dock until the next refresh.
      return yield* Effect.suspend(() =>
        Effect.promise(() => read.run(registry, { environmentId, input })),
      ).pipe(
        Effect.flatMap((result) =>
          result._tag === "Success"
            ? Effect.succeed(result.value)
            : result._tag === "Failure"
              ? Effect.failCause(result.cause)
              : Effect.never,
        ),
        Effect.retry({ times: 4, schedule: Schedule.exponential("1 second") }),
      );
    }),
    staleTimeMs: 30_000,
    // A kind change moves `leads` and `people` for everyone, members included; a country chosen
    // moves the company's money.
    refreshTrigger: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: KinAccessMeInput;
    }) => {
      let trigger = triggers.get(`${target.environmentId}:${target.input.orgId}`);
      if (trigger === undefined) {
        const leads = refreshes("leads")(target);
        const people = refreshes("people")(target);
        const company = refreshes("company")(target);
        trigger = Atom.make((get) => `${get(leads)}|${get(people)}|${get(company)}`);
        triggers.set(`${target.environmentId}:${target.input.orgId}`, trigger);
      }
      return trigger;
    },
  });
  const accessAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): KinPersonAccess | null => {
      const [orgId] = get(kinDirectoryOrgsAtom(environmentId));
      if (orgId === undefined) return null;
      const result = get(query({ environmentId, input: { orgId } }));
      return AsyncResult.getOrElse(result, () => null)?.access ?? null;
    }).pipe(Atom.withLabel(`kin:access:${environmentId}`)),
  );
  // The kind once known: a refused read is an answer (null); one not back, or failed, is not.
  const knownAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): KinPersonAccess | null | undefined => {
      const [orgId] = get(kinDirectoryOrgsAtom(environmentId));
      if (orgId === undefined) return undefined;
      const result = get(query({ environmentId, input: { orgId } }));
      if (result._tag === "Initial") return undefined;
      if (result._tag === "Failure")
        return result.waiting || failedWithoutAnswer(result, KIND_ANSWERED) ? undefined : null;
      return result.value.access ?? null;
    }).pipe(Atom.withLabel(`kin:access:known:${environmentId}`)),
  );
  const kindFailedAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): boolean => {
      const [orgId] = get(kinDirectoryOrgsAtom(environmentId));
      if (orgId === undefined) return false;
      return failedWithoutAnswer(get(query({ environmentId, input: { orgId } })), KIND_ANSWERED);
    }).pipe(Atom.withLabel(`kin:access:failed:${environmentId}`)),
  );
  /** Reads the kind again, for a Retry after its read failed. */
  const retryKind = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) => {
    const [orgId] = registry.get(kinDirectoryOrgsAtom(environmentId));
    if (orgId !== undefined) registry.refresh(query({ environmentId, input: { orgId } }));
  };
  const ownerLevelAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => kinOwnerLevel(get(accessAtom(environmentId)) ?? undefined)),
  );
  const meAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): KinAccessMeResult | null => {
      const [orgId] = get(kinDirectoryOrgsAtom(environmentId));
      if (orgId === undefined) return null;
      return AsyncResult.getOrElse(get(query({ environmentId, input: { orgId } })), () => null);
    }).pipe(Atom.withLabel(`kin:access:me:${environmentId}`)),
  );
  return { accessAtom, knownAtom, kindFailedAtom, retryKind, ownerLevelAtom, meAtom };
}

const accessByRuntime = new WeakMap<object, ReturnType<typeof makeKinAccess>>();

/** One kind read per environment on a runtime. */
function kinAccessAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  let atoms = accessByRuntime.get(runtime);
  if (atoms === undefined) {
    atoms = makeKinAccess(runtime);
    accessByRuntime.set(runtime, atoms);
  }
  return atoms;
}

export function kinAccessAtom<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  environmentId: EnvironmentId,
) {
  return kinAccessAtoms(runtime).accessAtom(environmentId);
}

/** The viewer's kind once the host has answered (null when it refused), undefined until then. */
export function kinAccessKnownAtom<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  environmentId: EnvironmentId,
) {
  return kinAccessAtoms(runtime).knownAtom(environmentId);
}

/** The viewer's kind, places and the projects they lead, or null until the host has said. */
export function kinAccessMeAtom<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  environmentId: EnvironmentId,
) {
  return kinAccessAtoms(runtime).meAtom(environmentId);
}

/** Whether the viewer is the owner or a co-owner; false until known. */
export function kinOwnerLevelAtom<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  environmentId: EnvironmentId,
) {
  return kinAccessAtoms(runtime).ownerLevelAtom(environmentId);
}

/** Reads this session's scopes and kind again, for the Retry on a gate whose read failed. */
export function retryKinAccess<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  registry.refresh(createEnvironmentSessionAtoms(runtime).sessionStateAtom(environmentId));
  kinAccessAtoms(runtime).retryKind(registry, environmentId);
}

/** Reads `kin.access.me` again: a link about to be shown must carry the host's current address. */
export function refreshKinAccessMe<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  registry: AtomRegistry.AtomRegistry,
  environmentId: EnvironmentId,
) {
  kinAccessAtoms(runtime).retryKind(registry, environmentId);
}

/**
 * `createEnvironmentRpcCommand` for a Kin method: its `permissionAtom` also needs the viewer's
 * kind to allow the method, so a member never sees an owner-level control. The host decides.
 */
export function createKinRpcCommand<
  R,
  ER,
  TTag extends EnvironmentUnaryRpcTag,
  Input extends EnvironmentRpcInput<TTag> = EnvironmentRpcInput<TTag>,
  Started = undefined,
>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  options: Parameters<typeof createEnvironmentRpcCommand<R, ER, TTag, Input, Started>>[1],
) {
  const command = createEnvironmentRpcCommand<R, ER, TTag, Input, Started>(runtime, options);
  const access = kinRpcAccess(options.tag);
  const sessions = createEnvironmentSessionAtoms(runtime);
  const states = new WeakMap<object, Atom.Atom<KinPermission>>();
  /** `permissionAtom` that tells "not known yet" from a refusal, for a screen that says which. */
  const permissionStateAtom = (environmentId: EnvironmentId, input?: unknown) => {
    const granted = command.permissionAtom(environmentId, input);
    let atom = states.get(granted);
    if (atom === undefined) {
      const session = sessions.sessionStateAtom(environmentId);
      const kind = kinAccessAtoms(runtime).knownAtom(environmentId);
      const kindFailed = kinAccessAtoms(runtime).kindFailedAtom(environmentId);
      const needsKind = access !== undefined && access !== "person";
      atom = Atom.make((get) => {
        const state = get(session);
        return kinPermission({
          sessionKnown:
            state._tag === "Success" ||
            (state._tag === "Failure" && SESSION_REFUSED.has(errorTag(Cause.squash(state.cause)))),
          scopesGranted: get(granted),
          kind: needsKind ? get(kind) : null,
          access,
          failed: failedWithoutAnswer(state, SESSION_REFUSED) || (needsKind && get(kindFailed)),
        });
      });
      states.set(granted, atom);
    }
    return atom;
  };
  if (access === undefined || access === "person") return { ...command, permissionStateAtom };
  const combined = new WeakMap<object, Atom.Atom<boolean>>();
  const permissionAtom = (environmentId: EnvironmentId | null, input?: unknown) => {
    const granted = command.permissionAtom(environmentId, input);
    if (environmentId === null) return granted;
    const kind = kinAccessAtom(runtime, environmentId);
    let atom = combined.get(granted);
    if (atom === undefined) {
      atom = Atom.make(
        (get) => get(granted) && (access === undefined || kinAccessAllows(get(kind), access)),
      );
      combined.set(granted, atom);
    }
    return atom;
  };
  return { ...command, permissionAtom, permissionStateAtom };
}

/**
 * A Kin read whose `refreshTrigger` follows the host's revisions and change numbers, which resume
 * across a reconnect: its answer stays through one, and it reads again only when the trigger moves.
 */
export function createKinQueryAtomFamily<R, ER, Input, A, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  options: Parameters<typeof createEnvironmentQueryAtomFamily<R, ER, Input, A, E>>[1],
) {
  return createEnvironmentQueryAtomFamily<R, ER, Input, A, E>(runtime, {
    ...options,
    keepAcrossSessions: true,
  });
}
