import { useAtomValue } from "@effect/atom-react";
import {
  KIN_REACH_COPY,
  kinAgentReach,
  kinPersonReach,
  kinReachProblem,
  kinReachRows,
  type KinReachInput,
} from "@t3tools/client-runtime/kin/kinReach";
import { KIN_AGENTS_COPY } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KinAgentId,
  KinLeadProfile,
  KinOrgId,
  KinPersonId,
  KinReachParty,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAvatar } from "./KinAvatar";
import { kinClient } from "./kinClient";
import { kinProfileRequestAtom } from "./kinTeamForm";

interface KinReachTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

/** A pair to restrict or lift, with both names as the screen shows them. */
interface KinReachChange {
  readonly a: KinReachParty;
  readonly b: KinReachParty;
  readonly names: readonly [string, string];
  /** `b` is an agent, so the confirm says whose chat stays to read. */
  readonly agent: boolean;
}

/** The page's own section look, so these sit like the sections around them. */
type KinReachSection = React.ComponentType<{
  readonly title: string;
  readonly children: React.ReactNode;
}>;

/** Owners and co-owners only, as the host's `kin.reach.*` are; anyone else is shown nothing. */
const useMayRestrict = (environmentId: EnvironmentId) =>
  useAtomValue(kinClient.reachSet.permissionAtom(environmentId));

/** The restrictions, people and agents, once all three are read; what was read stays up. */
function useKinReach({ environmentId, orgId }: KinReachTarget) {
  const reachAtom = kinClient.reach({ environmentId, input: { orgId } });
  const reach = useAtomValue(reachAtom);
  const people = useAtomValue(kinClient.people({ environmentId, input: { orgId } }));
  const leads = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const heldReach = Option.getOrNull(AsyncResult.value(reach));
  const heldPeople = Option.getOrNull(AsyncResult.value(people));
  const heldLeads = Option.getOrNull(AsyncResult.value(leads));
  const input: KinReachInput | null =
    heldReach === null || heldPeople === null || heldLeads === null
      ? null
      : { reach: heldReach, people: heldPeople.people, agents: heldLeads.leads };
  const set = useAtomCommand(kinClient.reachSet, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ readonly text: string; readonly failed: boolean } | null>(
    null,
  );
  const [asking, setAsking] = useState<KinReachChange | null>(null);

  const change = async (pair: KinReachChange, restricted: boolean) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    const result = await set({
      environmentId,
      input: { orgId, a: pair.a, b: pair.b, restricted },
    });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      appAtomRegistry.refresh(reachAtom);
      const [a, b] = pair.names;
      setNote({
        text: restricted ? KIN_REACH_COPY.done(a, b) : KIN_REACH_COPY.lifted(a, b),
        failed: false,
      });
      return;
    }
    setNote({
      text: kinReachProblem(
        AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
      ),
      failed: true,
    });
  };

  return {
    input,
    failed:
      input === null &&
      (AsyncResult.isFailure(reach) ||
        AsyncResult.isFailure(people) ||
        AsyncResult.isFailure(leads)),
    busy,
    note,
    asking,
    /** Restricting asks first; lifting needs no confirm. */
    restrict: setAsking,
    lift: (pair: KinReachChange) => void change(pair, false),
    confirm: () => {
      const pair = asking;
      setAsking(null);
      if (pair !== null) void change(pair, true);
    },
    cancel: () => setAsking(null),
  };
}

type KinReachState = ReturnType<typeof useKinReach>;

function ReachConfirm(props: { readonly state: KinReachState }) {
  const { asking } = props.state;
  const [a, b] = asking?.names ?? ["", ""];
  return (
    <AlertDialog
      open={asking !== null}
      onOpenChange={(open) => {
        if (!open) props.state.cancel();
      }}
    >
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>{KIN_REACH_COPY.confirmTitle(a, b)}</AlertDialogTitle>
          <AlertDialogDescription>
            {asking?.agent === true
              ? KIN_REACH_COPY.confirmAgent(a, b)
              : KIN_REACH_COPY.confirmPeople(a, b)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button variant="destructive" onClick={props.state.confirm}>
            {KIN_REACH_COPY.restrict}
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function ReachNote(props: { readonly state: KinReachState }) {
  const { note } = props.state;
  if (note === null) return null;
  return (
    <p
      role={note.failed ? "alert" : "status"}
      className={
        note.failed ? "text-xs text-destructive-foreground" : "text-xs text-muted-foreground"
      }
    >
      {note.text}
    </p>
  );
}

function ReachWaiting(props: { readonly state: KinReachState }) {
  return (
    <p className="text-sm text-muted-foreground">
      {props.state.failed ? KIN_REACH_COPY.loadFailed : "Loading…"}
    </p>
  );
}

function PersonRow(props: {
  readonly personId: KinPersonId;
  readonly name: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <li className="flex min-h-9 items-center gap-3">
      <KinAvatar avatar={{ kind: "person", seed: `person:${props.personId}` }} size="sm" />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{props.name}</span>
      {props.action}
    </li>
  );
}

function LiftButton(props: { readonly state: KinReachState; readonly pair: KinReachChange }) {
  const [a, b] = props.pair.names;
  return (
    <Button
      size="xs"
      variant="ghost"
      disabled={props.state.busy}
      aria-label={`${KIN_REACH_COPY.lift} ${a} and ${b}`}
      onClick={() => props.state.lift(props.pair)}
    >
      {KIN_REACH_COPY.lift}
    </Button>
  );
}

/** An agent page's "Who can message": who can, who is restricted, and the way to change it. */
export function KinAgentReach(props: {
  readonly lead: KinLeadProfile;
  readonly environmentId: EnvironmentId;
  readonly section: KinReachSection;
}) {
  if (!useMayRestrict(props.environmentId)) return null;
  return <AgentReachBody {...props} />;
}

function AgentReachBody(props: Parameters<typeof KinAgentReach>[0]) {
  const { lead } = props;
  const state = useKinReach({ environmentId: props.environmentId, orgId: lead.orgId });
  const view = state.input === null ? null : kinAgentReach(state.input, lead.agentId);
  const agent: KinReachParty = { kind: "agent", agentId: lead.agentId };
  const pairOf = (one: { readonly name: string; readonly party: KinReachParty }) => ({
    a: one.party,
    b: agent,
    names: [one.name, lead.name] as const,
    agent: true,
  });
  const intro = (lead.intro ?? "").trim();
  const Section = props.section;
  return (
    <Section title={KIN_REACH_COPY.title}>
      {view === null ? (
        <ReachWaiting state={state} />
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{KIN_REACH_COPY.agentBody(lead.name)}</p>
          {view.canMessage.length === 0 ? null : (
            <ul className="flex flex-col gap-1" aria-label={KIN_REACH_COPY.canMessage}>
              {view.canMessage.map((one) => (
                <PersonRow key={one.personId} personId={one.personId} name={one.name} />
              ))}
            </ul>
          )}
          {view.restricted.length === 0 ? null : (
            <>
              <h4 className="text-xs font-medium text-muted-foreground">
                {KIN_REACH_COPY.restricted}
              </h4>
              <ul className="flex flex-col gap-1" aria-label={KIN_REACH_COPY.restricted}>
                {view.restricted.map((one) => (
                  <PersonRow
                    key={one.personId}
                    personId={one.personId}
                    name={one.name}
                    action={<LiftButton state={state} pair={pairOf(one)} />}
                  />
                ))}
              </ul>
            </>
          )}
          <p className="text-xs text-muted-foreground">
            {intro === "" ? KIN_AGENTS_COPY.nameOnly : KIN_AGENTS_COPY.seesIntro(intro)}
          </p>
          <ReachNote state={state} />
          {view.canMessage.length === 0 ? null : (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="sm"
                    variant="outline"
                    className="self-start"
                    disabled={state.busy}
                  />
                }
              >
                {KIN_REACH_COPY.restrictSomeone}
              </MenuTrigger>
              <MenuPopup align="start">
                {view.canMessage.map((one) => (
                  <MenuItem key={one.personId} onClick={() => state.restrict(pairOf(one))}>
                    {one.name}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          )}
          <ReachConfirm state={state} />
        </>
      )}
    </Section>
  );
}

/**
 * A person's page: each agent they can or can't message, and the people they can't. Shown to
 * the owner and co-owners only; an owner-level person can't be restricted, and their page says so.
 */
export function KinPersonReach(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly personId: KinPersonId;
  readonly name: string;
  readonly ownerLevel: boolean;
  readonly onOpenAgent: () => void;
  readonly section: KinReachSection;
}) {
  const Section = props.section;
  if (!useMayRestrict(props.environmentId)) return null;
  if (props.ownerLevel)
    return (
      <Section title="People">
        <p className="text-sm text-muted-foreground">{KIN_REACH_COPY.ownerLevel(props.name)}</p>
      </Section>
    );
  return <PersonReachBody {...props} />;
}

function PersonReachBody(props: Parameters<typeof KinPersonReach>[0]) {
  const state = useKinReach(props);
  const view = state.input === null ? null : kinPersonReach(state.input, props.personId);
  // Someone no longer here has nothing to restrict.
  if (state.input !== null && view === null) return null;
  const self: KinReachParty = { kind: "person", personId: props.personId };
  const pairWith = (one: { readonly name: string; readonly party: KinReachParty }) => ({
    a: self,
    b: one.party,
    names: [props.name, one.name] as const,
    agent: one.party.kind === "agent",
  });
  const Section = props.section;
  return (
    <>
      <Section title="Agents">
        {view === null ? (
          <ReachWaiting state={state} />
        ) : view.agents.length === 0 ? (
          <p className="text-sm text-muted-foreground">{KIN_AGENTS_COPY.none}</p>
        ) : (
          <ul className="flex flex-col">
            {view.agents.map((agent) => (
              <li key={agent.agentId} className="flex items-center gap-2">
                <AgentLink
                  environmentId={props.environmentId}
                  orgId={props.orgId}
                  agentId={agent.agentId}
                  name={agent.name}
                  line={agent.restricted ? KIN_REACH_COPY.restricted : KIN_REACH_COPY.canMessage}
                  onOpen={props.onOpenAgent}
                />
                {agent.restricted ? (
                  <LiftButton state={state} pair={pairWith(agent)} />
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={state.busy}
                    aria-label={`${KIN_REACH_COPY.restrict} ${props.name} and ${agent.name}`}
                    onClick={() => state.restrict(pairWith(agent))}
                  >
                    {KIN_REACH_COPY.restrict}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
      {view === null ? null : (
        <Section title="People">
          {view.cantMessage.length === 0 ? (
            <p className="text-sm text-muted-foreground">{KIN_REACH_COPY.everyone(props.name)}</p>
          ) : (
            <>
              <h4 className="text-xs font-medium text-muted-foreground">
                {KIN_REACH_COPY.cantMessage}:
              </h4>
              <ul className="flex flex-col gap-1" aria-label={KIN_REACH_COPY.cantMessage}>
                {view.cantMessage.map((one) => (
                  <PersonRow
                    key={one.personId}
                    personId={one.personId}
                    name={one.name}
                    action={<LiftButton state={state} pair={pairWith(one)} />}
                  />
                ))}
              </ul>
            </>
          )}
          <ReachNote state={state} />
          {view.offered.length === 0 ? null : (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="sm"
                    variant="outline"
                    className="self-start"
                    disabled={state.busy}
                  />
                }
              >
                {KIN_REACH_COPY.restrictWith}
              </MenuTrigger>
              <MenuPopup align="start">
                {view.offered.map((one) => (
                  <MenuItem key={one.personId} onClick={() => state.restrict(pairWith(one))}>
                    {one.name}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          )}
        </Section>
      )}
      <ReachConfirm state={state} />
    </>
  );
}

/** An agent's row on a person's page: opens the agent's page over its chat with the owner. */
function AgentLink(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly name: string;
  readonly line: string;
  readonly onOpen: () => void;
}) {
  const navigate = useNavigate();
  const leads = useAtomValue(
    kinClient.leads({ environmentId: props.environmentId, input: { orgId: props.orgId } }),
  );
  const lead = Option.getOrNull(AsyncResult.value(leads))?.leads.find(
    (one) => one.agentId === props.agentId,
  );
  return (
    <button
      type="button"
      onClick={() => {
        if (lead === undefined) return;
        props.onOpen();
        appAtomRegistry.set(kinProfileRequestAtom, lead.ownerChatId);
        void navigate({
          to: "/kin/$environmentId/$orgId/$chatId",
          params: {
            environmentId: props.environmentId,
            orgId: props.orgId,
            chatId: lead.ownerChatId,
          },
        });
      }}
      className="flex min-h-9 min-w-0 flex-1 items-center gap-3 rounded-md px-1 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
    >
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{props.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{props.line}</span>
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

/** Settings, Team: every live restriction in the company, with who set it and when, to lift. */
export function KinReachList(props: KinReachTarget) {
  if (!useMayRestrict(props.environmentId)) return null;
  return <ReachListBody {...props} />;
}

function ReachListBody(props: KinReachTarget) {
  const state = useKinReach(props);
  const rows = state.input === null ? null : kinReachRows(state.input);
  return (
    // The settings search lands here by this id.
    <section id="kin-who-can-message" tabIndex={-1} className="flex flex-col gap-2 px-2 pt-4">
      <h3 className="text-xs font-medium text-muted-foreground">{KIN_REACH_COPY.title}</h3>
      {rows === null ? (
        <ReachWaiting state={state} />
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{KIN_REACH_COPY.allNone}</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{KIN_REACH_COPY.allBody}</p>
          <ul className="flex flex-col" aria-label={KIN_REACH_COPY.restricted}>
            {rows.map((row) => (
              <li key={row.key} className="flex min-h-11 items-center gap-3 py-1">
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate text-sm text-foreground">
                    {row.names[0]} and {row.names[1]}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">{row.detail}</span>
                </span>
                <LiftButton
                  state={state}
                  pair={{ a: row.a, b: row.b, names: row.names, agent: row.b.kind === "agent" }}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      <ReachNote state={state} />
    </section>
  );
}
