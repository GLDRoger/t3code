// @effect-diagnostics globalDate:off - React hooks read the clock outside an Effect runtime.
import type { EnvironmentId, KinRecord, KinWorkPrincipal } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect } from "react";

import {
  KIN_CANVAS,
  KIN_CANVAS_MAX_DOCS,
  KIN_CANVAS_MAX_TASKS,
  kinCanvasModel,
} from "../kinCanvasView.ts";
import { kinHostLink, type KinRouteHost } from "../kinHost.ts";
import type { KinScreenTarget } from "../kinScreenReads.ts";
import { KIN_WORK_DEFAULT_FILTER, kinWorkHostEdits, type KinWorkFilter } from "../kinWork.ts";
import { createKinWorkList, kinListShown } from "../kinWorkList.ts";
import type { KinDocsHooks } from "./kinDocsHooks.ts";
import type { KinHookApp } from "./kinHookApp.ts";
import { kinSchedule, type KinWorkHooks } from "./kinWorkHooks.ts";

/** Which tasks the map shows: those in progress, or everything open. */
export type KinCanvasTasks = "doing" | "open";

/** The app's own hooks the map reads through. */
export interface KinCanvasUses {
  readonly work: Pick<
    KinWorkHooks,
    | "useKinWork"
    | "useKinWorkDirectory"
    | "useKinPagedList"
    | "useKinProjectsList"
    | "kinWorkLiveAtom"
  >;
  readonly docs: Pick<KinDocsHooks, "useKinDocsLive" | "useKinDocsList">;
  readonly useKinHostAt: (environmentId: EnvironmentId) => KinRouteHost;
  readonly useNowMinuteMs: () => number;
}

const TASK_PAGE = 100;
const MAX_PROJECTS = 300;

const tasksFilter = (view: KinCanvasTasks): KinWorkFilter => ({ ...KIN_WORK_DEFAULT_FILTER, view });

/** A paged list read on until it holds `cap` rows or the host has no more. */
function useReadUpTo(
  state: {
    readonly records: ReadonlyArray<unknown>;
    readonly more: boolean;
    readonly loadingMore: boolean;
    readonly moreFailed: boolean;
  },
  loadMore: () => Promise<unknown>,
  cap: number,
  enabled: boolean,
) {
  const { more, loadingMore, moreFailed } = state;
  const count = state.records.length;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the host for the next page until the map holds what it shows, up to its cap
  useEffect(() => {
    if (enabled && more && !loadingMore && !moreFailed && count < cap) void loadMore();
  }, [enabled, more, loadingMore, moreFailed, count, cap, loadMore]);
}

/** The Docs map's rows for one company, on one app's client. */
export function makeKinCanvasHooks<R, ER>(app: KinHookApp<R, ER>, uses: KinCanvasUses) {
  const { kinClient, registry } = app;
  const { work, docs } = uses;

  function useMapTasks(target: KinScreenTarget, seq: number | null, enabled: boolean) {
    const { environmentId, orgId } = target;
    const live = () =>
      registry.get(work.kinWorkLiveAtom(target)).pipe(AsyncResult.value, Option.getOrNull);
    const paged = work.useKinPagedList<KinWorkFilter, KinRecord>(
      tasksFilter("doing"),
      (onChange) =>
        createKinWorkList({
          orgId,
          initial: tasksFilter("doing"),
          read: (input) =>
            kinClient.workList.run(registry, {
              environmentId,
              input: { ...input, limit: TASK_PAGE },
            }),
          onChange,
          now: Date.now,
          hostFilters: () => kinWorkHostEdits(live()?.summary ?? null),
          schedule: kinSchedule,
          rows: () => live()?.rows ?? null,
        }),
      enabled ? seq : null,
    );
    useReadUpTo(paged.state, paged.list.loadMore, KIN_CANVAS_MAX_TASKS, enabled);
    return paged;
  }

  /**
   * What the Docs map shows for one company: tasks from Work's own list, docs from Docs' own list,
   * project lines from the projects list. Each is read as this viewer, and kept current by the live
   * change numbers those screens already follow; the map reads nothing a list wouldn't.
   */
  function useKinCanvas(target: KinScreenTarget) {
    const workState = work.useKinWork(target);
    const tasksAllowed = workState._tag === "ready";
    const seq = tasksAllowed ? workState.live.seq : null;
    const directory = work.useKinWorkDirectory(target, tasksAllowed);
    const docsLive = docs.useKinDocsLive(target);
    const docsAllowed = !docsLive.refused;
    const tasks = useMapTasks(target, seq, tasksAllowed);
    const docRead = docs.useKinDocsList(target, docsAllowed ? (docsLive.live?.seq ?? null) : null);
    useReadUpTo(docRead.state, docRead.list.loadMore, KIN_CANVAS_MAX_DOCS, docsAllowed);
    const projects = work.useKinProjectsList(target, seq);
    useReadUpTo(projects.state, projects.list.loadMore, MAX_PROJECTS, tasksAllowed);
    const link = kinHostLink(uses.useKinHostAt(target.environmentId));
    const nowMs = uses.useNowMinuteMs();

    const view: KinCanvasTasks = tasks.state.filter.view === "open" ? "open" : "doing";
    const taskRows = tasksAllowed ? tasks.state.records.slice(0, KIN_CANVAS_MAX_TASKS) : [];
    const docRows = docsAllowed ? docRead.state.records.slice(0, KIN_CANVAS_MAX_DOCS) : [];
    const model = kinCanvasModel({
      tasks: taskRows,
      docs: docRows,
      projects: tasksAllowed ? projects.state.records : [],
      names: directory.names,
      now: new Date(nowMs),
    });
    const holders = new Map<string, KinWorkPrincipal>(taskRows.map((row) => [row.key, row.owner]));

    const summary = tasksAllowed ? workState.live.summary : null;
    const partial: string[] = [];
    if (tasksAllowed && tasks.state.more && tasks.state.records.length >= KIN_CANVAS_MAX_TASKS)
      partial.push(
        KIN_CANVAS.partial(
          taskRows.length,
          summary === null ? null : view === "open" ? summary.open : summary.doing,
          view === "open" ? "open tasks" : "tasks in progress",
        ),
      );
    if (docsAllowed && docRead.state.more && docRead.state.records.length >= KIN_CANVAS_MAX_DOCS)
      partial.push(KIN_CANVAS.partial(docRows.length, null, "docs"));

    const sources = [
      tasksAllowed
        ? kinListShown(tasks.state, link)
        : workState._tag === "offline" || workState._tag === "failed"
          ? workState._tag
          : "rows",
      docsAllowed ? kinListShown(docRead.state, link) : "rows",
    ];
    const status: "refused" | "loading" | "offline" | "failed" | "ready" =
      workState._tag === "refused" && !docsAllowed
        ? "refused"
        : workState._tag === "loading" || sources.includes("loading")
          ? "loading"
          : sources.includes("offline")
            ? "offline"
            : sources.includes("failed") && model.items.length === 0
              ? "failed"
              : "ready";

    return {
      status,
      /** This viewer reads Work, so tasks are on the map. */
      tasks: tasksAllowed,
      model,
      holders,
      view,
      partial,
      stale: tasks.state.stale || docRead.state.stale,
      setView: (next: KinCanvasTasks) => tasks.list.setFilter(tasksFilter(next)),
      retry: () => {
        if (workState._tag === "failed") registry.refresh(work.kinWorkLiveAtom(target));
        if (tasks.state.failed !== null) tasks.list.refresh();
        if (docRead.state.failed !== null) docRead.list.refresh();
      },
    };
  }

  return { useKinCanvas };
}

export type KinCanvasData = ReturnType<ReturnType<typeof makeKinCanvasHooks>["useKinCanvas"]>;
