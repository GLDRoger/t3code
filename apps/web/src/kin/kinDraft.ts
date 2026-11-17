import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "../rpc/atomRegistry";

const draftKeys = new Set<string>();

/** Every Kin host uses the same org id, so the environment keeps two hosts' drafts apart. */
export const kinDraftAtom = Atom.family((key: string) => {
  draftKeys.add(key);
  return Atom.make("").pipe(Atom.keepAlive, Atom.withLabel("kin:draft"));
});

/** Drafts live only in memory, so a reload would lose any chat's unsent text. */
export function hasUnsentKinDraft(): boolean {
  for (const key of draftKeys) {
    if (appAtomRegistry.get(kinDraftAtom(key)).trim().length > 0) return true;
  }
  return false;
}
export const kinDraftKey = (environmentId: EnvironmentId, orgId: string, chatId: string) =>
  `${environmentId}:${orgId}:${chatId}`;

const CARRIED_DRAFTS_KEY = "t3code:kin:carried-drafts";

/** Keeps every unsent draft for the reload that follows; `restoreCarriedKinDrafts` puts them back. */
export function carryKinDraftsAcrossReload() {
  const drafts: Record<string, string> = {};
  for (const key of draftKeys) {
    const text = appAtomRegistry.get(kinDraftAtom(key));
    if (text.trim().length > 0) drafts[key] = text;
  }
  try {
    window.sessionStorage.setItem(CARRIED_DRAFTS_KEY, JSON.stringify(drafts));
  } catch {
    // Without storage there is nothing to carry them in.
  }
}

export function restoreCarriedKinDrafts() {
  let carried: unknown;
  try {
    const raw = window.sessionStorage.getItem(CARRIED_DRAFTS_KEY);
    if (raw === null) return;
    window.sessionStorage.removeItem(CARRIED_DRAFTS_KEY);
    carried = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof carried !== "object" || carried === null) return;
  for (const [key, text] of Object.entries(carried)) {
    if (typeof text === "string") restoreDraft(key, text);
  }
}

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

if (typeof window !== "undefined") restoreCarriedKinDrafts();
