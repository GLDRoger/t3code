import {
  kinOwnerLevel,
  kinRpcAccess,
  type EnvironmentId,
  type KinAccessMeInput,
  type KinPersonAccess,
  type KinRpcAccess,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
      const result = yield* Effect.promise(() => read.run(registry, { environmentId, input }));
      return yield* result._tag === "Success"
        ? Effect.succeed(result.value)
        : result._tag === "Failure"
          ? Effect.failCause(result.cause)
          : Effect.never;
    }),
    staleTimeMs: 30_000,
    // A kind change moves `leads` for everyone, members included.
    refreshTrigger: createKinRefreshTriggers(runtime)("leads"),
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
  return { accessAtom, ownerLevelAtom };
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
