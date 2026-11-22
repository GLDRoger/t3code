import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, KinAccessMeResult, KinShell } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { kinAccessMeAtom, refreshKinAccessMe } from "../kinAccess.ts";
import { kinListSend, type KinListOutcome } from "../kinLists.ts";
import type { KinScreenTarget } from "../kinScreenReads.ts";
import { kinSectionOn, kinShellSwitched, type KinSectionId } from "../kinShell.ts";
import type { KinHookApp } from "./kinHookApp.ts";

const noMe = Atom.make<KinAccessMeResult | null>(null);

/** The company's sections, as `kin.access.me` says them, and the owner level's switch. */
export function makeKinShellHooks<R, ER>(app: KinHookApp<R, ER>) {
  const { kinClient, registry, runtime, useAtomCommand, kinHostConnected } = app;

  /** The shell: null until the host has said who this is, undefined from a host older than it. */
  function useKinShell(environmentId: EnvironmentId | null): KinShell | null | undefined {
    const me = useAtomValue(
      environmentId === null ? noMe : kinAccessMeAtom(runtime, environmentId),
    );
    return me === null ? null : me.shell;
  }

  /** `kinSectionOn` for this viewer's company: on until the host says otherwise. */
  function useKinSectionOn(environmentId: EnvironmentId | null, id: KinSectionId): boolean {
    return kinSectionOn(useKinShell(environmentId), id);
  }

  /** Whether this viewer may switch sections: the owner level, as the host gates the call. */
  function useKinSectionCanSet(environmentId: EnvironmentId): boolean {
    return useAtomValue(kinClient.shellSet.permissionAtom(environmentId));
  }

  /**
   * Switches one section from the shell as read. A save, or a host saying it changed since, reads
   * `kin.access.me` again so every screen shows the company as it now is.
   */
  function useKinSectionSet(target: KinScreenTarget) {
    const set = useAtomCommand(kinClient.shellSet, { reportFailure: false });
    return async (
      shell: KinShell,
      id: KinSectionId,
      on: boolean,
    ): Promise<KinListOutcome<KinShell>> => {
      const outcome = await kinListSend({
        online: () => kinHostConnected(target.environmentId),
        send: () =>
          set({
            environmentId: target.environmentId,
            input: { orgId: target.orgId, ...kinShellSwitched(shell, id, on) },
          }),
      });
      if (outcome.ok || outcome.changed)
        refreshKinAccessMe(runtime, registry, target.environmentId);
      return outcome;
    };
  }

  return { useKinShell, useKinSectionOn, useKinSectionCanSet, useKinSectionSet };
}
