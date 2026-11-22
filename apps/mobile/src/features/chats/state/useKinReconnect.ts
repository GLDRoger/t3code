import {
  EnvironmentRegistry,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import {
  kinJoinSignedInAs,
  kinReplacedComputers,
  type KinHeldComputer,
} from "@t3tools/client-runtime/kin/kinDevice";
import { classifyKinProbe } from "@t3tools/client-runtime/kin/kinHost";
import {
  kinReconnectStep,
  type KinReconnectStatus,
} from "@t3tools/client-runtime/kin/kinScreenState";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo } from "react-native";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentPresentations } from "../../../state/presentation";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useConnectionController } from "../../connection/useConnectionController";
import type { KinPushLeave } from "../notifications/kinPushRegistration";
import { kinLeavingAtom, kinLetGo } from "./kinLeaving";
import { kinCachedOrgsAtom, kinClient } from "./kinClient";

// Past this the supervisor is still backing off, so the button stops claiming an attempt.
const RECONNECT_WAIT = Duration.seconds(20);

/**
 * Retries the host's connection now through the registry, then follows its state until the
 * attempt connects or fails. The retry runs on the first state, so the subscription sees it.
 */
const kinReconnect = createRuntimeCommand(connectionAtomRuntime, {
  label: "kin:reconnect",
  concurrency: { mode: "singleFlight", key: (environmentId: EnvironmentId) => environmentId },
  execute: (environmentId: EnvironmentId) =>
    EnvironmentRegistry.EnvironmentRegistry.pipe(
      Effect.flatMap((registry) =>
        registry.stateChanges(environmentId).pipe(
          Stream.zipWithIndex,
          Stream.tap(([, index]) => (index === 0 ? registry.retryNow(environmentId) : Effect.void)),
          Stream.mapAccum(
            (): { attempted: boolean; before: SupervisorConnectionState | null } => ({
              attempted: false,
              before: null,
            }),
            (acc, [state]) => {
              const before = acc.before ?? state;
              const step = kinReconnectStep(acc.attempted, state, before);
              return [{ attempted: step.attempted, before }, [step.outcome]] as const;
            },
          ),
          Stream.filter((outcome) => outcome !== "pending"),
          Stream.runHead,
        ),
      ),
      Effect.timeoutOption(RECONNECT_WAIT),
      Effect.map((outcome) => Option.flatten(outcome).pipe(Option.getOrElse(() => "failed"))),
      Effect.orElseSucceed(() => "failed" as const),
    ),
});

/** The Offline notice's Reconnect action: pending while it tries, then gone or failed. */
export function useKinReconnect(environmentId: EnvironmentId | null): {
  readonly status: KinReconnectStatus;
  readonly reconnect: (() => void) | null;
} {
  const run = useAtomCommand(kinReconnect, { reportFailure: false });
  const [status, setStatus] = useState<KinReconnectStatus>("idle");
  if (environmentId === null) return { status: "idle", reconnect: null };
  const reconnect = () => {
    if (status === "pending") return;
    setStatus("pending");
    void run(environmentId).then((result) => {
      const connected = result._tag === "Success" && result.value === "connected";
      // A success removes the notice, which announces failures itself, so VoiceOver hears it here.
      if (connected) AccessibilityInfo.announceForAccessibility("Reconnected");
      setStatus(connected ? "idle" : "failed");
    });
  };
  return { status, reconnect };
}

/** A computer this phone holds, with the team and person Kin last knew there. */
export interface KinHeldComputerState extends KinHeldComputer<EnvironmentId> {
  readonly team: string | null;
  readonly signedInAs: string | null;
}

/** Every computer this phone holds, from its live answer or, while it is down, the saved one. */
export const kinHeldComputersAtom = Atom.make((get): ReadonlyArray<KinHeldComputerState> =>
  [...get(environmentPresentations.presentationsAtom)].map(([environmentId, presentation]) => {
    const probe = classifyKinProbe(get(kinClient.orgs({ environmentId, input: {} })));
    const live = probe._tag === "ready" ? probe.orgs : null;
    const directory =
      live ?? AsyncResult.getOrElse(get(kinCachedOrgsAtom(environmentId)), () => null);
    const me = directory?.me[0];
    return {
      environmentId,
      label: presentation.entry.target.label,
      identity: me === undefined ? null : { orgId: me.orgId, personId: me.personId },
      answering: live !== null && presentation.connection.phase === "connected",
      team: directory?.orgs.find((org) => org.orgId === me?.orgId)?.name ?? null,
      signedInAs: kinJoinSignedInAs(directory?.me ?? null),
    };
  }),
).pipe(Atom.withLabel("kin:held-computers"));

/** The held computers a newer pairing of the same Kin has replaced, which the phone forgets. */
export const kinReplacedComputersAtom = Atom.make((get) =>
  kinReplacedComputers(get(kinHeldComputersAtom)),
).pipe(Atom.withLabel("kin:replaced-computers"));

/** Who this phone is signed in as on one computer, read at the moment a join link asks. */
export function readKinSignedInAs(environmentId: EnvironmentId): string | null {
  return (
    appAtomRegistry.get(kinHeldComputersAtom).find((held) => held.environmentId === environmentId)
      ?.signedInAs ?? null
  );
}

/** Forgets, once each, the computers a newer pairing of the same Kin replaced. */
export function useForgetReplacedComputers(enabled: boolean): void {
  const replaced = useAtomValue(kinReplacedComputersAtom);
  const { removeEnvironment } = useConnectionController();
  const asked = useRef(new Set<EnvironmentId>());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- removes a replaced computer from the phone's saved connections
  useEffect(() => {
    if (!enabled) return;
    for (const environmentId of replaced) {
      if (asked.current.has(environmentId)) continue;
      asked.current.add(environmentId);
      void removeEnvironment(environmentId);
    }
  }, [enabled, replaced, removeEnvironment]);
}

/**
 * What this phone is letting go of, and the way to let computers go, which gives back what each
 * said to taking this phone's notices back, for the caller to tell once.
 */
export function useKinLeaving(): {
  readonly leaving: ReadonlyArray<EnvironmentId>;
  readonly letGo: (
    environmentIds: ReadonlyArray<EnvironmentId>,
  ) => Promise<ReadonlyMap<EnvironmentId, KinPushLeave>>;
} {
  const leaving = useAtomValue(kinLeavingAtom);
  const { removeEnvironment } = useConnectionController();
  const letGo = async (environmentIds: ReadonlyArray<EnvironmentId>) => {
    const outcomes = new Map<EnvironmentId, KinPushLeave>();
    await kinLetGo(environmentIds, (id) =>
      removeEnvironment(id, (outcome) => outcomes.set(id, outcome)),
    );
    return outcomes;
  };
  return { leaving, letGo };
}
