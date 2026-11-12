import { useAtomValue } from "@effect/atom-react";
import {
  KIN_DOCS_DEFAULT_FILTER,
  KIN_SEARCH_INITIAL,
  createKinSearch,
  kinDocsQuery,
  kinDocsSameFilter,
  type KinDocsFilter,
  type KinSearchState,
} from "@t3tools/client-runtime/kin/kinDocs";
import type { KinDocsLive } from "@t3tools/client-runtime/kin/kinDocsStream";
import { kinWorkFailuresOf, kinWorkRefused } from "@t3tools/client-runtime/kin/kinWork";
import { createKinWorkItemWatch } from "@t3tools/client-runtime/kin/kinWorkChanges";
import { kinWorkReadState } from "@t3tools/client-runtime/kin/kinWorkForms";
import { createKinPagedList, mapPage } from "@t3tools/client-runtime/kin/kinWorkList";
import type {
  KinDocDetail,
  KinDocRow,
  KinDocVersion,
  KinDocsListResult,
  KinRecordKey,
  KinSearchKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../../../state/atom-registry";
import { kinClient } from "./kinClient";
import { kinSchedule, useKinPagedList, type KinWorkTarget } from "./useKinWork";

const noLiveAtom: Atom.Atom<AsyncResult.AsyncResult<KinDocsLive, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noDocsAtom: Atom.Atom<AsyncResult.AsyncResult<KinDocsListResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);

const docsLiveAtom = ({ environmentId, orgId }: KinWorkTarget) =>
  kinClient.docsLive({ environmentId, input: { orgId } });

/** Docs' change number, and whether the host lets this viewer read docs at all. */
export function useKinDocsLive(target: KinWorkTarget) {
  const allowed = useAtomValue(kinClient.docsList.permissionAtom(target.environmentId));
  const result = useAtomValue(allowed ? docsLiveAtom(target) : noLiveAtom);
  const refused =
    !allowed ||
    (AsyncResult.isFailure(result) && kinWorkFailuresOf(result.cause).some(kinWorkRefused));
  return { refused, live: Option.getOrNull(AsyncResult.value(result)) };
}

/** Every doc, or the archived ones, latest change first, a page at a time. */
export function useKinDocsList({ environmentId, orgId }: KinWorkTarget, seq: number | null) {
  return useKinPagedList<KinDocsFilter, KinDocRow>(
    KIN_DOCS_DEFAULT_FILTER,
    (onChange) =>
      createKinPagedList({
        initial: KIN_DOCS_DEFAULT_FILTER,
        sameFilter: kinDocsSameFilter,
        idOf: (row) => row.recordId,
        onChange,
        schedule: kinSchedule,
        read: async (filter, page) =>
          mapPage(
            await kinClient.docsList.run(appAtomRegistry, {
              environmentId,
              input: { ...kinDocsQuery(orgId, filter), ...page },
            }),
            (value) => ({ ...value, rows: value.docs }),
          ),
      }),
    seq,
  );
}

/** The docs linked to one client or project, read again when any doc changes. */
export function useKinDocsUnder(
  target: KinWorkTarget,
  under: { readonly party: KinRecordKey } | { readonly project: KinRecordKey },
) {
  const { refused, live } = useKinDocsLive(target);
  const atom = kinClient.docsUnder({
    environmentId: target.environmentId,
    input: { orgId: target.orgId, limit: 100, ...under },
  });
  const result = useAtomValue(refused ? noDocsAtom : atom);
  const held = Option.getOrNull(AsyncResult.value(result));
  const behind = held !== null && live !== null && live.seq > held.seq;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the linked docs from the host again when the host announces a doc changed
  useEffect(() => {
    if (behind) appAtomRegistry.refresh(atom);
  }, [behind, atom]);
  return held?.docs ?? null;
}

/** One doc at a version, kept current when the host says it changed. */
export function useKinDoc(target: KinWorkTarget, key: KinRecordKey, version: number | null) {
  const { environmentId, orgId } = target;
  const atom = kinClient.doc({
    environmentId,
    input: { orgId, key, ...(version === null ? {} : { version }) },
  });
  const state = kinWorkReadState<KinDocDetail>(useAtomValue(atom));
  const { live } = useKinDocsLive(target);
  const [watch] = useState(() =>
    createKinWorkItemWatch({ key, reread: () => appAtomRegistry.refresh(atom) }),
  );
  const named = live?.changed[key] ?? 0;
  const unnamed = live?.unnamed ?? 0;
  const heldSeq = state._tag === "ready" ? state.value.seq : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the open doc from the host again when the host announces a change to it
  useEffect(() => {
    if (live === null) return;
    watch.changed(
      { changed: { [key]: named }, unnamed },
      heldSeq === null ? null : { seq: heldSeq },
    );
  }, [watch, key, live, named, unnamed, heldSeq]);
  return { state, refresh: () => appAtomRegistry.refresh(atom) };
}

const NO_WORDS = { text: "" };

/** A doc's versions, newest first, read again when the doc changes. */
export function useKinDocHistory(
  { environmentId, orgId }: KinWorkTarget,
  key: KinRecordKey,
  seq: number | null,
) {
  return useKinPagedList<typeof NO_WORDS, KinDocVersion>(
    NO_WORDS,
    (onChange) =>
      createKinPagedList({
        initial: NO_WORDS,
        sameFilter: () => true,
        idOf: (version) => String(version.version),
        onChange,
        schedule: kinSchedule,
        read: async (_filter, page) =>
          mapPage(
            await kinClient.docHistory.run(appAtomRegistry, {
              environmentId,
              input: { orgId, key, ...page },
            }),
            (value) => ({ ...value, rows: value.versions, total: value.versions.length }),
          ),
      }),
    seq,
  );
}

/** One search box over Work: every kind, or only the ones named. */
export function useKinSearch(
  { environmentId, orgId }: KinWorkTarget,
  kinds: ReadonlyArray<KinSearchKind> | null,
) {
  const [state, setState] = useState<KinSearchState>(KIN_SEARCH_INITIAL);
  const [search] = useState(() =>
    createKinSearch({
      onChange: setState,
      schedule: kinSchedule,
      read: ({ text, closed }) =>
        kinClient.search.run(appAtomRegistry, {
          environmentId,
          input: { orgId, text, closed, ...(kinds === null ? {} : { kinds }) },
        }),
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons the search in flight when its box leaves the screen
  useEffect(() => search.dispose, [search]);
  return { state, search };
}
