import type { EnvironmentId, KinChatId, KinOrgId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

/** The group form that is open: a new group when `chatId` is null, else the one being added to. */
export interface KinGroupFormTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly chatId: KinChatId | null;
}

/** One form at a time, opened from the chat list's "+" or a group's details. */
export const kinGroupFormAtom = Atom.make<KinGroupFormTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("kin:group-form"),
);
