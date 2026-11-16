import {
  kinOwnerLevel,
  kinRpcAccess,
  type EnvironmentId,
  type KinAccessMeInput,
  type KinAccessMeResult,
  type KinPersonAccess,
  type KinRpcAccess,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import type { EnvironmentRpcInput, EnvironmentUnaryRpcTag } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily, createEnvironmentRpcCommand } from "../state/runtime.ts";
import { createKinRefreshTriggers, kinDirectoryOrgsAtom } from "./kinRefresh.ts";

/** Whether a person of `kind` may call a method of `access` (`KIN_RPC_ACCESS`). */
function kinAccessAllows(kind: KinPersonAccess | null, access: KinRpcAccess | undefined) {
  if (access === undefined || access === "person") return true;
  if (kind === "owner") return true;
  return kind === "co_owner" && access === "owner_level";
}

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
  const query = createEnvironmentQueryAtomFamily(runtime, {
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
    // A kind change moves `leads` and `people` for everyone, members included.
    refreshTrigger: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: KinAccessMeInput;
    }) => {
      let trigger = triggers.get(`${target.environmentId}:${target.input.orgId}`);
      if (trigger === undefined) {
        const leads = refreshes("leads")(target);
        const people = refreshes("people")(target);
        trigger = Atom.make((get) => `${get(leads)}|${get(people)}`);
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
  return { accessAtom, ownerLevelAtom, meAtom };
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
  if (access === undefined || access === "person") return command;
  const combined = new WeakMap<object, Atom.Atom<boolean>>();
  const permissionAtom = (environmentId: EnvironmentId | null, input?: unknown) => {
    const granted = command.permissionAtom(environmentId, input);
    if (environmentId === null) return granted;
    const kind = kinAccessAtom(runtime, environmentId);
    let atom = combined.get(granted);
    if (atom === undefined) {
      atom = Atom.make((get) => get(granted) && kinAccessAllows(get(kind), access));
      combined.set(granted, atom);
    }
    return atom;
  };
  return { ...command, permissionAtom };
}
