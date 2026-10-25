import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type {
  KinHouseLineHouseView,
  KinHouseLineLaneView,
  KinHouseLineReign,
  KinHouseLineSnapshot,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useEnvironmentQuery } from "../../state/query";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";

const SPLIT_PROMPT = `If this is big enough to need several agents, split it by codebase area and hand each part to a subagent with \`house\` set to its area (reuse names from lineage_areas). If it is small, just do it here.

What I want: `;

const LIVE_STATES = new Set<KinHouseLineLaneView["state"]>([
  "proposed",
  "running",
  "awaiting_will",
  "gated",
]);

const STATE_LABEL: Record<KinHouseLineLaneView["state"], string> = {
  proposed: "Proposed",
  running: "Working",
  awaiting_will: "Writing will",
  will_missing: "No will",
  gated: "Ready to crown",
  crowned: "Crowned",
  failed: "Failed",
};

/** Houses are codebase areas agents create as they delegate; this page shows their lines. */
export function HousesPage() {
  const projects = useProjects().filter((project) => project.isScratch !== true);
  const [emptyProjectKeys, setEmptyProjectKeys] = useState<ReadonlySet<string>>(new Set());
  const reportEmpty = (key: string, empty: boolean) =>
    setEmptyProjectKeys((current) => {
      if (current.has(key) === empty) return current;
      const next = new Set(current);
      if (empty) next.add(key);
      else next.delete(key);
      return next;
    });
  const allEmpty = projects.length > 0 && emptyProjectKeys.size === projects.length;

  return (
    <main className="h-full overflow-y-auto scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-8">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-medium">Houses</h1>
          <p className="max-w-xl text-sm text-muted-foreground">
            A house is an area of a project. When an agent finishes work there it is crowned and
            leaves a will, and the next agent in that area starts from it.
          </p>
        </header>
        {projects.length === 0 ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyTitle>Add a project first</EmptyTitle>
              <EmptyDescription>Houses live inside projects.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
        {allEmpty ? <NoHousesYet projects={projects} /> : null}
        {projects.map((project) => {
          const key = projectKey(project);
          return (
            <ProjectHouses
              key={key}
              project={project}
              hidden={emptyProjectKeys.has(key)}
              onEmpty={(empty) => reportEmpty(key, empty)}
            />
          );
        })}
        {!allEmpty && emptyProjectKeys.size > 0 ? (
          <p className="text-xs text-muted-foreground">
            {emptyProjectKeys.size === 1
              ? "1 more project has no houses yet."
              : `${emptyProjectKeys.size} more projects have no houses yet.`}
          </p>
        ) : null}
      </div>
    </main>
  );
}

function projectKey(project: EnvironmentProject) {
  return `${project.environmentId}:${project.id}`;
}

function NoHousesYet(props: { readonly projects: ReadonlyArray<EnvironmentProject> }) {
  const startThread = useStartSplitThread();
  const [projectKeyValue, setProjectKeyValue] = useState(() =>
    props.projects[0] === undefined ? "" : projectKey(props.projects[0]),
  );
  const project =
    props.projects.find((candidate) => projectKey(candidate) === projectKeyValue) ??
    props.projects[0];
  return (
    <div className="rounded-lg border border-dashed">
      <Empty size="compact">
        <EmptyHeader>
          <EmptyTitle>No houses yet</EmptyTitle>
          <EmptyDescription>
            Houses appear when an agent hands work to a subagent and names the area it is in. Start
            a thread and say what you want built. Big jobs get split into houses; small ones stay in
            the thread.
          </EmptyDescription>
        </EmptyHeader>
        {project === undefined ? null : (
          <div className="flex flex-wrap items-center justify-center gap-2">
            {props.projects.length > 1 ? (
              <select
                aria-label="Project"
                className="h-8 rounded-md border bg-background px-2 text-sm"
                value={projectKeyValue}
                onChange={(event) => setProjectKeyValue(event.target.value)}
              >
                {props.projects.map((candidate) => (
                  <option key={projectKey(candidate)} value={projectKey(candidate)}>
                    {candidate.title}
                  </option>
                ))}
              </select>
            ) : null}
            <Button size="sm" onClick={() => void startThread(project)}>
              Start a thread in {props.projects.length > 1 ? "this project" : project.title}
            </Button>
          </div>
        )}
      </Empty>
    </div>
  );
}

function useStartSplitThread() {
  const newThread = useNewThreadHandler();
  return async (project: EnvironmentProject) => {
    const created = await newThread(scopeProjectRef(project.environmentId, project.id));
    if (created === null) return;
    const { getComposerDraft, setPrompt } = useComposerDraftStore.getState();
    // Keep anything the user already typed into this project's draft.
    if ((getComposerDraft(created.draftId)?.prompt ?? "").trim().length === 0) {
      setPrompt(created.draftId, SPLIT_PROMPT);
    }
  };
}

function ProjectHouses(props: {
  readonly project: EnvironmentProject;
  readonly hidden: boolean;
  readonly onEmpty: (empty: boolean) => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.kinHouseLineSnapshot({
      environmentId: props.project.environmentId,
      input: { projectId: props.project.id },
    }),
  );
  const { onEmpty } = props;
  const empty = query.data !== null && query.data.houses.length === 0;
  useEffect(() => onEmpty(empty), [empty, onEmpty]);

  // Lanes change while agents work; refetch whenever the user comes back to the page.
  const { refresh } = query;
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  if (props.hidden) return null;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">{props.project.title}</h2>
      {query.isPending && query.data === null ? (
        <p className="text-sm text-muted-foreground">Loading houses…</p>
      ) : null}
      {query.error !== null ? (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <span>Couldn't load houses: {query.error}</span>
          <Button size="xs" variant="outline" onClick={() => refresh()}>
            Retry
          </Button>
        </div>
      ) : null}
      {query.data === null ? null : (
        <div className="flex flex-col divide-y rounded-lg border">
          {sortHouses(query.data).map((house) => (
            <HouseRow
              key={house.id}
              environmentId={props.project.environmentId}
              house={house}
              lanes={query.data?.lanes.filter((lane) => lane.houseName === house.name) ?? []}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/** Houses with live work first, then the most recently crowned. */
function sortHouses(snapshot: KinHouseLineSnapshot) {
  const live = new Set(
    snapshot.lanes.filter((lane) => LIVE_STATES.has(lane.state)).map((lane) => lane.houseName),
  );
  const latest = (house: KinHouseLineHouseView) => house.reigns.at(-1)?.at ?? "";
  return snapshot.houses.toSorted(
    (left, right) =>
      Number(live.has(right.name)) - Number(live.has(left.name)) ||
      latest(right).localeCompare(latest(left)) ||
      left.name.localeCompare(right.name),
  );
}

function HouseRow(props: {
  readonly environmentId: EnvironmentProject["environmentId"];
  readonly house: KinHouseLineHouseView;
  readonly lanes: ReadonlyArray<KinHouseLineLaneView>;
}) {
  const reigns = props.house.reigns.toSorted(
    (left, right) => right.regnalNumber - left.regnalNumber,
  );
  const current = reigns[0];
  const earlier = reigns.slice(1);
  const live = props.lanes.filter((lane) => LIVE_STATES.has(lane.state));
  const stuck = props.lanes.filter(
    (lane) => lane.state === "will_missing" || lane.state === "failed",
  );
  return (
    <article className="flex flex-col gap-3 p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="truncate font-medium">{props.house.name}</h3>
        <span className="shrink-0 text-xs text-muted-foreground">
          {current === undefined
            ? "No reign yet"
            : `${current.regnalLabel} · ${formatRelativeTimeLabel(current.at)}`}
        </span>
      </div>
      {[...live, ...stuck].length > 0 ? (
        <ul className="flex flex-col gap-1">
          {[...live, ...stuck].map((lane) => (
            <li key={lane.id} className="flex items-center justify-between gap-3 text-sm">
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId: props.environmentId, threadId: lane.threadId }}
                className="min-w-0 truncate hover:underline"
              >
                {lane.label}
              </Link>
              <span
                className={
                  lane.state === "failed" || lane.state === "will_missing"
                    ? "shrink-0 text-xs text-destructive"
                    : "shrink-0 text-xs text-muted-foreground"
                }
              >
                {STATE_LABEL[lane.state]}
                {lane.reportMismatch ? " · reads mismatch" : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {current === undefined ? (
        live.length === 0 ? (
          <p className="text-sm text-muted-foreground">No agent has finished work here yet.</p>
        ) : null
      ) : (
        <Will environmentId={props.environmentId} reign={current} />
      )}
      {earlier.length > 0 ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            {earlier.length === 1 ? "1 earlier reign" : `${earlier.length} earlier reigns`}
          </summary>
          <div className="mt-2 flex flex-col gap-3">
            {earlier.map((reign) => (
              <Will key={reign.crowningId} environmentId={props.environmentId} reign={reign} />
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

function Will(props: {
  readonly environmentId: EnvironmentProject["environmentId"];
  readonly reign: KinHouseLineReign;
}) {
  const [expanded, setExpanded] = useState(false);
  const { reign } = props;
  const byline = [reign.regnalLabel, reign.model || reign.provider, reign.profile]
    .filter((part) => part.length > 0)
    .join(" · ");
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span className="truncate">{byline}</span>
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId: props.environmentId, threadId: reign.threadId }}
          className="shrink-0 hover:underline"
        >
          Open thread
        </Link>
      </div>
      {reign.willBody === null ? (
        <p className="text-sm text-muted-foreground">Crowned without a will.</p>
      ) : (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className={`whitespace-pre-wrap text-left text-sm ${expanded ? "" : "line-clamp-3"}`}
        >
          {reign.willBody}
        </button>
      )}
    </div>
  );
}
