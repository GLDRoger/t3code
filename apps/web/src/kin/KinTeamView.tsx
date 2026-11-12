import { useAtomValue } from "@effect/atom-react";
import { kinFeedViewer } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  KIN_TEAM_ADD,
  KIN_TEAM_EMPTY,
  KIN_TEAM_LOAD_FAILED,
  KIN_TEAM_NO_EDITS,
  KIN_TEAM_ONLY_OWNER,
  KIN_TEAM_TITLE,
  createKinTeamActions,
  kinRemoveAccessCopy,
  kinTeamEntrySummary,
  kinTeamView,
  kinTeammateActions,
  kinTeammateLeadLine,
  type KinMadeInvite,
  type KinTeamActions,
  type KinTeamList,
  type KinTeammate,
} from "@t3tools/client-runtime/kin/kinTeam";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinLeadProfile, KinOrgId, KinPersonId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeftIcon, ChevronRightIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { Skeleton } from "../components/ui/skeleton";
import { isElectron } from "../env";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAvatar } from "./KinAvatar";
import { KinInviteDialog, type KinInviteDialogState } from "./KinInviteDialog";
import { KinVisualHosts } from "./KinVisualHosts";
import { kinClient } from "./kinClient";
import { kinProfileRequestAtom, kinTeamAddRequestAtom } from "./kinTeamForm";
import { useKinHostAt } from "./useKinHost";

interface KinTeamTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

const teamAtoms = ({ environmentId, orgId }: KinTeamTarget) => ({
  peopleAtom: kinClient.people({ environmentId, input: { orgId } }),
  invitesAtom: kinClient.invites({ environmentId, input: { orgId } }),
});

async function refreshKinTeam(target: KinTeamTarget) {
  const { peopleAtom, invitesAtom } = teamAtoms(target);
  // A failed read keeps what is on screen; the page has its own retry.
  const quiet = { refresh: true, reportFailure: false } as const;
  await Promise.all([
    executeAtomQuery(appAtomRegistry, peopleAtom, quiet),
    executeAtomQuery(appAtomRegistry, invitesAtom, quiet),
  ]);
}

/** The people and unopened links, once both have been read; what was last read stays up. */
function useKinTeam(target: KinTeamTarget) {
  const { environmentId, orgId } = target;
  const { peopleAtom, invitesAtom } = teamAtoms(target);
  const people = useAtomValue(peopleAtom);
  const invites = useAtomValue(invitesAtom);
  const host = useKinHostAt(environmentId);
  const { personId } = kinFeedViewer(
    host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null,
    orgId,
  );
  const heldPeople = Option.getOrNull(AsyncResult.value(people));
  const heldInvites = Option.getOrNull(AsyncResult.value(invites));
  const list: KinTeamList | null =
    heldPeople === null || heldInvites === null
      ? null
      : { people: heldPeople.people, joined: heldPeople.joined, invites: heldInvites.invites };
  return {
    list,
    failed: list === null && (AsyncResult.isFailure(people) || AsyncResult.isFailure(invites)),
    ownerPersonId: personId,
    refresh: () => void refreshKinTeam(target),
  };
}

/** The way in from the chat list, for the owner only. Its second line counts who has joined. */
export function KinTeamEntry(
  props: KinTeamTarget & { readonly active: boolean; readonly onOpen: () => void },
) {
  const allowed = useAtomValue(kinClient.inviteCreate.permissionAtom(props.environmentId));
  return allowed ? <PermittedTeamEntry {...props} /> : null;
}

function PermittedTeamEntry(
  props: KinTeamTarget & { readonly active: boolean; readonly onOpen: () => void },
) {
  const { environmentId, orgId } = props;
  const team = useKinTeam(props);
  // The host refused: this browser may hand out access but isn't the owner's.
  if (team.failed) return null;
  return (
    <Link
      to="/kin/$environmentId/$orgId/team"
      params={{ environmentId, orgId }}
      aria-current={props.active ? "page" : undefined}
      data-active={props.active}
      onClick={props.onOpen}
      className="flex items-center gap-2.5 rounded-md px-2 py-2 outline-none ring-ring hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-inset data-[active=true]:bg-sidebar-row-selected"
    >
      <span className="flex size-10 shrink-0 items-center justify-center text-sidebar-muted-foreground">
        <UsersIcon aria-hidden className="size-4.5" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-sidebar-foreground">
          {KIN_TEAM_TITLE}
        </span>
        <span className="truncate text-xs text-sidebar-muted-foreground">
          {kinTeamEntrySummary(team.list, team.ownerPersonId)}
        </span>
      </span>
    </Link>
  );
}

/** Who is on the team, whether each has joined, and the links that bring them in. */
export function KinTeamView(props: KinTeamTarget) {
  const allowed = useAtomValue(kinClient.inviteCreate.permissionAtom(props.environmentId));
  const [adding, setAdding] = useState(false);
  return (
    <>
      <WorkspacePageHeader electron={isElectron}>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Back to chats"
          className="md:hidden"
          render={<Link to="/kin" />}
        >
          <ArrowLeftIcon />
        </Button>
        <WorkspaceBreadcrumb ariaLabel={KIN_TEAM_TITLE}>
          <WorkspaceBreadcrumbItem current>
            <h1 className="truncate">{KIN_TEAM_TITLE}</h1>
          </WorkspaceBreadcrumbItem>
        </WorkspaceBreadcrumb>
        {allowed ? (
          <div className="ms-auto">
            <Button size="sm" onClick={() => setAdding(true)}>
              <UserPlusIcon />
              {KIN_TEAM_ADD}
            </Button>
          </div>
        ) : null}
      </WorkspacePageHeader>
      {allowed ? (
        <KinTeamBody {...props} adding={adding} setAdding={setAdding} />
      ) : (
        <Empty size="compact">
          <EmptyHeader>
            <EmptyTitle>{KIN_TEAM_ONLY_OWNER.title}</EmptyTitle>
            <EmptyDescription>{KIN_TEAM_ONLY_OWNER.detail}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </>
  );
}

function KinTeamBody(
  props: KinTeamTarget & {
    readonly adding: boolean;
    readonly setAdding: (adding: boolean) => void;
  },
) {
  const { environmentId, orgId } = props;
  const team = useKinTeam(props);
  const createInvite = useAtomCommand(kinClient.inviteCreate, { reportFailure: false });
  const revokeInvite = useAtomCommand(kinClient.inviteCancel, { reportFailure: false });
  const removeAccess = useAtomCommand(kinClient.personRemoveAccess, { reportFailure: false });
  const [edits, setEdits] = useState(KIN_TEAM_NO_EDITS);
  const [actions] = useState(() =>
    createKinTeamActions({
      orgId,
      createInvite: (input) => createInvite({ environmentId, input }),
      revokeInvite: (input) => revokeInvite({ environmentId, input }),
      removeAccess: (input) => removeAccess({ environmentId, input }),
      update: setEdits,
      refresh: () => refreshKinTeam({ environmentId, orgId }),
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the team again when the owner returns to this window after sending a link, so "Joined" is current
  useEffect(() => {
    const reread = () => void refreshKinTeam({ environmentId, orgId });
    window.addEventListener("focus", reread);
    return () => window.removeEventListener("focus", reread);
  }, [environmentId, orgId]);
  // The link the host just made. Held here and nowhere else, and dropped when its dialog closes.
  const [made, setMade] = useState<KinInviteDialogState | null>(null);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const addRequested = useAtomValue(kinTeamAddRequestAtom);
  const dialog: KinInviteDialogState | null =
    made ?? (props.adding || addRequested ? { stage: "name" } : null);
  const closeDialog = () => {
    setMade(null);
    props.setAdding(false);
    appAtomRegistry.set(kinTeamAddRequestAtom, false);
  };

  const { list } = team;
  if (list === null) {
    return team.failed ? (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-3 p-4">
        <Alert variant="error">
          <AlertDescription>{KIN_TEAM_LOAD_FAILED}. Check your connection.</AlertDescription>
        </Alert>
        <Button size="sm" variant="outline" onClick={team.refresh}>
          Retry
        </Button>
      </div>
    ) : (
      <div
        className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4"
        role="status"
        aria-label="Loading your team"
      >
        {[0, 1, 2].map((index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="size-9" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  const rows = kinTeamView(list, edits, team.ownerPersonId);
  const open = rows.find((row) => row.key === openKey) ?? null;
  const alone = rows.every((row) => row.state === "you");
  return (
    <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
        {edits.problem === null ? null : (
          <Alert variant="error">
            <AlertDescription>{edits.problem}</AlertDescription>
          </Alert>
        )}
        {alone ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>{KIN_TEAM_EMPTY.title}</EmptyTitle>
              <EmptyDescription>{KIN_TEAM_EMPTY.detail}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => props.setAdding(true)}>
                <UserPlusIcon />
                {KIN_TEAM_ADD}
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <ul className="flex flex-col">
            {rows.map((row) => (
              <li key={row.key} className="border-b border-border/60 last:border-b-0">
                <KinTeamRow row={row} onOpen={() => setOpenKey(row.key)} />
              </li>
            ))}
          </ul>
        )}
        <KinVisualHosts environmentId={environmentId} orgId={orgId} />
      </div>
      {open === null ? null : (
        <KinTeammateSheet
          teammate={open}
          environmentId={environmentId}
          orgId={orgId}
          actions={actions}
          onMade={(invite) => {
            setOpenKey(null);
            setMade({ stage: "link", invite });
          }}
          onClose={() => setOpenKey(null)}
        />
      )}
      {dialog === null ? null : (
        <KinInviteDialog
          state={dialog}
          environmentId={environmentId}
          actions={actions}
          onMade={(invite) => setMade({ stage: "link", invite })}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}

function KinTeamRow(props: { readonly row: KinTeammate; readonly onOpen: () => void }) {
  const { row } = props;
  const text = (
    <>
      <KinAvatar avatar={row.avatar} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">{row.name}</span>
        <span className="text-xs text-muted-foreground">{row.detail}</span>
      </span>
    </>
  );
  if (row.state === "you") return <div className="flex items-center gap-3 px-2 py-3">{text}</div>;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex w-full items-center gap-3 rounded-md px-2 py-3 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
    >
      {text}
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}

function Section(props: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      {props.children}
    </section>
  );
}

/** One teammate: which leads they can message, their link, and the way to take access away. */
function KinTeammateSheet(props: {
  readonly teammate: KinTeammate;
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly actions: KinTeamActions;
  readonly onMade: (invite: KinMadeInvite) => void;
  readonly onClose: () => void;
}) {
  const { teammate, actions } = props;
  const offered = kinTeammateActions(teammate);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const removal = kinRemoveAccessCopy(teammate.name);

  const makeLink = async () => {
    if (busy) return;
    setBusy(true);
    setProblem(null);
    const made = await actions.makeLink({
      displayName: teammate.name,
      personId: teammate.personId,
      replaces: teammate.inviteId,
    });
    setBusy(false);
    if (made.ok) props.onMade(made.invite);
    else setProblem(made.problem);
  };

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !busy) props.onClose();
      }}
    >
      <SheetPopup side="right">
        <SheetHeader>
          <div className="flex items-center gap-3 pe-8">
            <KinAvatar avatar={teammate.avatar} />
            <div className="flex min-w-0 flex-col">
              <SheetTitle>{teammate.name}</SheetTitle>
              <SheetDescription>{teammate.detail}</SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
          <Section title="Agents">
            {teammate.personId === null ? (
              <p className="text-sm text-muted-foreground">
                Once {teammate.name} joins, open an agent's details to let them message it.
              </p>
            ) : (
              <KinTeammateLeads
                personId={teammate.personId}
                name={teammate.name}
                environmentId={props.environmentId}
                orgId={props.orgId}
              />
            )}
          </Section>
          {offered.link === null ? null : (
            <Section title="Invite link">
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={busy}
                aria-busy={busy}
                onClick={() => void makeLink()}
              >
                {offered.link.label}
              </Button>
              <p className="text-xs text-muted-foreground">{offered.link.hint}</p>
              {offered.cancel === null ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  className="self-start"
                  disabled={busy}
                  onClick={() => {
                    if (teammate.inviteId === null) return;
                    // Shown at once; the page says so if the host refuses.
                    void actions.cancelInvite(teammate.inviteId);
                    if (teammate.personId === null) props.onClose();
                  }}
                >
                  {offered.cancel.label}
                </Button>
              )}
              {problem === null ? null : (
                <p role="alert" className="text-xs text-destructive-foreground">
                  {problem}
                </p>
              )}
            </Section>
          )}
          {offered.remove && teammate.personId !== null ? (
            <Section title="Access">
              <Button
                size="sm"
                variant="destructive-outline"
                className="self-start"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                {removal.confirm}
              </Button>
            </Section>
          ) : null}
        </div>
      </SheetPopup>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{removal.title}</AlertDialogTitle>
            <AlertDialogDescription>{removal.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false);
                if (teammate.personId !== null) void actions.removeAccess(teammate.personId);
              }}
            >
              {removal.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Sheet>
  );
}

/** The owner's leads and whether this person can message each. A lead's own details change it. */
function KinTeammateLeads(props: {
  readonly personId: KinPersonId;
  readonly name: string;
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const { environmentId, orgId } = props;
  const result = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const leads = Option.getOrNull(AsyncResult.value(result))?.leads ?? null;
  if (leads === null) {
    return (
      <p className="text-sm text-muted-foreground">
        {AsyncResult.isFailure(result) ? "Couldn't load your agents." : "Loading…"}
      </p>
    );
  }
  if (leads.length === 0) {
    return <p className="text-sm text-muted-foreground">You have no agents yet.</p>;
  }
  return (
    <>
      <ul className="flex flex-col">
        {leads.map((lead) => (
          <li key={lead.agentId}>
            <KinTeammateLead lead={lead} personId={props.personId} environmentId={environmentId} />
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Open an agent to change whether {props.name} can message it.
      </p>
    </>
  );
}

function KinTeammateLead(props: {
  readonly lead: KinLeadProfile;
  readonly personId: KinPersonId;
  readonly environmentId: EnvironmentId;
}) {
  const { lead, environmentId } = props;
  const navigate = useNavigate();
  const access = useAtomValue(
    kinClient.leadAccess({ environmentId, input: { orgId: lead.orgId, agentId: lead.agentId } }),
  );
  const people = Option.getOrNull(AsyncResult.value(access))?.people ?? null;
  const allowed =
    people === null ? null : people.some((person) => person.personId === props.personId);
  return (
    <button
      type="button"
      onClick={() => {
        appAtomRegistry.set(kinProfileRequestAtom, lead.ownerChatId);
        void navigate({
          to: "/kin/$environmentId/$orgId/$chatId",
          params: { environmentId, orgId: lead.orgId, chatId: lead.ownerChatId },
        });
      }}
      className="flex min-h-9 w-full items-center gap-3 rounded-md px-1 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
    >
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{lead.name}</span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {people === null && AsyncResult.isFailure(access) ? "" : kinTeammateLeadLine(allowed)}
      </span>
      <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
