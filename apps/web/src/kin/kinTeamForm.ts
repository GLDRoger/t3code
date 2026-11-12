import type { KinChatId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

/** Set by "Add teammate" outside the Team page, which opens the form when it shows. */
export const kinTeamAddRequestAtom = Atom.make(false).pipe(
  Atom.keepAlive,
  Atom.withLabel("kin:team-add-request"),
);

/** The chat whose details should be open on arrival: a teammate's row leads to a lead's. */
export const kinProfileRequestAtom = Atom.make<KinChatId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("kin:profile-request"),
);
