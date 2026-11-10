import {
  EnvironmentRegistry,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
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
import { useState } from "react";
import { AccessibilityInfo } from "react-native";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { useAtomCommand } from "../../../state/use-atom-command";

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
