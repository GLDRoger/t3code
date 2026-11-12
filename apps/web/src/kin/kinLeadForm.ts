import type { EnvironmentId, KinLeadProfile, KinOrgId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

/** The lead form that is open: a new lead when `lead` is null, else the one being edited. */
export interface KinLeadFormTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly lead: KinLeadProfile | null;
}

/** One form at a time, opened from the chat list, a lead's profile or the command palette. */
export const kinLeadFormAtom = Atom.make<KinLeadFormTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("kin:lead-form"),
);
