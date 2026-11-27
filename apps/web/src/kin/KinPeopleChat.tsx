import { useAtomValue } from "@effect/atom-react";
import {
  KIN_PEOPLE_CHAT,
  kinNewChatList,
  kinPeopleChatProblem,
  type KinNewChatAgent,
} from "@t3tools/client-runtime/kin/kinPeopleChat";
import { kinPersonSeed } from "@t3tools/client-runtime/kin/kinProfiles";
import { kinAgentAvatar } from "@t3tools/client-runtime/kin/kinScreenState";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinOrgId, KinPersonId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState, type ReactNode } from "react";

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
import { useKinOpenAgentChat } from "./useKinOpenChat";
import { runKinCommand } from "@t3tools/client-runtime/kin/kinRunCommand";

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
    const result = await runKinCommand(appAtomRegistry, kinClient.chatWithPerson, {
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

/** New → Message someone: everyone else on the team, then the agents the viewer may message. */
function KinPeoplePicker(props: { readonly target: KinPeopleChatTarget }) {
  const { environmentId, orgId } = props.target;
  const me = useKinMe(environmentId, orgId);
  const result = useKinProfiles(environmentId, orgId);
  const profiles =
    result === null ? null : (Option.getOrNull(AsyncResult.value(result))?.profiles ?? null);
  const leadsResult = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  // Without the agent list the people still show; a failed read lists no agents.
  const leads = AsyncResult.isFailure(leadsResult)
    ? { leads: [] }
    : Option.getOrNull(AsyncResult.value(leadsResult));
  const list = profiles === null || leads === null ? null : kinNewChatList(profiles, me, leads);
  const openPerson = useOpenKinPeopleChat();
  const openAgent = useKinOpenAgentChat();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const close = () => appAtomRegistry.set(kinPeoplePickAtom, null);
  const pick = async (key: string, open: () => Promise<string | null>) => {
    setBusy(key);
    setProblem(null);
    const failed = await open();
    setBusy(null);
    if (failed === null) close();
    else setProblem(failed);
  };
  const row = (
    key: string,
    label: string,
    avatar: ReactNode,
    name: string,
    detail: string | null,
    onPick: () => Promise<string | null>,
  ) => (
    <li key={key}>
      <button
        type="button"
        disabled={busy !== null}
        aria-label={`${KIN_PEOPLE_CHAT.message} ${label}`}
        className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left text-sm outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset disabled:opacity-60"
        onClick={() => void pick(key, onPick)}
      >
        {avatar}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{name}</span>
          {detail === null ? null : (
            <span className="truncate text-xs text-muted-foreground">{detail}</span>
          )}
        </span>
      </button>
    </li>
  );
  const agentRow = (agent: KinNewChatAgent) =>
    row(
      `agent:${agent.agentId}`,
      agent.name,
      <KinAvatar avatar={kinAgentAvatar(agent.agentId)} size="sm" />,
      agent.name,
      agent.intro,
      () => openAgent(environmentId, orgId, agent.agentId),
    );
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
          {list !== null && list.people.length === 0 && list.agents.length > 0 ? (
            list.agentsNote === null ? null : (
              <DialogDescription>{list.agentsNote}</DialogDescription>
            )
          ) : (
            <DialogDescription>{KIN_PEOPLE_CHAT.pickDetail}</DialogDescription>
          )}
        </DialogHeader>
        <DialogPanel>
          {list === null ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading…
            </p>
          ) : list.people.length === 0 && list.agents.length === 0 ? (
            <p className="text-sm text-muted-foreground">{KIN_PEOPLE_CHAT.noOne}</p>
          ) : (
            <div className="flex flex-col gap-3">
              {list.people.length === 0 ? null : (
                <PickSection title={list.peopleTitle}>
                  {list.people.map((person) =>
                    row(
                      `person:${person.personId}`,
                      person.displayName,
                      <KinAvatar
                        avatar={{ kind: "person", seed: kinPersonSeed(person.personId) }}
                        size="sm"
                      />,
                      person.displayName,
                      null,
                      () => openPerson({ environmentId, orgId, personId: person.personId }),
                    ),
                  )}
                </PickSection>
              )}
              {list.agents.length === 0 ? null : (
                <PickSection title={list.agentsTitle}>{list.agents.map(agentRow)}</PickSection>
              )}
              {list.people.length === 0 ||
              list.agents.length === 0 ||
              list.agentsNote === null ? null : (
                <p className="text-xs text-muted-foreground">{list.agentsNote}</p>
              )}
            </div>
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

function PickSection(props: { readonly title: string | null; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1" aria-label={props.title ?? undefined}>
      {props.title === null ? null : (
        <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      )}
      <ul className="-mx-2 flex flex-col">{props.children}</ul>
    </section>
  );
}
