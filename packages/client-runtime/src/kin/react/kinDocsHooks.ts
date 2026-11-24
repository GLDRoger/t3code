import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  KinDocDetail,
  KinDocListRow,
  KinDocVersion,
  KinDocsListResult,
  KinOrgId,
  KinRecordKey,
  KinSearchKind,
  KinWidgetId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { runKinCommand } from "../kinRunCommand.ts";
import {
  KIN_DOCS_DEFAULT_FILTER,
  KIN_SEARCH_INITIAL,
  createKinSearch,
  kinDocState,
  kinDocsQuery,
  kinDocsSameFilter,
  kinWhatWeSellAgent,
  kinWhatWeSellQuery,
  type KinDocsFilter,
  type KinSearchState,
} from "../kinDocs.ts";
import { kinCaughtUp } from "../kinCaughtUp.ts";
import { kinWhatWeSellAnswer } from "../kinSetUp.ts";
import { type KinDocsLive, kinDocsPageFollower } from "../kinDocsStream.ts";
import type { KinScreenTarget } from "../kinScreenReads.ts";
import { kinWorkFailuresOf, kinWorkRefused } from "../kinWork.ts";
import { createKinWorkItemWatch } from "../kinWorkChanges.ts";
import { createKinPagedList, mapPage } from "../kinWorkList.ts";
import type { KinHookApp, KinUseOpenChat } from "./kinHookApp.ts";
import { kinPagedKeeper, kinSchedule, useKinViewer, type KinWorkHooks } from "./kinWorkHooks.ts";

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

const noCountsAtom: Atom.Atom<
  AsyncResult.AsyncResult<
    { readonly total: number; readonly changed: number; readonly seq: number },
    unknown
  >
> = Atom.make(AsyncResult.initial());

const noDocAtom: Atom.Atom<AsyncResult.AsyncResult<KinDocDetail, unknown>> = Atom.make(
  AsyncResult.initial(),
);

const NO_WORDS = { text: "" };

/** Docs' live change number, lists, linked docs, What we sell, one doc and search, on one app's client. */
export function makeKinDocsHooks<R, ER>(app: KinHookApp<R, ER>, uses: KinDocsUses) {
  const { kinClient, kinReads, registry, useAtomCommand } = app;
  const { useKinOpenChat, useKinPagedList } = uses;
  const docLists = kinPagedKeeper<KinDocsFilter, KinDocListRow>();
  const docsLiveAtom = ({ environmentId, orgId }: KinScreenTarget) =>
    kinClient.docsLive({ environmentId, input: { orgId } });
  /** Docs' live change number where this viewer reads Docs; null until known. */
  const docsSeqAtom = Atom.family((key: string) => {
    const [environmentId, orgId] = JSON.parse(key) as [EnvironmentId, KinOrgId];
    return Atom.make((get) =>
      get(kinClient.docsList.permissionStateAtom(environmentId)) === "granted"
        ? (Option.getOrNull(AsyncResult.value(get(docsLiveAtom({ environmentId, orgId }))))?.seq ??
          null)
        : null,
    );
  });
  /** A read of docs that reads again when a doc changes after its answer. */
  const docsCaughtUp = <A extends { readonly seq: number }>(
    target: KinScreenTarget,
    read: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  ) =>
    kinCaughtUp(
      read,
      docsSeqAtom(JSON.stringify([target.environmentId, target.orgId])),
      (held) => held.seq,
    );

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
                runKinCommand(registry, kinClient.docsList, {
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
      {
        keeper: docLists,
        key: JSON.stringify([environmentId, orgId, text]),
        viewer: useKinViewer(app.runtime, environmentId),
      },
    );
  }

  /** The docs linked to one client or project, read again when any doc changes. */
  function useKinDocsUnder(
    target: KinScreenTarget,
    under: { readonly party: KinRecordKey } | { readonly project: KinRecordKey },
  ) {
    const { refused } = useKinDocsLive(target);
    const atom = docsCaughtUp(
      target,
      kinClient.docsUnder({
        environmentId: target.environmentId,
        input: { orgId: target.orgId, limit: 100, ...under },
      }),
    );
    const result = useAtomValue(refused ? noDocsAtom : atom);
    return Option.getOrNull(AsyncResult.value(result))?.docs ?? null;
  }

  /**
   * The company's What we sell as this viewer's Docs list shows it, read again when any doc changes;
   * `undefined` until read, null when there is none. Off, it reads nothing.
   */
  function useKinWhatWeSell(target: KinScreenTarget, enabled: boolean) {
    const { refused } = useKinDocsLive(target);
    const atom = docsCaughtUp(
      target,
      kinClient.docsUnder({
        environmentId: target.environmentId,
        input: kinWhatWeSellQuery(target.orgId),
      }),
    );
    const result = useAtomValue(refused || !enabled ? noDocsAtom : atom);
    const held = Option.getOrNull(AsyncResult.value(result));
    return held === null ? undefined : (held.docs[0] ?? null);
  }

  /**
   * The answer a new company gave to what it sells, read from What we sell; null when it has none,
   * undefined until read. Off, it reads nothing.
   */
  function useKinWhatWeSellAnswer(target: KinScreenTarget, enabled: boolean) {
    const row = useKinWhatWeSell(target, enabled);
    const atom =
      row === undefined || row === null
        ? noDocAtom
        : kinClient.doc({
            environmentId: target.environmentId,
            input: { orgId: target.orgId, key: row.key },
          });
    const detail = Option.getOrNull(AsyncResult.value(useAtomValue(atom)));
    if (row === null) return null;
    return detail === null ? undefined : kinWhatWeSellAnswer(detail.body);
  }

  /**
   * How many docs there are and how many changed since `since`, read again when a doc changes.
   * `refused` is a viewer the host keeps docs from.
   */
  function useKinDocsCounts(target: KinScreenTarget, since: string) {
    const { refused } = useKinDocsLive(target);
    const atom = docsCaughtUp(
      target,
      kinClient.docsCounts({
        environmentId: target.environmentId,
        input: { orgId: target.orgId, since },
      }),
    );
    const result = useAtomValue(refused ? noCountsAtom : atom);
    return { refused, docs: Option.getOrNull(AsyncResult.value(result)) };
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
  /** `card`: the long draft card it was opened from, which reads it without the Docs place. */
  function useKinDoc(
    target: KinScreenTarget,
    key: KinRecordKey,
    version: number | null,
    card: KinWidgetId | null = null,
  ) {
    const { environmentId, orgId } = target;
    const atom = kinClient.doc({
      environmentId,
      input: {
        orgId,
        key,
        ...(version === null ? {} : { version }),
        ...(card === null ? {} : { card }),
      },
    });
    const state = kinDocState(useAtomValue(atom));
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
              await runKinCommand(registry, kinClient.docHistory, {
                environmentId,
                input: { orgId, key, ...page },
              }),
              (value) => ({ ...value, rows: value.versions, total: value.versions.length }),
            ),
        }),
      seq,
    );
  }

  /** One search box: everything this viewer may open (money and memory too), or only the kinds named, with deals if asked. */
  function useKinSearch(
    { environmentId, orgId }: KinScreenTarget,
    kinds: ReadonlyArray<KinSearchKind> | null,
    deals = false,
  ) {
    const [state, setState] = useState<KinSearchState>(KIN_SEARCH_INITIAL);
    const [search] = useState(() =>
      createKinSearch({
        onChange: setState,
        schedule: kinSchedule,
        read: ({ text, closed }) =>
          runKinCommand(registry, kinClient.search, {
            environmentId,
            input: {
              orgId,
              text,
              closed,
              ...(kinds === null ? { everything: true } : { kinds }),
              ...(deals ? { deals: true } : {}),
            },
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
    useKinWhatWeSellAnswer,
    useKinDocsCounts,
    useKinWhatWeSellStart,
    useKinDoc,
    useKinDocHistory,
    useKinSearch,
  };
}
