import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, KinAccessMeResult, KinShell } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { kinAccessMeAtom, refreshKinAccessMe } from "../kinAccess.ts";
import { kinListSend, type KinListOutcome } from "../kinLists.ts";
import type { KinScreenTarget } from "../kinScreenReads.ts";
import { isKinChatError } from "../kinWork.ts";
import { squashAtomCommandFailure } from "../../state/runtime.ts";
import {
  kinSectionNamed,
  kinSectionNamedWords,
  kinSectionOn,
  kinShellChanged,
  type KinSectionChange,
  type KinSectionId,
} from "../kinShell.ts";
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

  /** Kin's words about Clients in this company's name for it (`kinSectionNamed`). */
  function useKinSectionNamed(environmentId: EnvironmentId | null): (text: string) => string {
    const shell = useKinShell(environmentId);
    return (text) => kinSectionNamed(shell, text);
  }

  /** One of Kin's copy objects in this company's name for Clients (`kinSectionNamedWords`). */
  function useKinSectionWords<Words extends object>(
    environmentId: EnvironmentId | null,
    words: Words,
  ): Words {
    return kinSectionNamedWords(useKinShell(environmentId), words);
  }

  /** Whether this viewer may switch sections: the owner level, as the host gates the call. */
  function useKinSectionCanSet(environmentId: EnvironmentId): boolean {
    return useAtomValue(kinClient.shellSet.permissionAtom(environmentId));
  }

  /**
   * Changes one section from the shell as read: its switch or its name. A save, or a host saying it
   * changed since, reads `kin.access.me` again so every screen shows the company as it now is. The
   * host's own words stand for a refusal and for a change made elsewhere.
   */
  function useKinSectionSet(target: KinScreenTarget) {
    const set = useAtomCommand(kinClient.shellSet, { reportFailure: false });
    return async (shell: KinShell, change: KinSectionChange): Promise<KinListOutcome<KinShell>> => {
      let said: string | null = null;
      const outcome = await kinListSend({
        online: () => kinHostConnected(target.environmentId),
        send: async () => {
          const result = await set({
            environmentId: target.environmentId,
            input: { orgId: target.orgId, ...kinShellChanged(shell, change) },
          });
          if (result._tag === "Failure") {
            const error = squashAtomCommandFailure(result);
            if (isKinChatError(error) && error.reason === "conflict") said = error.message.trim();
          }
          return result;
        },
      });
      if (outcome.ok || outcome.changed)
        refreshKinAccessMe(runtime, registry, target.environmentId);
      return !outcome.ok && outcome.changed && said !== null && said !== ""
        ? { ...outcome, problem: said }
        : outcome;
    };
  }

  return {
    useKinShell,
    useKinSectionOn,
    useKinSectionNamed,
    useKinSectionWords,
    useKinSectionCanSet,
    useKinSectionSet,
  };
}
