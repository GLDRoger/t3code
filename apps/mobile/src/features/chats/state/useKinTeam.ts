import { useAtomValue } from "@effect/atom-react";
import { kinFeedViewer } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  KIN_TEAM_NO_EDITS,
  createKinTeamActions,
  type KinTeamActions,
  type KinTeamEdits,
  type KinTeamList,
} from "@t3tools/client-runtime/kin/kinTeam";
import {
  executeAtomQuery,
  runAtomCommand,
  type AtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinOrgId,
  KinPeopleListInvitesResult,
  KinPeopleListResult,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { appAtomRegistry } from "../../../state/atom-registry";
import { kinClient } from "./kinClient";
import { useKinHostAt } from "./useKinHost";

export interface KinTeamTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

// Read only by a session that may hand out access; others ask the host nothing.
const noPeopleAtom: Atom.Atom<AsyncResult.AsyncResult<KinPeopleListResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noInvitesAtom: Atom.Atom<AsyncResult.AsyncResult<KinPeopleListInvitesResult, unknown>> =
  Atom.make(AsyncResult.initial());

// The Team page and a teammate's sheet are separate screens showing the same pending changes.
const teamEdits = Atom.family((_key: string) =>
  Atom.make<KinTeamEdits>(KIN_TEAM_NO_EDITS).pipe(Atom.keepAlive, Atom.withLabel("kin:team-edits")),
);
const teamActions = new Map<string, KinTeamActions>();

const teamAtoms = ({ environmentId, orgId }: KinTeamTarget) => ({
  peopleAtom: kinClient.people({ environmentId, input: { orgId } }),
  invitesAtom: kinClient.invites({ environmentId, input: { orgId } }),
});

export async function refreshKinTeam(target: KinTeamTarget) {
  const { peopleAtom, invitesAtom } = teamAtoms(target);
  // A failed read keeps what is on screen; the page has its own retry.
  const quiet = { refresh: true, reportFailure: false } as const;
  await Promise.all([
    executeAtomQuery(appAtomRegistry, peopleAtom, quiet),
    executeAtomQuery(appAtomRegistry, invitesAtom, quiet),
  ]);
}

function actionsFor(target: KinTeamTarget): KinTeamActions {
  const { environmentId, orgId } = target;
  const key = `${environmentId}:${orgId}`;
  const held = teamActions.get(key);
  if (held !== undefined) return held;
  // A refusal is said on the screen that asked, not in a toast.
  const send = <W, A, E>(command: AtomCommand<W, A, E>, value: W) =>
    runAtomCommand(appAtomRegistry, command, value, {
      label: command.label,
      reportFailure: false,
      reportDefect: true,
    });
  const edits = teamEdits(key);
  const made = createKinTeamActions({
    orgId,
    createInvite: (input) => send(kinClient.inviteCreate, { environmentId, input }),
    revokeInvite: (input) => send(kinClient.inviteCancel, { environmentId, input }),
    removeAccess: (input) => send(kinClient.personRemoveAccess, { environmentId, input }),
    update: (change) => appAtomRegistry.set(edits, change(appAtomRegistry.get(edits))),
    refresh: () => refreshKinTeam(target),
  });
  teamActions.set(key, made);
  return made;
}

/** The owner's team as last read, the changes still in flight, and the actions that make them. */
export function useKinTeam(target: KinTeamTarget) {
  const { environmentId, orgId } = target;
  const allowed = useAtomValue(kinClient.inviteCreate.permissionAtom(environmentId));
  const { peopleAtom, invitesAtom } = teamAtoms(target);
  const people = useAtomValue(allowed ? peopleAtom : noPeopleAtom);
  const invites = useAtomValue(allowed ? invitesAtom : noInvitesAtom);
  const edits = useAtomValue(teamEdits(`${environmentId}:${orgId}`));
  const host = useKinHostAt(environmentId);
  const { personId } = kinFeedViewer(
    host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null,
    orgId,
  );
  // What was last read stays up while it is read again.
  const heldPeople = Option.getOrNull(AsyncResult.value(people));
  const heldInvites = Option.getOrNull(AsyncResult.value(invites));
  const list: KinTeamList | null =
    heldPeople === null || heldInvites === null
      ? null
      : { people: heldPeople.people, joined: heldPeople.joined, invites: heldInvites.invites };
  return {
    allowed,
    list,
    failed: list === null && (AsyncResult.isFailure(people) || AsyncResult.isFailure(invites)),
    ownerPersonId: personId,
    edits,
    actions: actionsFor(target),
    refresh: () => void refreshKinTeam(target),
  };
}
