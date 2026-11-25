import { makeKinDocDeleteHooks } from "@t3tools/client-runtime/kin/react/kinDocDeleteHooks";
import type { KinRecordKey } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { kinHookApp } from "./kinHookApp";

export const { useKinDocDelete } = makeKinDocDeleteHooks(kinHookApp);

/** The doc a doc screen just deleted and left, for Docs to offer its Undo. */
export const kinDocLeftDeletedAtom = Atom.make<{
  readonly environmentId: string;
  readonly orgId: string;
  readonly key: KinRecordKey;
  readonly title: string;
} | null>(null).pipe(Atom.keepAlive);
