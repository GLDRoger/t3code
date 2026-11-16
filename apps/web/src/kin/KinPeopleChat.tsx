import { useAtomValue } from "@effect/atom-react";
import {
  KIN_PEOPLE_CHAT,
  kinMessageablePeople,
  kinPeopleChatProblem,
} from "@t3tools/client-runtime/kin/kinPeopleChat";
import { kinPersonSeed } from "@t3tools/client-runtime/kin/kinProfiles";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { KinAvatar } from "./KinAvatar";
import { kinClient } from "./kinClient";
import { useKinProfiles } from "./kinPictures";
import { useKinMe } from "./KinProfileSheet";

interface KinPeopleChatTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

const kinPeoplePickAtom = Atom.make<KinPeopleChatTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("kin:people-chat-pick"),
);

export const openKinPeoplePicker = (target: KinPeopleChatTarget) =>
  appAtomRegistry.set(kinPeoplePickAtom, target);

/** Opens the viewer's chat with a teammate, made the first time; the problem when it can't. */
export function useOpenKinPeopleChat() {
  const navigate = useNavigate();
  return async (target: KinPeopleChatTarget & { readonly personId: KinPersonId }) => {
    const result = await kinClient.chatWithPerson.run(appAtomRegistry, {
      environmentId: target.environmentId,
      input: { orgId: target.orgId, personId: target.personId },
    });
    if (result._tag !== "Success") return kinPeopleChatProblem(squashAtomCommandFailure(result));
    void navigate({
      to: "/kin/$environmentId/$orgId/$chatId",
      params: {
        environmentId: target.environmentId,
        orgId: target.orgId,
        chatId: result.value.chatId,
      },
    });
    return null;
  };
}

export function KinPeoplePickerHost() {
  const target = useAtomValue(kinPeoplePickAtom);
  if (target === null) return null;
  return <KinPeoplePicker key={`${target.environmentId}:${target.orgId}`} target={target} />;
}

/** New → Message a teammate: everyone else on the team, one tap to their chat. */
function KinPeoplePicker(props: { readonly target: KinPeopleChatTarget }) {
  const { environmentId, orgId } = props.target;
  const me = useKinMe(environmentId, orgId);
  const result = useKinProfiles(environmentId, orgId);
  const profiles =
    result === null ? null : (Option.getOrNull(AsyncResult.value(result))?.profiles ?? null);
  const people = profiles === null ? null : kinMessageablePeople(profiles, me);
  const open = useOpenKinPeopleChat();
  const [busy, setBusy] = useState<KinPersonId | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const close = () => appAtomRegistry.set(kinPeoplePickAtom, null);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>{KIN_PEOPLE_CHAT.pickTitle}</DialogTitle>
          <DialogDescription>{KIN_PEOPLE_CHAT.pickDetail}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {people === null ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading…
            </p>
          ) : people.length === 0 ? (
            <p className="text-sm text-muted-foreground">{KIN_PEOPLE_CHAT.noOne}</p>
          ) : (
            <ul className="-mx-2 flex flex-col">
              {people.map((person) => (
                <li key={person.personId}>
                  <button
                    type="button"
                    disabled={busy !== null}
                    aria-label={`${KIN_PEOPLE_CHAT.message} ${person.displayName}`}
                    className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset disabled:opacity-60"
                    onClick={async () => {
                      setBusy(person.personId);
                      setProblem(null);
                      const failed = await open({
                        environmentId,
                        orgId,
                        personId: person.personId,
                      });
                      setBusy(null);
                      if (failed === null) close();
                      else setProblem(failed);
                    }}
                  >
                    <KinAvatar
                      avatar={{ kind: "person", seed: kinPersonSeed(person.personId) }}
                      size="sm"
                    />
                    <span className="min-w-0 flex-1 truncate">{person.displayName}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {problem === null ? null : (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {problem}
            </p>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
