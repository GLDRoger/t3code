import { useAtomValue } from "@effect/atom-react";
import type { KinOrgState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { kinListSend } from "../kinLists.ts";
import type { KinScreenTarget } from "../kinScreenReads.ts";
import { kinStopChatLine, kinStopReason, kinStopRow, type KinStopBusy } from "../kinStop.ts";
import { kinWorkReadState } from "../kinWorkForms.ts";
import type { KinHookApp } from "./kinHookApp.ts";

const noState = Atom.make(AsyncResult.initial<KinOrgState, unknown>());

/** The company stop switch on one app's client: its Settings row and a stopped chat's line. */
export function makeKinStopHooks<R, ER>(app: KinHookApp<R, ER>) {
  const { kinClient, registry, useAtomCommand, kinHostConnected } = app;
  const stateAtom = (target: KinScreenTarget) =>
    kinClient.orgState({ environmentId: target.environmentId, input: { orgId: target.orgId } });

  /** The row's words and its one action; the host decides, and the row reads again after. */
  function useKinStop(target: KinScreenTarget) {
    const { environmentId, orgId } = target;
    const atom = stateAtom(target);
    const read = kinWorkReadState(useAtomValue(atom));
    const canAct = useAtomValue(kinClient.orgPause.permissionAtom(environmentId));
    const profiles = useAtomValue(kinClient.profiles({ environmentId, input: { orgId } }));
    const pause = useAtomCommand(kinClient.orgPause, { reportFailure: false });
    const resume = useAtomCommand(kinClient.orgResume, { reportFailure: false });
    const [busy, setBusy] = useState<KinStopBusy>(null);
    const [problem, setProblem] = useState<string | null>(null);
    const refresh = () => registry.refresh(atom);
    const run = async (
      kind: "stop" | "resume",
      send: () => ReturnType<typeof pause> | ReturnType<typeof resume>,
    ) => {
      setBusy(kind);
      setProblem(null);
      const outcome = await kinListSend({ online: () => kinHostConnected(environmentId), send });
      setBusy(null);
      if (!outcome.ok) setProblem(outcome.problem);
      refresh();
    };
    const people = Option.getOrNull(AsyncResult.value(profiles))?.profiles ?? [];
    const row = kinStopRow({
      read,
      canAct,
      busy,
      problem,
      nameOf: (personId) =>
        people.find((profile) => profile.personId === personId)?.displayName ?? null,
    });
    return {
      row,
      canAct,
      refresh,
      stop: (typed: string) =>
        run("stop", () => pause({ environmentId, input: { orgId, ...kinStopReason(typed) } })),
      resume: () => run("resume", () => resume({ environmentId, input: { orgId } })),
    };
  }

  /** "All agents are stopped…" for a chat with an agent, or null; null target reads nothing. */
  function useKinStopLine(target: KinScreenTarget | null) {
    const result = useAtomValue(target === null ? noState : stateAtom(target));
    const canResume = useAtomValue(
      kinClient.orgResume.permissionAtom(target?.environmentId ?? null),
    );
    return target === null
      ? null
      : kinStopChatLine(Option.getOrNull(AsyncResult.value(result)), canResume);
  }

  return { useKinStop, useKinStopLine };
}
