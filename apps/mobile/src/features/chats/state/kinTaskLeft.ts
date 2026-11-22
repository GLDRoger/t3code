import type { KinWorkAction } from "@t3tools/client-runtime/kin/kinWorkChanges";
import type { KinRecord } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

/** The task a task screen just left and closed, for Tasks to offer its Undo. */
export const kinTaskLeftAtom = Atom.make<{
  readonly environmentId: string;
  readonly orgId: string;
  /** The host's answer to the leave, which the Undo puts the reader back on. */
  readonly record: KinRecord;
  readonly undo: KinWorkAction;
  readonly text: string;
} | null>(null).pipe(Atom.keepAlive);
