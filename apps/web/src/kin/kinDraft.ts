import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

/** Every Kin host uses the same org id, so the environment keeps two hosts' drafts apart. */
export const kinDraftAtom = Atom.family((_key: string) =>
  Atom.make("").pipe(Atom.keepAlive, Atom.withLabel("kin:draft")),
);
export const kinDraftKey = (environmentId: EnvironmentId, orgId: string, chatId: string) =>
  `${environmentId}:${orgId}:${chatId}`;

/** Readies a message in a chat's box for the owner to send, unless it is already there. */
export function prefillKinDraft(
  environmentId: EnvironmentId,
  orgId: string,
  chatId: string,
  body: string,
) {
  const key = kinDraftKey(environmentId, orgId, chatId);
  if (!appAtomRegistry.get(kinDraftAtom(key)).includes(body)) restoreDraft(key, body);
}

/** Puts an unsent body back in the draft, ahead of anything typed since. */
export function restoreDraft(key: string, body: string) {
  const atom = kinDraftAtom(key);
  const typed = appAtomRegistry.get(atom);
  appAtomRegistry.set(atom, typed.trim().length === 0 ? body : `${body}\n\n${typed}`);
}
