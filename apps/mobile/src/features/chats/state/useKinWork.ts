import { useAtomValue } from "@effect/atom-react";
import {
  kinWorkNames,
  type KinWorkAnswers,
  kinWorkScreenState,
  type KinWorkScreenState,
} from "@t3tools/client-runtime/kin/kinWork";
import {
  createKinWorkChanges,
  createKinWorkItemWatch,
  kinWorkChangesStart,
} from "@t3tools/client-runtime/kin/kinWorkChanges";
import {
  KIN_CLIENTS_DEFAULT_FILTER,
  KIN_PROJECTS_DEFAULT_FILTER,
  kinClientPageKeys,
  kinClientsQuery,
  kinClientsSameFilter,
  kinProjectPageKeys,
  kinProjectsQuery,
  kinProjectsSameFilter,
  kinWorkRefOf,
  type KinClientsFilter,
  type KinProjectsFilter,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  createKinWorkForm,
  createKinWorkPageWatch,
  kinWorkReadState,
  type KinWorkFormState,
} from "@t3tools/client-runtime/kin/kinWorkForms";
import {
  createKinPagedList,
  kinPagedListInitial,
  mapPage,
  type KinPagedListState,
} from "@t3tools/client-runtime/kin/kinWorkList";
import type { KinWorkLive } from "@t3tools/client-runtime/kin/kinWorkStream";
import type {
  EnvironmentId,
  KinOrgId,
  KinOwnerTimeZone,
  KinPartyPage,
  KinPartyRow,
  KinPeopleListResult,
  KinProjectPage,
  KinProjectRow,
  KinWorkHistoryItem,
  KinRecordDetail,
  KinRecordKey,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { environmentCatalog } from "../../../connection/catalog";
import { appAtomRegistry } from "../../../state/atom-registry";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient, retryKinWorkLive } from "./kinClient";
import { kinHostConnected, useKinHostAt } from "./useKinHost";

export interface KinWorkTarget {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}

// Read only by a session that may read Work; others ask the host nothing.
const noLiveAtom: Atom.Atom<AsyncResult.AsyncResult<KinWorkLive, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noPeopleAtom: Atom.Atom<AsyncResult.AsyncResult<KinPeopleListResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noZoneAtom: Atom.Atom<AsyncResult.AsyncResult<KinOwnerTimeZone, unknown>> = Atom.make(
  AsyncResult.initial(),
);

export const kinWorkLiveAtom = ({ environmentId, orgId }: KinWorkTarget) =>
  kinClient.workLive({ environmentId, input: { orgId } });

/**
 * Reads Work's counts again inside the running stream, keeping what is on screen. A stream that
 * already ended with an error has nothing to retry in, so it starts over.
 */
export const refreshKinWorkLive = (target: KinWorkTarget) => {
  const live = kinWorkLiveAtom(target);
  if (AsyncResult.isFailure(appAtomRegistry.get(live))) appAtomRegistry.refresh(live);
  else retryKinWorkLive(target.environmentId, target.orgId);
};

/** Work's counts and change number as one screen state, kept current by the host. */
export function useKinWork(target: KinWorkTarget): KinWorkScreenState {
  const allowed = useAtomValue(kinClient.workRead.permissionAtom(target.environmentId));
  const live = useAtomValue(allowed ? kinWorkLiveAtom(target) : noLiveAtom);
  const host = useKinHostAt(target.environmentId);
  return kinWorkScreenState({
    allowed,
    connected: host._tag === "host" && host.connected,
    live,
  });
}

/** Who Work can name and be given to. `enabled` is off for a viewer the host would refuse. */
export function useKinWorkDirectory({ environmentId, orgId }: KinWorkTarget, enabled: boolean) {
  const host = useKinHostAt(environmentId);
  const orgs = host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null;
  const result = useAtomValue(
    enabled ? kinClient.people({ environmentId, input: { orgId } }) : noPeopleAtom,
  );
  const listed = Option.getOrNull(AsyncResult.value(result));
  const people = listed?.people ?? null;
  const zone =
    Option.getOrNull(
      AsyncResult.value(
        useAtomValue(
          enabled ? kinClient.workZone({ environmentId, input: { orgId } }) : noZoneAtom,
        ),
      ),
    )?.timeZone ?? null;
  return {
    orgs,
    people,
    joined: listed?.joined ?? null,
    names: kinWorkNames({ orgs, orgId, people, zone }),
  };
}

export type KinWorkDirectory = ReturnType<typeof useKinWorkDirectory>;

// The host's answers to the owner's changes, per host and org, read by every screen of a task.
const kinWorkAnswersAtom = Atom.family((_key: string) =>
  Atom.make<Readonly<Record<string, KinRecordDetail>>>({}).pipe(Atom.keepAlive),
);
const answersAtomOf = ({ environmentId, orgId }: KinWorkTarget) =>
  kinWorkAnswersAtom(JSON.stringify([environmentId, orgId]));

export function kinWorkAnswersOf(target: KinWorkTarget): KinWorkAnswers {
  const atom = answersAtomOf(target);
  return {
    get: (key) => appAtomRegistry.get(atom)[key],
    put: (item) => {
      const held = appAtomRegistry.get(atom);
      if ((held[item.key]?.rev ?? -1) >= item.rev) return;
      appAtomRegistry.set(atom, { ...held, [item.key]: item });
    },
  };
}

/** The host's latest answer to a change to this task from any screen; null with none. */
export function useKinWorkAnswer(target: KinWorkTarget, key: KinRecordKey) {
  return useAtomValue(answersAtomOf(target))[key] ?? null;
}

/** The owner's changes to tasks on one host, for a list or a task on screen. */
export function useKinWorkChanges(
  { environmentId, orgId }: KinWorkTarget,
  /** A form that opens already typing over this task. */
  editing?: KinRecordDetail,
) {
  const update = useAtomCommand(kinClient.workUpdate, { reportFailure: false });
  const assign = useAtomCommand(kinClient.workAssign, { reportFailure: false });
  const confirm = useAtomCommand(kinClient.workConfirm, { reportFailure: false });
  const decline = useAtomCommand(kinClient.workDecline, { reportFailure: false });
  const [state, setState] = useState(() => kinWorkChangesStart(editing));
  const [changes] = useState(() =>
    createKinWorkChanges({
      orgId,
      update: (input) => update({ environmentId, input }),
      assign: (input) => assign({ environmentId, input }),
      confirm: (input) => confirm({ environmentId, input }),
      decline: (input) => decline({ environmentId, input }),
      reread: (key) =>
        appAtomRegistry.refresh(kinClient.workItem({ environmentId, input: { orgId, key } })),
      online: () => kinHostConnected(environmentId),
      answers: kinWorkAnswersOf({ environmentId, orgId }),
      ...(editing === undefined ? {} : { editing }),
      onChange: setState,
    }),
  );
  return { state, changes };
}

/** Reads the open task again when Work says it changed, and not for anyone else's change. */
export function useKinWorkItemWatch(
  { environmentId, orgId }: KinWorkTarget,
  key: KinRecordKey,
  heldSeq: number | undefined | null,
) {
  const live = Option.getOrNull(
    AsyncResult.value(useAtomValue(kinWorkLiveAtom({ environmentId, orgId }))),
  );
  const [watch] = useState(() =>
    createKinWorkItemWatch({
      key,
      reread: () =>
        appAtomRegistry.refresh(kinClient.workItem({ environmentId, input: { orgId, key } })),
    }),
  );
  const named = live?.changed[key] ?? 0;
  const unnamed = live?.unnamed ?? 0;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the open task from the host again when the host announces a change to it
  useEffect(() => {
    watch.changed(
      { changed: { [key]: named }, unnamed },
      heldSeq === null ? null : heldSeq === undefined ? {} : { seq: heldSeq },
    );
  }, [watch, key, named, unnamed, heldSeq]);
}

/** Which environments this phone can open a thread in, as a task card decides it. */
export function useKinWorkPlace(environmentId: EnvironmentId) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  return {
    environmentId,
    isKnownEnvironment: (id: EnvironmentId) => !catalog.isReady || catalog.entries.has(id),
  };
}

const schedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

type Paged<Filter extends { readonly text: string }, Row> = ReturnType<
  typeof createKinPagedList<Filter, Row>
>;

/** One of Work's lists on screen: started when it shows, told each change number while current. */
function useKinPagedList<Filter extends { readonly text: string }, Row>(
  initial: Filter,
  make: (onChange: (state: KinPagedListState<Filter, Row>) => void) => Paged<Filter, Row>,
  /** The host's latest change number; null while what is held may be behind. */
  seq: number | null,
) {
  const [state, setState] = useState(() => kinPagedListInitial<Filter, Row>(initial));
  const [list] = useState(() => make(setState));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the list's reads from the host when it shows, and abandons what is in flight when it leaves
  useEffect(() => {
    list.start();
    return list.dispose;
  }, [list]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the list's reader the host's latest change number, so it reads again only when the rows are behind
  useEffect(() => {
    if (seq !== null) list.changed(seq);
  }, [list, seq]);
  return { state, list };
}

/** The clients list: active or closed, by name, a page at a time. */
export function useKinClientsList(
  { environmentId, orgId }: KinWorkTarget,
  seq: number | null,
  /** What the search bar already holds when the list opens. */
  text = "",
) {
  const initial = { ...KIN_CLIENTS_DEFAULT_FILTER, text };
  return useKinPagedList<KinClientsFilter, KinPartyRow>(
    initial,
    (onChange) =>
      createKinPagedList({
        initial,
        sameFilter: kinClientsSameFilter,
        idOf: (row) => row.recordId,
        onChange,
        schedule,
        read: async (filter, page) =>
          mapPage(
            await kinClient.workClients.run(appAtomRegistry, {
              environmentId,
              input: { ...kinClientsQuery(orgId, filter), ...page },
            }),
            (value) => ({ ...value, rows: value.parties }),
          ),
      }),
    seq,
  );
}

/** The projects list: under way, done or dropped, soonest target first. */
export function useKinProjectsList(
  { environmentId, orgId }: KinWorkTarget,
  seq: number | null,
  /** What the search bar already holds when the list opens. */
  text = "",
) {
  const initial = { ...KIN_PROJECTS_DEFAULT_FILTER, text };
  return useKinPagedList<KinProjectsFilter, KinProjectRow>(
    initial,
    (onChange) =>
      createKinPagedList({
        initial,
        sameFilter: kinProjectsSameFilter,
        idOf: (row) => row.recordId,
        onChange,
        schedule,
        read: async (filter, page) =>
          mapPage(
            await kinClient.workProjects.run(appAtomRegistry, {
              environmentId,
              input: { ...kinProjectsQuery(orgId, filter), ...page },
            }),
            (value) => ({ ...value, rows: value.projects }),
          ),
      }),
    seq,
  );
}

const NO_WORDS = { text: "" };

/** A client's history, newest first, read again only when its page was. */
export function useKinWorkHistory(
  { environmentId, orgId }: KinWorkTarget,
  key: KinRecordKey,
  seq: number | null,
) {
  return useKinPagedList<typeof NO_WORDS, KinWorkHistoryItem>(
    NO_WORDS,
    (onChange) =>
      createKinPagedList({
        initial: NO_WORDS,
        sameFilter: () => true,
        idOf: (item) => String(item.seq),
        onChange,
        schedule,
        read: async (_filter, page) =>
          mapPage(
            await kinClient.workHistory.run(appAtomRegistry, {
              environmentId,
              input: { orgId, key, ...page },
            }),
            (value) => ({ ...value, rows: value.items, total: value.items.length }),
          ),
      }),
    seq,
  );
}

/** Reads an open client or project page again only when a change could be about it. */
function useKinWorkPageWatch(
  { environmentId, orgId }: KinWorkTarget,
  own: KinRecordKey,
  page: { readonly seq: number; readonly held: ReadonlySet<string> } | null,
  reread: () => void,
) {
  const live = Option.getOrNull(
    AsyncResult.value(useAtomValue(kinWorkLiveAtom({ environmentId, orgId }))),
  );
  const [watch] = useState(() =>
    createKinWorkPageWatch({
      own,
      reread,
      newest: async () => {
        const result = await kinClient.workHistory.run(appAtomRegistry, {
          environmentId,
          input: { orgId, key: own, limit: 1 },
        });
        return AsyncResult.isSuccess(result) ? (result.value.items[0]?.seq ?? 0) : null;
      },
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the open page from the host again when the host announces a change that could be about it
  useEffect(() => {
    if (live !== null) watch.changed(live, page);
  }, [watch, live, page]);
}

/** A client's page, kept current without reading it for changes that are someone else's. */
export function useKinClientPage(target: KinWorkTarget, key: KinRecordKey) {
  const atom = kinClient.workClient({
    environmentId: target.environmentId,
    input: { orgId: target.orgId, key },
  });
  const state = kinWorkReadState(useAtomValue(atom));
  const value = state._tag === "ready" ? state.value : null;
  const [held, setHeld] = useState<{
    readonly of: KinPartyPage;
    readonly seq: number;
    readonly held: ReadonlySet<string>;
  } | null>(null);
  // The keys are worked out once per read, so the watch sees the same page until the next one.
  if (value !== null && held?.of !== value)
    setHeld({ of: value, seq: value.seq, held: kinClientPageKeys(value) });
  const refresh = () => appAtomRegistry.refresh(atom);
  useKinWorkPageWatch(target, key, value === null ? null : held, refresh);
  return { state, refresh };
}

/** A project's page, kept current the same way. */
export function useKinProjectPage(target: KinWorkTarget, key: KinRecordKey) {
  const atom = kinClient.workProject({
    environmentId: target.environmentId,
    input: { orgId: target.orgId, key },
  });
  const state = kinWorkReadState(useAtomValue(atom));
  const value = state._tag === "ready" ? state.value : null;
  const [held, setHeld] = useState<{
    readonly of: KinProjectPage;
    readonly seq: number;
    readonly held: ReadonlySet<string>;
  } | null>(null);
  if (value !== null && held?.of !== value)
    setHeld({ of: value, seq: value.seq, held: kinProjectPageKeys(value) });
  const refresh = () => appAtomRegistry.refresh(atom);
  useKinWorkPageWatch(target, key, value === null ? null : held, refresh);
  return { state, refresh };
}

const noChoicesAtom: Atom.Atom<
  AsyncResult.AsyncResult<
    {
      readonly clients: ReadonlyArray<KinPartyRow>;
      readonly projects: ReadonlyArray<KinProjectRow>;
    },
    unknown
  >
> = Atom.make(AsyncResult.initial());

export const kinWorkChoicesAtom = ({ environmentId, orgId }: KinWorkTarget) =>
  kinClient.workChoices({ environmentId, input: { orgId } });

/** The clients and projects a task can be put under. `enabled` is off on a host without them. */
export function useKinWorkChoices(target: KinWorkTarget, enabled: boolean) {
  const result = useAtomValue(enabled ? kinWorkChoicesAtom(target) : noChoicesAtom);
  const held = Option.getOrNull(AsyncResult.value(result));
  return {
    clients: (held?.clients ?? []).map(kinWorkRefOf),
    projects: (held?.projects ?? []).map(kinWorkRefOf),
  };
}

export type KinWorkChoices = ReturnType<typeof useKinWorkChoices>;

/** A client, contact or project form: what is typed, and why a save didn't go through. */
export function useKinWorkForm<D extends object, A>(
  environmentId: EnvironmentId,
  options: Omit<Parameters<typeof createKinWorkForm<D, A>>[0], "online" | "onChange">,
) {
  const [state, setState] = useState<KinWorkFormState<D>>(() => ({
    draft: options.start,
    from: options.start,
    latest: null,
    saving: false,
    problem: null,
  }));
  const [form] = useState(() =>
    createKinWorkForm<D, A>({
      ...options,
      online: () => kinHostConnected(environmentId),
      onChange: setState,
    }),
  );
  return { state, form };
}
