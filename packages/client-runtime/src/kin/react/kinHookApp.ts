import type { EnvironmentId, KinMoneyPart } from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";
import { useEffect, useRef } from "react";

import type * as EnvironmentRegistry from "../../connection/registry.ts";
import type { AtomCommand, AtomCommandOptions, AtomCommandResult } from "../../state/runtime.ts";
import type { KinClient } from "../kinClient.ts";
import type { KinMoneyLiveRead, KinScreenReads, KinScreenTarget } from "../kinScreenReads.ts";

/** What Kin's shared data hooks take from the app that renders them. */
export interface KinHookApp<R, ER> {
  readonly kinClient: KinClient;
  readonly kinReads: KinScreenReads;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>;
  readonly useAtomCommand: <A, E, W>(
    command: AtomCommand<W, A, E>,
    options?: string | AtomCommandOptions,
  ) => (value: W) => Promise<AtomCommandResult<A, E>>;
  readonly kinHostConnected: (environmentId: EnvironmentId) => boolean;
}

/** The app's `useKinMoneyLive`: `part` from Money's stream where this viewer reads it. */
export type KinUseMoneyLive = <P extends KinMoneyPart>(
  target: KinScreenTarget,
  part: P,
) => KinMoneyLiveRead<P> | null | undefined;

/** Reads again when Work says something changed; `seq` is null while that isn't known. */
export function useRereadOnChange(seq: number | null, reread: () => void) {
  const seen = useRef(seq);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the host's figures again when the host announces a change to Work
  useEffect(() => {
    if (seq === null || seq === seen.current) return;
    const first = seen.current === null;
    seen.current = seq;
    if (!first) reread();
  }, [seq, reread]);
}
