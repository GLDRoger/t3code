import {
  kinDraftGoesWith,
  kinDraftJoin,
  kinDraftPrefill,
} from "@t3tools/client-runtime/kin/kinDraft";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { appAtomRegistry } from "../rpc/atomRegistry";

const draftKeys = new Set<string>();

/** Every Kin host uses the same org id, so the environment keeps two hosts' drafts apart. */
/** A Kin chat's files wait in the thread composer's draft store, under a key no thread has. */
const KIN_ATTACHMENT_PREFIX = "kin:";
export const kinAttachmentTarget = (draftKey: string) =>
  DraftId.make(`${KIN_ATTACHMENT_PREFIX}${draftKey}`);

export const kinDraftAtom = Atom.family((key: string) => {
  draftKeys.add(key);
  return Atom.make("").pipe(Atom.keepAlive, Atom.withLabel("kin:draft"));
});

/**
 * Drafts' text lives only in memory, so a reload would lose it; a chat's pictures and files
 * persist, but one still being written to storage, or a file, would not come back whole.
 */
export function hasUnsentKinDraft(): boolean {
  for (const key of draftKeys) {
    if (appAtomRegistry.get(kinDraftAtom(key)).trim().length > 0) return true;
  }
  for (const [key, draft] of Object.entries(useComposerDraftStore.getState().draftsByThreadKey)) {
    if (key.startsWith(KIN_ATTACHMENT_PREFIX) && draft.images.length + draft.files.length > 0)
      return true;
  }
  return false;
}
export { kinDraftKey } from "@t3tools/client-runtime/kin/kinDraft";

/** A host removed from this browser takes its unsent drafts with it (`kinDraftGoesWith`). */
export function clearKinDraftsEnvironment(environmentId: EnvironmentId) {
  for (const key of draftKeys) {
    if (kinDraftGoesWith(key, environmentId)) appAtomRegistry.set(kinDraftAtom(key), "");
  }
}

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
  const atom = kinDraftAtom(`${environmentId}:${orgId}:${chatId}`);
  appAtomRegistry.set(atom, kinDraftPrefill(appAtomRegistry.get(atom), body));
}

/** Puts an unsent body back in the draft, ahead of anything typed since. */
export function restoreDraft(key: string, body: string) {
  const atom = kinDraftAtom(key);
  appAtomRegistry.set(atom, kinDraftJoin(appAtomRegistry.get(atom), body));
}

if (typeof window !== "undefined") restoreCarriedKinDrafts();
