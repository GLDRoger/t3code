import { useAtomValue } from "@effect/atom-react";
import {
  KIN_AGENT_PAGE,
  kinAgentModelLine,
  kinAgentPageCan,
  kinAgentQuietLine,
  kinAgentRewriteStarter,
  kinAgentUsageLine,
} from "@t3tools/client-runtime/kin/kinAgentPage";
import { kinAccessMeAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { kinRestoreCopy, kinRetiredWhen } from "@t3tools/client-runtime/kin/kinAgentRetire";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinDocMarkdown } from "@t3tools/client-runtime/kin/kinChatFeed";
import { kinCheckInLine } from "@t3tools/client-runtime/kin/kinCheckIns";
import {
  kinDomainLabel,
  kinLeadModelName,
  kinLeadOwnerSeesLine,
  kinLeadTrackingDetail,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { kinAgentAvatar } from "@t3tools/client-runtime/kin/kinScreenState";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  KinOrgId,
  type EnvironmentId,
  type KinAgentId,
  type KinAgentPage,
  type KinChatId,
  type KinLeadProfile,
  type ModelSelection,
} from "@t3tools/contracts";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { Textarea } from "../components/ui/textarea";
import { connectionAtomRuntime } from "../connection/runtime";
import { isChatOnlySession } from "../environments/primary";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinRestoreAgent, KinRetireAgent } from "./KinAgentRetire";
import { KinAgentModelPicker, useKinAgentModels } from "./KinAgentModelPicker";
import { KinAvatar } from "./KinAvatar";
import { prefillKinDraft } from "./KinChatView";
import { kinClient, refreshKinAgents } from "./kinClient";
import { KinAgentSection, KinLeadAccess } from "./KinLeadAccess";
import { kinLeadFormAtom } from "./kinLeadForm";
import { KIN_PLACE_PATH, withKinAgentPage } from "./kinPlaces";
import { KinLoadFailed } from "./KinWorkParts";
import { useKinOwnerLevel } from "./useKinOwnerLevel";
import { useNowMinuteMs } from "./useKinClock";

export interface KinAgentPageTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
}

/**
 * Opens an agent's page at its own address: over the Kin page the person is on, or from outside
 * Kin (Settings, the command palette) over the agent's own chat.
 */
export function useOpenKinAgentPage() {
  const navigate = useNavigate();
  const params = useParams({ strict: false });
  return (target: KinAgentPageTarget & { readonly chatId: KinChatId }) =>
    params.environmentId === target.environmentId && params.orgId === target.orgId
      ? navigate({ to: ".", search: (prev) => withKinAgentPage(prev, target.agentId) })
      : navigate({
          to: "/kin/$environmentId/$orgId/$chatId",
          params: {
            environmentId: target.environmentId,
            orgId: target.orgId,
            chatId: target.chatId,
          },
          search: { agent: target.agentId },
        });
}

/** Who the viewer is to an agent's page; the host decides again on every read and write. */
function useKinAgentPageCan(environmentId: EnvironmentId) {
  const ownerLevel = useKinOwnerLevel(environmentId);
  const me = useAtomValue(kinAccessMeAtom(connectionAtomRuntime, environmentId));
  return kinAgentPageCan({
    access: ownerLevel ? (me?.access === "co_owner" ? "co_owner" : "owner") : (me?.access ?? null),
    leadsAProject: (me?.leads?.length ?? 0) > 0,
  });
}

/** Mounted once on Kin's page, like the lead form. */
export function KinAgentPageHost() {
  const { agent } = useSearch({ from: "/_chat/kin" });
  const params = useParams({ strict: false });
  if (agent === undefined || params.environmentId === undefined || params.orgId === undefined)
    return null;
  const target = {
    environmentId: params.environmentId as EnvironmentId,
    orgId: KinOrgId.make(params.orgId),
    agentId: agent,
  };
  return <KinAgentSheet key={agent} target={target} />;
}

function KinAgentSheet(props: { readonly target: KinAgentPageTarget }) {
  const { environmentId, orgId, agentId } = props.target;
  const navigate = useNavigate();
  const closePage = () =>
    void navigate({ to: ".", search: ({ agent: _closed, ...rest }) => rest, replace: true });
  const can = useKinAgentPageCan(environmentId);
  const leads = Option.getOrNull(
    AsyncResult.value(useAtomValue(kinClient.leads({ environmentId, input: { orgId } }))),
  );
  const own = leads?.leads.find((lead) => lead.agentId === agentId);
  const contact = leads?.contacts?.find((one) => one.agentId === agentId);
  const name = own?.name ?? contact?.name ?? "Agent";
  return (
    <Sheet open onOpenChange={(open) => (open ? undefined : closePage())}>
      <SheetPopup side="right">
        <SheetHeader>
          <div className="flex items-center gap-3 pe-8">
            <KinAvatar avatar={kinAgentAvatar(agentId)} />
            <div className="flex min-w-0 flex-col">
              <SheetTitle>{name}</SheetTitle>
              {own === undefined ? null : (
                <SheetDescription>{kinDomainLabel(own.domain)}</SheetDescription>
              )}
            </div>
          </div>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 pb-6">
          {can.card === "full" ? (
            <KinAgentDetails
              environmentId={environmentId}
              orgId={orgId}
              agentId={agentId}
              activeAgents={
                (leads?.leads ?? []).filter((lead) => lead.retired === undefined).length
              }
              personId={null}
              onClose={closePage}
            />
          ) : contact === undefined ? (
            <p className="text-sm text-muted-foreground">
              Only the owner and co-owners see this agent's details.
            </p>
          ) : (
            <KinAgentSection title="About">
              <p className="whitespace-pre-line text-sm text-foreground">
                {contact.intro.trim() === ""
                  ? `Message ${contact.name} here like a colleague.`
                  : contact.intro}
              </p>
              <p className="text-xs text-muted-foreground">
                {kinLeadOwnerSeesLine(contact.ownerName)}
              </p>
              <Button
                size="sm"
                variant="outline"
                className="self-start"
                render={
                  <Link
                    to="/kin/$environmentId/$orgId/$chatId"
                    params={{ environmentId, orgId, chatId: contact.chatId }}
                  />
                }
                onClick={closePage}
              >
                Message {contact.name}
              </Button>
            </KinAgentSection>
          )}
        </div>
      </SheetPopup>
    </Sheet>
  );
}

/**
 * Everything owner-level people see and change about one agent, read from the host's page:
 * what it does, its model, its character, when it speaks, who reaches it and what it reaches.
 */
export function KinAgentDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly agentId: KinAgentId;
  readonly activeAgents: number;
  readonly personId: string | null;
  readonly onClose: () => void;
}) {
  const { environmentId, orgId, agentId } = props;
  const pageAtom = kinClient.agentPage({ environmentId, input: { orgId, agentId } });
  const result = useAtomValue(pageAtom);
  // What was last read stays up while a change is read again.
  const page = Option.getOrNull(AsyncResult.value(result));
  if (page === null)
    return AsyncResult.isFailure(result) ? (
      <KinLoadFailed
        what="Couldn't load this agent"
        cause={result}
        onRetry={() => appAtomRegistry.refresh(pageAtom)}
      />
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );
  return (
    <AgentPageBody
      {...props}
      page={page}
      onChanged={() => {
        appAtomRegistry.refresh(pageAtom);
        refreshKinAgents(environmentId, orgId);
      }}
    />
  );
}

function AgentPageBody(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly page: KinAgentPage;
  readonly activeAgents: number;
  readonly personId: string | null;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}) {
  const { environmentId, orgId, page } = props;
  const lead = page.profile;
  const nowMs = useNowMinuteMs();
  const navigate = useNavigate();
  const retired = lead.retired !== undefined;
  const target = { environmentId, orgId, agentId: lead.agentId, name: lead.name };
  const canRestore = useAtomValue(kinClient.leadRestore.permissionAtom(environmentId));
  const canRetire = useAtomValue(kinClient.leadRetire.permissionAtom(environmentId));
  const canEdit = useAtomValue(kinClient.leadUpdate.permissionAtom(environmentId)) && !retired;
  const canShare = useAtomValue(kinClient.leadAllow.permissionAtom(environmentId)) && !retired;
  const canPause = useAtomValue(kinClient.leadPause.permissionAtom(environmentId)) && !retired;
  const pause = useAtomCommand(kinClient.leadPause, { reportFailure: false });
  const resume = useAtomCommand(kinClient.leadResume, { reportFailure: false });
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const setPaused = async (paused: boolean) => {
    setBusy(true);
    const input = { orgId, agentId: lead.agentId };
    const outcome = await (paused ? pause : resume)({ environmentId, input });
    setBusy(false);
    setProblem(
      AsyncResult.isFailure(outcome)
        ? kinFailureText(squashAtomCommandFailure(outcome), "Couldn't change that.")
        : null,
    );
    props.onChanged();
  };

  const openChatWith = (line: string) => {
    prefillKinDraft(environmentId, orgId, lead.ownerChatId, line);
    props.onClose();
    void navigate({
      to: "/kin/$environmentId/$orgId/$chatId",
      params: { environmentId, orgId, chatId: lead.ownerChatId },
    });
  };

  return (
    <>
      {retired ? (
        <KinAgentSection title="Retired">
          <p className="text-sm text-foreground">
            {canRestore
              ? `${kinRetiredWhen(lead.retired!.at, nowMs)}. ${kinRestoreCopy(lead.name).detail}`
              : `${lead.name} is retired, so it won't see new messages.`}
          </p>
          {canRestore ? (
            <div className="flex flex-col items-start gap-2">
              <KinRestoreAgent agent={target} />
            </div>
          ) : null}
        </KinAgentSection>
      ) : lead.paused === undefined ? null : (
        <Alert variant="info">
          <AlertDescription>{KIN_AGENT_PAGE.pausedLine(lead.name)}</AlertDescription>
        </Alert>
      )}
      <KinAgentSection
        title="Responsible for"
        action={
          canEdit ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                props.onClose();
                appAtomRegistry.set(kinLeadFormAtom, { environmentId, orgId, lead });
              }}
            >
              Edit agent
            </Button>
          ) : null
        }
      >
        <p className="whitespace-pre-line text-sm text-foreground">
          {lead.charter.trim() === "" ? "Nothing written yet." : lead.charter}
        </p>
        {(lead.intro ?? "").trim() === "" ? null : (
          <p className="text-xs text-muted-foreground">Teammates see: {lead.intro}</p>
        )}
      </KinAgentSection>
      <AgentModels {...props} retired={retired} />
      <AgentCharacter {...props} retired={retired} onRewrite={openChatWith} />
      <AgentCheckIns environmentId={environmentId} orgId={orgId} page={page} />
      {canShare ? (
        <KinLeadAccess lead={lead} environmentId={environmentId} personId={props.personId} />
      ) : null}
      <KinAgentSection
        title={KIN_AGENT_PAGE.teamAgent}
        action={
          <Button
            size="xs"
            variant="ghost"
            render={<Link to="/kin/$environmentId/$orgId/team" params={{ environmentId, orgId }} />}
            onClick={props.onClose}
          >
            Team
          </Button>
        }
      >
        <p className="text-sm text-foreground">
          {page.teamAgent
            ? KIN_AGENT_PAGE.teamAgentDetail
            : "Not the team agent. Only you and the people you add can message it."}
        </p>
      </KinAgentSection>
      <KinAgentSection
        title={KIN_AGENT_PAGE.reach}
        action={
          isChatOnlySession() ? null : (
            <Button
              size="xs"
              variant="ghost"
              render={<Link to="/settings/kin-connections" />}
              onClick={props.onClose}
            >
              Connections
            </Button>
          )
        }
      >
        {page.connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">{KIN_AGENT_PAGE.reachNone}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {page.connections.map((connection, index) => (
              // Labels can repeat and carry no id here; the host's order is stable.
              // oxlint-disable-next-line react/no-array-index-key
              <li key={index} className="text-sm text-foreground">
                {connection.label}
                {connection.account === null || connection.account === connection.label
                  ? ""
                  : ` · ${connection.account}`}
                {connection.paused ? " · paused" : ""}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">{KIN_AGENT_PAGE.reachDetail}</p>
      </KinAgentSection>
      <KinAgentSection title={KIN_AGENT_PAGE.playbooks}>
        {page.playbooks.length === 0 ? (
          <p className="text-sm text-muted-foreground">{KIN_AGENT_PAGE.playbooksNone}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {page.playbooks.map((playbook) => (
              <li key={playbook.key}>
                <Link
                  to={KIN_PLACE_PATH.docs}
                  params={{ environmentId, orgId }}
                  search={{ doc: playbook.key }}
                  onClick={props.onClose}
                  className="text-sm text-foreground underline-offset-4 hover:underline"
                >
                  {playbook.title}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </KinAgentSection>
      <AgentInHand
        lead={lead}
        environmentId={environmentId}
        orgId={orgId}
        onClose={props.onClose}
      />
      {canPause ? (
        <KinAgentSection title={lead.paused === undefined ? KIN_AGENT_PAGE.pause : "Paused"}>
          <p className="text-xs text-muted-foreground">{KIN_AGENT_PAGE.pauseDetail}</p>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            disabled={busy}
            onClick={() => void setPaused(lead.paused === undefined)}
          >
            {lead.paused === undefined ? KIN_AGENT_PAGE.pause : KIN_AGENT_PAGE.resume} {lead.name}
          </Button>
          {problem === null ? null : (
            <p role="alert" className="text-xs text-destructive-foreground">
              {problem}
            </p>
          )}
        </KinAgentSection>
      ) : null}
      {canRetire && !retired ? (
        <KinAgentSection title="Retire">
          <KinRetireAgent agent={target} activeAgents={props.activeAgents} />
        </KinAgentSection>
      ) : null}
    </>
  );
}

function AgentModels(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly page: KinAgentPage;
  readonly retired: boolean;
  readonly onChanged: () => void;
}) {
  const { environmentId, orgId, page } = props;
  const { providers } = useKinAgentModels(environmentId);
  const update = useAtomCommand(kinClient.leadUpdate, { reportFailure: false });
  const canEdit =
    useAtomValue(kinClient.leadUpdate.permissionAtom(environmentId)) && !props.retired;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const choose = async (role: "strong" | "cheap", selection: ModelSelection) => {
    setBusy(true);
    const outcome = await update({
      environmentId,
      input: {
        orgId,
        agentId: page.profile.agentId,
        models: { ...page.models, [role]: selection },
      },
    });
    setBusy(false);
    setProblem(
      AsyncResult.isFailure(outcome)
        ? kinFailureText(squashAtomCommandFailure(outcome), "Couldn't change the model.")
        : null,
    );
    props.onChanged();
  };
  return (
    <KinAgentSection title={KIN_AGENT_PAGE.model}>
      {(["strong", "cheap"] as const).map((role) => (
        <div key={role} className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-foreground">{KIN_AGENT_PAGE[role]}</span>
          {canEdit ? (
            <KinAgentModelPicker
              environmentId={environmentId}
              label={KIN_AGENT_PAGE[role]}
              selection={page.models[role]}
              disabled={busy}
              onChange={(selection) => void choose(role, selection)}
            />
          ) : (
            <span className="text-sm text-muted-foreground">
              {kinAgentModelLine(
                kinLeadModelName(page.models[role].model, providers),
                page.models[role],
              )}
            </span>
          )}
        </div>
      ))}
      {page.modelNote === null ? null : (
        <Alert variant="warning">
          <AlertDescription>
            {page.modelNote} Now: {kinLeadModelName(page.runsOn.strong.model, providers)} and{" "}
            {kinLeadModelName(page.runsOn.cheap.model, providers)}.
          </AlertDescription>
        </Alert>
      )}
      <p className="text-xs text-muted-foreground">{KIN_AGENT_PAGE.modelDetail}</p>
      <p className="text-xs text-muted-foreground">{kinAgentUsageLine(page.usedThisMonth)}</p>
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
    </KinAgentSection>
  );
}

function AgentCharacter(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly page: KinAgentPage;
  readonly retired: boolean;
  readonly onClose: () => void;
  readonly onChanged: () => void;
  readonly onRewrite: (line: string) => void;
}) {
  const { environmentId, orgId, page } = props;
  const { character } = page;
  const save = useAtomCommand(kinClient.characterSet, { reportFailure: false });
  const canSave = useAtomValue(kinClient.characterSet.permissionAtom(environmentId));
  const navigate = useNavigate();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const submit = async () => {
    if (draft === null || draft.trim() === "") return;
    setBusy(true);
    const outcome = await save({
      environmentId,
      input: { orgId, agentId: page.profile.agentId, body: draft },
    });
    setBusy(false);
    if (AsyncResult.isFailure(outcome)) {
      setProblem(kinFailureText(squashAtomCommandFailure(outcome), "Couldn't save the character."));
      return;
    }
    setProblem(null);
    setDraft(null);
    props.onChanged();
  };

  return (
    <KinAgentSection
      title={KIN_AGENT_PAGE.character}
      action={
        character !== null && draft === null ? (
          <div className="flex gap-1">
            {canSave && !props.retired ? (
              <Button size="xs" variant="ghost" onClick={() => setDraft(character.body)}>
                {KIN_AGENT_PAGE.editCharacter}
              </Button>
            ) : null}
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                props.onClose();
                void navigate({
                  to: KIN_PLACE_PATH.docs,
                  params: { environmentId, orgId },
                  search: { doc: character.key, history: true },
                });
              }}
            >
              {KIN_AGENT_PAGE.characterHistory}
            </Button>
          </div>
        ) : null
      }
    >
      {character === null ? (
        <p className="text-sm text-muted-foreground">{KIN_AGENT_PAGE.characterEmpty}</p>
      ) : draft === null ? (
        <div className="max-h-96 overflow-y-auto rounded-md border border-border px-3 py-2 text-sm">
          <ChatMarkdown
            text={kinDocMarkdown(character.body)}
            cwd={undefined}
            environmentId={environmentId}
          />
        </div>
      ) : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Textarea
            aria-label={`${page.profile.name}'s character`}
            rows={14}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || draft.trim() === ""}>
              Save character
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setProblem(null);
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      )}
      <p className="text-xs text-muted-foreground">{KIN_AGENT_PAGE.characterRule}</p>
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
      {props.retired ? null : (
        <Button
          size="sm"
          variant="outline"
          className="self-start"
          onClick={() => props.onRewrite(kinAgentRewriteStarter(page.profile.name))}
        >
          {KIN_AGENT_PAGE.rewrite}
        </Button>
      )}
    </KinAgentSection>
  );
}

function AgentCheckIns(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly page: KinAgentPage;
}) {
  const { environmentId, orgId, page } = props;
  const result = useAtomValue(kinClient.checkIns({ environmentId, input: { orgId } }));
  const checkIns = (Option.getOrNull(AsyncResult.value(result))?.checkIns ?? []).filter(
    (checkIn) => checkIn.agentId === page.profile.agentId,
  );
  return (
    <KinAgentSection
      title={KIN_AGENT_PAGE.checkIns}
      action={
        <Button
          size="xs"
          variant="ghost"
          render={
            isChatOnlySession() ? (
              <Link to="/kin/$environmentId/$orgId/settings" params={{ environmentId, orgId }} />
            ) : (
              <Link to="/settings/check-ins" />
            )
          }
        >
          Change
        </Button>
      }
    >
      {checkIns.length === 0 ? (
        <p className="text-sm text-muted-foreground">{KIN_AGENT_PAGE.checkInsNone}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {checkIns.map((checkIn) => (
            <li key={checkIn.scheduleId} className="flex flex-col">
              <span className="text-sm text-foreground">
                {checkIn.title}
                {checkIn.on ? "" : " (off)"}
              </span>
              <span className="text-xs text-muted-foreground">
                {kinCheckInLine(checkIn).replace(` · ${checkIn.agentName}`, "")}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{kinAgentQuietLine(page.quietHours)}</p>
    </KinAgentSection>
  );
}

function AgentInHand(props: {
  readonly lead: KinLeadProfile;
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly onClose: () => void;
}) {
  const { lead, environmentId, orgId } = props;
  const retired = lead.retired !== undefined;
  return (
    <KinAgentSection title={retired ? "On hold" : KIN_AGENT_PAGE.activity}>
      {lead.tracking.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {retired ? "Nothing is waiting on it." : "Nothing in hand right now."}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {lead.tracking.map((item, index) => (
            // Titles can repeat and items carry no id; the host's order is stable.
            // oxlint-disable-next-line react/no-array-index-key
            <li key={index} className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">{kinLeadTrackingDetail(item)}</span>
              {item.key === undefined ? (
                <span className="text-sm text-foreground">{item.title}</span>
              ) : (
                <Link
                  to={KIN_PLACE_PATH.tasks}
                  params={{ environmentId, orgId }}
                  search={{ task: item.key }}
                  onClick={props.onClose}
                  className="text-sm text-foreground underline-offset-4 hover:underline"
                >
                  {item.title}
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </KinAgentSection>
  );
}

const NO_AGENTS: ReadonlyArray<KinLeadProfile> = [];
const noAgentsAtom = Atom.make(NO_AGENTS).pipe(Atom.withLabel("kin:no-agents"));
const agentsOf = Atom.family((key: string) => {
  const [environmentId, orgId] = key.split("\n") as [EnvironmentId, KinOrgId];
  return Atom.make(
    (get) =>
      Option.getOrNull(AsyncResult.value(get(kinClient.leads({ environmentId, input: { orgId } }))))
        ?.leads ?? NO_AGENTS,
  ).pipe(Atom.withLabel("kin:palette-agents"));
});

/** The owner-level viewer's agents, for the command palette; none for anyone else. */
export function useKinPaletteAgents(
  target: { readonly environmentId: EnvironmentId; readonly orgId: KinOrgId } | null,
  ownerLevel: boolean,
): ReadonlyArray<KinLeadProfile> {
  return useAtomValue(
    target === null || !ownerLevel
      ? noAgentsAtom
      : agentsOf(`${target.environmentId}\n${target.orgId}`),
  );
}
