import { useAtomValue } from "@effect/atom-react";
import {
  KIN_GROUP_NAME_MAX,
  kinGroupNameCheck,
  kinGroupProblem,
} from "@t3tools/client-runtime/kin/kinGroups";
import { kinDomainLabel } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { kinAgentAvatar, type KinAvatarView } from "@t3tools/client-runtime/kin/kinScreenState";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  KinAgentId,
  KinChatMembersResult,
  KinPersonId,
  KinPrincipal,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { useId, useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAvatar } from "./KinAvatar";
import { kinClient } from "./kinClient";
import { kinGroupFormAtom, type KinGroupFormTarget } from "./kinGroupForm";
import { useKinHostAt } from "./useKinHost";

const closeGroupForm = () => appAtomRegistry.set(kinGroupFormAtom, null);

type MembersResult = AsyncResult.AsyncResult<KinChatMembersResult, unknown> | null;
const noMembersAtom: Atom.Atom<MembersResult> = Atom.make<MembersResult>(null);

/** The new-group and add-to-group form, wherever it was opened from. Mounted once, on Kin's page. */
export function KinGroupDialogHost() {
  const target = useAtomValue(kinGroupFormAtom);
  if (target === null) return null;
  return <KinGroupDialog key={target.chatId ?? "new"} target={target} />;
}

function PickRow(props: {
  readonly name: string;
  readonly detail: string | null;
  readonly avatar: KinAvatarView;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChange: () => void;
}) {
  const id = useId();
  return (
    <li className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-accent">
      <Checkbox
        id={id}
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={props.onChange}
      />
      <KinAvatar avatar={props.avatar} size="sm" />
      <label htmlFor={id} className="flex min-w-0 flex-1 cursor-pointer flex-col">
        <span className="truncate text-sm text-foreground">{props.name}</span>
        {props.detail === null ? null : (
          <span className="truncate text-xs font-normal text-muted-foreground">{props.detail}</span>
        )}
      </label>
    </li>
  );
}

function KinGroupDialog(props: { readonly target: KinGroupFormTarget }) {
  const { environmentId, orgId, chatId } = props.target;
  const creating = chatId === null;
  const navigate = useNavigate();
  const host = useKinHostAt(environmentId);
  const me = new Set(
    host._tag === "host" && host.probe._tag === "ready"
      ? host.probe.orgs.me.map((entry) => entry.personId as string)
      : [],
  );
  const leadsResult = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const peopleResult = useAtomValue(kinClient.people({ environmentId, input: { orgId } }));
  // A new group has no members to leave out of the lists.
  const membersAtom =
    chatId === null ? null : kinClient.chatMembers({ environmentId, input: { chatId } });
  const membersResult = useAtomValue(membersAtom ?? noMembersAtom);
  const create = useAtomCommand(kinClient.groupCreate, { reportFailure: false });
  const add = useAtomCommand(kinClient.groupAddMember, { reportFailure: false });
  const [name, setName] = useState("");
  // In the order picked: the first lead picked answers when a message names no one.
  const [agentIds, setAgentIds] = useState<ReadonlyArray<KinAgentId>>([]);
  const [personIds, setPersonIds] = useState<ReadonlyArray<KinPersonId>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();

  const inGroup = new Set(
    membersResult !== null && AsyncResult.isSuccess(membersResult)
      ? membersResult.value.members.flatMap((member) =>
          member.leftAt !== null
            ? []
            : [
                member.principal._tag === "agent"
                  ? member.principal.agentId
                  : member.principal.personId,
              ],
        )
      : [],
  );
  const leads = AsyncResult.isSuccess(leadsResult)
    ? leadsResult.value.leads.filter((lead) => !inGroup.has(lead.agentId))
    : [];
  const people = AsyncResult.isSuccess(peopleResult)
    ? peopleResult.value.people.filter(
        (person) => !me.has(person.personId) && !inGroup.has(person.personId),
      )
    : [];
  const loading =
    AsyncResult.isInitial(leadsResult) ||
    AsyncResult.isInitial(peopleResult) ||
    (membersResult !== null && AsyncResult.isInitial(membersResult));
  const picked = agentIds.length + personIds.length;
  const checked = kinGroupNameCheck(name);
  const canSave = !busy && (creating ? checked.ok : picked > 0);
  const toggle = <A,>(list: ReadonlyArray<A>, id: A) =>
    list.includes(id) ? list.filter((held) => held !== id) : [...list, id];

  const save = async () => {
    if (!canSave) return;
    if (chatId === null && !checked.ok) return;
    setBusy(true);
    setError(null);
    if (chatId === null) {
      if (!checked.ok) return;
      const result = await create({
        environmentId,
        input: { orgId, title: checked.title, agentIds, personIds },
      });
      setBusy(false);
      if (result._tag !== "Success") {
        setError(kinGroupProblem(squashAtomCommandFailure(result), "make this group"));
        return;
      }
      closeGroupForm();
      void navigate({
        to: "/kin/$environmentId/$orgId/$chatId",
        params: { environmentId, orgId, chatId: result.value.chatId },
      });
      return;
    }
    const principals: ReadonlyArray<KinPrincipal> = [
      ...agentIds.map((agentId) => ({ _tag: "agent" as const, agentId })),
      ...personIds.map((personId) => ({ _tag: "person" as const, personId })),
    ];
    for (const principal of principals) {
      const result = await add({ environmentId, input: { chatId, principal } });
      if (result._tag === "Success") continue;
      setBusy(false);
      // Those already added stay added; the lists drop them so a second try adds only the rest.
      if (membersAtom !== null) appAtomRegistry.refresh(membersAtom);
      setError(kinGroupProblem(squashAtomCommandFailure(result), "add to this group"));
      return;
    }
    setBusy(false);
    if (membersAtom !== null) appAtomRegistry.refresh(membersAtom);
    closeGroupForm();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) closeGroupForm();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{creating ? "New group" : "Add to group"}</DialogTitle>
            <DialogDescription>
              {creating
                ? "A chat with any mix of your agents and people. Everyone reads what is said while they are in it."
                : "They see only what is said after they join, not earlier messages."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              {creating ? (
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor={nameId}>Name</Label>
                  <Input
                    id={nameId}
                    value={name}
                    maxLength={KIN_GROUP_NAME_MAX}
                    placeholder="Launch week"
                    autoFocus
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
              ) : null}
              {loading ? (
                <p className="text-sm text-muted-foreground">Loading your agents and people…</p>
              ) : (
                <>
                  {leads.length === 0 ? null : (
                    <fieldset className="flex flex-col gap-1.5">
                      <legend className="text-xs font-medium text-muted-foreground">Agents</legend>
                      <ul className="flex flex-col">
                        {leads.map((lead) => (
                          <PickRow
                            key={lead.agentId}
                            name={lead.name}
                            detail={
                              creating && agentIds[0] === lead.agentId
                                ? "Answers when no one is named"
                                : kinDomainLabel(lead.domain)
                            }
                            avatar={kinAgentAvatar(lead.agentId)}
                            checked={agentIds.includes(lead.agentId)}
                            disabled={busy}
                            onChange={() => setAgentIds((held) => toggle(held, lead.agentId))}
                          />
                        ))}
                      </ul>
                      {creating ? (
                        <p className="text-xs text-muted-foreground">
                          The first agent you pick answers when a message names no one. Name another
                          with @ to ask it instead.
                        </p>
                      ) : null}
                    </fieldset>
                  )}
                  {people.length === 0 ? null : (
                    <fieldset className="flex flex-col gap-1.5">
                      <legend className="text-xs font-medium text-muted-foreground">People</legend>
                      <ul className="flex flex-col">
                        {people.map((person) => (
                          <PickRow
                            key={person.personId}
                            name={person.displayName}
                            detail={null}
                            avatar={{ kind: "person", seed: `person:${person.personId}` }}
                            checked={personIds.includes(person.personId)}
                            disabled={busy}
                            onChange={() => setPersonIds((held) => toggle(held, person.personId))}
                          />
                        ))}
                      </ul>
                      <p className="text-xs text-muted-foreground">
                        People in a group can ask its agents to talk things through. Only you can
                        have an agent start work.
                      </p>
                    </fieldset>
                  )}
                  {leads.length === 0 && people.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {creating
                        ? "No agents or people to add yet. You can make the group and add them later."
                        : "Every agent and person you could add is already in this group."}
                    </p>
                  ) : null}
                </>
              )}
              {error === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={closeGroupForm}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave} aria-busy={busy}>
              {creating ? "Create group" : picked > 1 ? `Add ${picked}` : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
