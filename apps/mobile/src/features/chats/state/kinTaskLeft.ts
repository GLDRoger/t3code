import type { KinWorkAction } from "@t3tools/client-runtime/kin/kinWorkChanges";
import type { KinRecord } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

/** The task a task screen just left and closed, for Tasks to say so, with its Undo where there is one. */
export const kinTaskLeftAtom = Atom.make<{
  readonly environmentId: string;
  readonly orgId: string;
  /** The host's answer to the leave, which the Undo puts the reader back on. */
  readonly record: KinRecord;
  /** Null where the host won't put the reader back: they were only on it. */
  readonly undo: KinWorkAction | null;
  readonly text: string;
} | null>(null).pipe(Atom.keepAlive);
