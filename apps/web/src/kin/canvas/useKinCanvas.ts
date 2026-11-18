import { useAtomValue } from "@effect/atom-react";
import { kinCanvasModel } from "@t3tools/client-runtime/kin/kinCanvasView";
import { KIN_WORK_DEFAULT_FILTER, type KinWorkFilter } from "@t3tools/client-runtime/kin/kinWork";
import { createKinWorkList } from "@t3tools/client-runtime/kin/kinWorkList";
import type { KinCanvasRead, KinRecord, KinRecordKey } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { kinClient, kinReads } from "../kinClient";
import { useKinNeedsRows } from "../KinNeedsYou";
import { useNowMinuteMs } from "../useKinClock";
import { useKinDocsList, useKinDocsLive } from "../useKinDocs";
import { useKinMyDueTasks } from "../useKinPlaces";
import {
  kinSchedule,
  kinWorkLiveAtom,
  useKinPagedList,
  useKinProjectsList,
  useKinWork,
  useKinWorkDirectory,
  type KinWorkTarget,
} from "../useKinWork";

/** Pages read per list at most: past this the canvas shows the first few hundred. */
const MAX_PAGES = 8;

function useAllTasks(target: KinWorkTarget, filter: KinWorkFilter, seq: number | null) {
  const { environmentId, orgId } = target;
  const paged = useKinPagedList<KinWorkFilter, KinRecord>(
    filter,
    (onChange) =>
      createKinWorkList({
        orgId,
        initial: filter,
        read: (input) =>
          kinClient.workList.run(appAtomRegistry, { environmentId, input: { ...input, limit: 100 } }),
        onChange,
        now: Date.now,
        hostFilters: () => true,
        schedule: kinSchedule,
        rows: () =>
          appAtomRegistry
            .get(kinWorkLiveAtom(target))
            .pipe(AsyncResult.value, Option.getOrNull)?.rows ?? null,
      }),
    seq,
  );
  const { state, list } = paged;
  const pages = Math.ceil(state.records.length / 100);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the next page from the host until the canvas holds every task, up to a cap
  useEffect(() => {
    if (state.more && !state.loadingMore && !state.moreFailed && pages < MAX_PAGES)
      void list.loadMore();
  }, [list, state.more, state.loadingMore, state.moreFailed, pages]);
  return state;
}

function useAllDocs(target: KinWorkTarget, seq: number | null, enabled: boolean) {
  const { state, list } = useKinDocsList(target, enabled ? seq : null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the next page of docs from the host until the canvas holds them all, up to a cap
  useEffect(() => {
    if (enabled && state.more && !state.loadingMore && !state.moreFailed && state.records.length < 400)
      void list.loadMore();
  }, [enabled, list, state.more, state.loadingMore, state.moreFailed, state.records.length]);
  return state;
}

const CLOSED: KinWorkFilter = { ...KIN_WORK_DEFAULT_FILTER, view: "closed" };

// Read only by a session that may read Work; others ask the host nothing.
const noCanvasAtom: Atom.Atom<AsyncResult.AsyncResult<KinCanvasRead, unknown>> = Atom.make(
  AsyncResult.initial(),
);

/** What the canvas shows for one company, every piece read through its own viewer-scoped read. */
export function useKinCanvas(target: KinWorkTarget) {
  const work = useKinWork(target);
  const ready = work._tag === "ready";
  const directory = useKinWorkDirectory(target, ready);
  const seq = work._tag === "ready" ? work.live.seq : null;
  const open = useAllTasks(target, KIN_WORK_DEFAULT_FILTER, seq);
  const closed = useAllTasks(target, CLOSED, seq);
  const docsLive = useKinDocsLive(target);
  const docs = useAllDocs(target, docsLive.live?.seq ?? null, !docsLive.refused);
  const projects = useKinProjectsList(target, seq);
  const canvasResult = useAtomValue(
    ready ? kinClient.canvasLive({ environmentId: target.environmentId, input: { orgId: target.orgId } }) : noCanvasAtom,
  );
  const canvas: KinCanvasRead | null = Option.getOrNull(AsyncResult.value(canvasResult));
  const canvasFailed = AsyncResult.isFailure(canvasResult) && canvas === null;
  const mine = useKinMyDueTasks(target, directory.names.me, seq);
  const needsRows = useKinNeedsRows({ ...target, names: directory.names }, ready ? mine : null);
  const leadsResult = useAtomValue(
    kinReads.askLeads(target, false),
  );
  const leads = (Option.getOrNull(AsyncResult.value(leadsResult))?.leads ?? []).filter(
    (lead) => lead.retired === undefined,
  );
  const nowMs = useNowMinuteMs();

  const needsYou = new Set<string>();
  for (const row of needsRows?.needs ?? []) if (row.open.type === "task") needsYou.add(row.open.key);
  for (const row of needsRows?.attention ?? [])
    if (row.open.type === "record") needsYou.add(row.open.key);

  const model = kinCanvasModel({
    tasks: [...open.records, ...closed.records],
    docs: docs.records,
    projects: projects.state.records.map((project) => ({ key: project.key, title: project.name })),
    canvas,
    needsYou,
    names: directory.names,
    now: new Date(nowMs),
  });

  const loading = work._tag === "loading" || (open.loading && open.records.length === 0) || (canvas === null && !canvasFailed);
  return {
    work,
    model,
    canvas,
    canvasFailed,
    loading,
    names: directory.names,
    nowMs,
    needsRows,
    leads,
    stale: open.stale || closed.stale,
    retry: () => {
      appAtomRegistry.refresh(kinClient.canvasLive({ environmentId: target.environmentId, input: { orgId: target.orgId } }));
    },
  };
}

export type KinCanvasData = ReturnType<typeof useKinCanvas>;
export type KinCanvasCardKey = KinRecordKey | string;
