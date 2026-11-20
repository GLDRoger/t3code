import { useAtomValue } from "@effect/atom-react";
import type {
  KinDocDetail,
  KinDocListRow,
  KinDocVersion,
  KinDocsListResult,
  KinRecordKey,
  KinSearchKind,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import {
  KIN_DOCS_DEFAULT_FILTER,
  KIN_SEARCH_INITIAL,
  createKinSearch,
  kinDocsQuery,
  kinDocsSameFilter,
  kinWhatWeSellAgent,
  kinWhatWeSellQuery,
  type KinDocsFilter,
  type KinSearchState,
} from "../kinDocs.ts";
import { type KinDocsLive, kinDocsPageFollower } from "../kinDocsStream.ts";
import type { KinScreenTarget } from "../kinScreenReads.ts";
import { kinWorkFailuresOf, kinWorkRefused } from "../kinWork.ts";
import { createKinWorkItemWatch } from "../kinWorkChanges.ts";
import { kinWorkReadState } from "../kinWorkForms.ts";
import { createKinPagedList, mapPage } from "../kinWorkList.ts";
import type { KinHookApp, KinUseOpenChat } from "./kinHookApp.ts";
import { kinSchedule, type KinWorkHooks } from "./kinWorkHooks.ts";

/** The app's own hooks Docs' hooks read through. */
export interface KinDocsUses {
  readonly useKinOpenChat: KinUseOpenChat;
  readonly useKinPagedList: KinWorkHooks["useKinPagedList"];
}

const noLiveAtom: Atom.Atom<AsyncResult.AsyncResult<KinDocsLive, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noDocsAtom: Atom.Atom<AsyncResult.AsyncResult<KinDocsListResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);

const NO_WORDS = { text: "" };

/** Docs' live change number, lists, linked docs, What we sell, one doc and search, on one app's client. */
export function makeKinDocsHooks<R, ER>(app: KinHookApp<R, ER>, uses: KinDocsUses) {
  const { kinClient, kinReads, registry, useAtomCommand } = app;
  const { useKinOpenChat, useKinPagedList } = uses;
  const docsLiveAtom = ({ environmentId, orgId }: KinScreenTarget) =>
    kinClient.docsLive({ environmentId, input: { orgId } });

  /** Docs' change number, and whether the host lets this viewer read docs at all. */
  function useKinDocsLive(target: KinScreenTarget) {
    const allowed = useAtomValue(kinClient.docsList.permissionStateAtom(target.environmentId));
    const result = useAtomValue(allowed === "granted" ? docsLiveAtom(target) : noLiveAtom);
    const refused =
      allowed === "refused" ||
      (AsyncResult.isFailure(result) && kinWorkFailuresOf(result.cause).some(kinWorkRefused));
    return { refused, live: Option.getOrNull(AsyncResult.value(result)) };
  }

  /** Every doc, or the archived ones, latest change first, a page at a time. */
  function useKinDocsList(
    target: KinScreenTarget,
    seq: number | null,
    /** What the search bar already holds when the list opens. */
    text = "",
  ) {
    const { environmentId, orgId } = target;
    const initial = { ...KIN_DOCS_DEFAULT_FILTER, text };
    return useKinPagedList<KinDocsFilter, KinDocListRow>(
      initial,
      (onChange) => {
        const follow = kinDocsPageFollower(
          () =>
            Option.getOrNull(AsyncResult.value(registry.get(docsLiveAtom(target))))?.rows ?? null,
        );
        return createKinPagedList({
          initial,
          sameFilter: kinDocsSameFilter,
          idOf: (row) => row.recordId,
          onChange,
          schedule: kinSchedule,
          read: async (filter, page) =>
            mapPage(
              await follow.read(page, () =>
                kinClient.docsList.run(registry, {
                  environmentId,
                  input: { ...kinDocsQuery(orgId, filter), ...page },
                }),
              ),
              (value) => ({ ...value, rows: value.docs }),
            ),
          catchUp: follow.catchUp,
        });
      },
      seq,
    );
  }

  /** The docs linked to one client or project, read again when any doc changes. */
  function useKinDocsUnder(
    target: KinScreenTarget,
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
      if (behind) registry.refresh(atom);
    }, [behind, atom]);
    return held?.docs ?? null;
  }

  /**
   * The company's What we sell as this viewer's Docs list shows it, read again when any doc changes;
   * `undefined` until read, null when there is none. Off, it reads nothing.
   */
  function useKinWhatWeSell(target: KinScreenTarget, enabled: boolean) {
    const { refused, live } = useKinDocsLive(target);
    const atom = kinClient.docsUnder({
      environmentId: target.environmentId,
      input: kinWhatWeSellQuery(target.orgId),
    });
    const result = useAtomValue(refused || !enabled ? noDocsAtom : atom);
    const held = Option.getOrNull(AsyncResult.value(result));
    const behind = held !== null && live !== null && live.seq > held.seq;
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads What we sell from the host again when the host announces a doc changed
    useEffect(() => {
      if (behind) registry.refresh(atom);
    }, [behind, atom]);
    return held === null ? undefined : (held.docs[0] ?? null);
  }

  /**
   * The owner level's way into What we sell: Kin makes its outline (or brings it back), then the
   * sales agent's chat opens with the first words ready. Null where this viewer can't start it.
   */
  function useKinWhatWeSellStart(target: KinScreenTarget) {
    const { environmentId, orgId } = target;
    const openChat = useKinOpenChat();
    const canStart = useAtomValue(kinClient.docStartWhatWeSell.permissionAtom(environmentId));
    const canRestore = useAtomValue(kinClient.leadRestore.permissionAtom(environmentId));
    const leads = useAtomValue(kinReads.askLeads(target, canRestore));
    const startDoc = useAtomCommand(kinClient.docStartWhatWeSell, { reportFailure: false });
    const agent = kinWhatWeSellAgent(Option.getOrNull(AsyncResult.value(leads))?.leads ?? []);
    if (!canStart || agent === null) return null;
    return {
      agent: agent.name,
      /** False when the host couldn't start it; nothing opens then. */
      start: async (draft: string) => {
        const result = await startDoc({ environmentId, input: { orgId } });
        if (!AsyncResult.isSuccess(result)) return false;
        openChat(environmentId, orgId, agent.ownerChatId, draft);
        return true;
      },
    };
  }

  /** One doc at a version, kept current when the host says it changed. */
  function useKinDoc(target: KinScreenTarget, key: KinRecordKey, version: number | null) {
    const { environmentId, orgId } = target;
    const atom = kinClient.doc({
      environmentId,
      input: { orgId, key, ...(version === null ? {} : { version }) },
    });
    const state = kinWorkReadState<KinDocDetail>(useAtomValue(atom));
    const { live } = useKinDocsLive(target);
    const [watch] = useState(() =>
      createKinWorkItemWatch({ key, reread: () => registry.refresh(atom) }),
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
    return { state, refresh: () => registry.refresh(atom) };
  }

  /** A doc's versions, newest first, read again when the doc changes. */
  function useKinDocHistory(
    { environmentId, orgId }: KinScreenTarget,
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
              await kinClient.docHistory.run(registry, {
                environmentId,
                input: { orgId, key, ...page },
              }),
              (value) => ({ ...value, rows: value.versions, total: value.versions.length }),
            ),
        }),
      seq,
    );
  }

  /** One search box: everything this viewer may open (money and memory too), or only the kinds named. */
  function useKinSearch(
    { environmentId, orgId }: KinScreenTarget,
    kinds: ReadonlyArray<KinSearchKind> | null,
  ) {
    const [state, setState] = useState<KinSearchState>(KIN_SEARCH_INITIAL);
    const [search] = useState(() =>
      createKinSearch({
        onChange: setState,
        schedule: kinSchedule,
        read: ({ text, closed }) =>
          kinClient.search.run(registry, {
            environmentId,
            input: { orgId, text, closed, ...(kinds === null ? { everything: true } : { kinds }) },
          }),
      }),
    );
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons the search in flight when its box leaves the screen
    useEffect(() => search.dispose, [search]);
    return { state, search };
  }

  return {
    useKinDocsLive,
    useKinDocsList,
    useKinDocsUnder,
    useKinWhatWeSell,
    useKinWhatWeSellStart,
    useKinDoc,
    useKinDocHistory,
    useKinSearch,
  };
}
