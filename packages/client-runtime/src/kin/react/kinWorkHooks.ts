// @effect-diagnostics globalTimers:off globalDate:off - React hooks pace and keep list and search reads outside an Effect runtime.
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  KinOwnerTimeZone,
  KinPartyPage,
  KinPartyRow,
  KinPeopleListInvitesResult,
  KinPeopleListResult,
  KinProjectPage,
  KinProjectRow,
  KinRecordDetail,
  KinWorkHistoryItem,
  KinRecordKey,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { runKinCommand } from "../kinRunCommand.ts";
import { kinAccessMeAtom } from "../kinAccess.ts";
import { kinSectionOn } from "../kinShell.ts";
import { kinHostLink, type KinRouteHost } from "../kinHost.ts";
import type { KinScreenTarget } from "../kinScreenReads.ts";
import { kinInvitedPeople } from "../kinTeam.ts";
import {
  kinWorkNames,
  kinWorkScreenState,
  kinWorkAnswerKept,
  kinWorkAnswerOf,
  type KinWorkAnswers,
  type KinWorkAnswersHeld,
  type KinWorkScreenState,
} from "../kinWork.ts";
import {
  createKinWorkChanges,
  createKinWorkItemWatch,
  kinWorkChangesStart,
} from "../kinWorkChanges.ts";
import {
  KIN_PROJECTS_DEFAULT_FILTER,
  kinClientPageKeys,
  kinClientsQuery,
  kinClientsSameFilter,
  kinProjectPageKeys,
  kinProjectsQuery,
  kinProjectsSameFilter,
  kinProjectClients,
  kinWorkRefOf,
  type KinClientsFilter,
  type KinProjectsFilter,
} from "../kinWorkClients.ts";
import {
  createKinWorkForm,
  createKinWorkPageWatch,
  kinWorkReadState,
  type KinWorkFormState,
} from "../kinWorkForms.ts";
import {
  KIN_PICKER_SEARCH_IDLE,
  createKinListKeeper,
  createKinPagedList,
  createKinPickerSearch,
  createKinPickerSearchSlot,
  type KinPickerSearch,
  type KinPickerSearchState,
  kinPagedListInitial,
  mapPage,
  type KinPagedListState,
} from "../kinWorkList.ts";
import type { KinWorkLive } from "../kinWorkStream.ts";
import type { KinHookApp } from "./kinHookApp.ts";

/** The app's own host and environment reads Work's hooks go through. */
export interface KinWorkUses {
  readonly useKinHostAt: (environmentId: EnvironmentId) => KinRouteHost;
  readonly catalogValueAtom: Atom.Atom<{
    readonly isReady: boolean;
    readonly entries: { readonly has: (id: EnvironmentId) => boolean };
  }>;
  /** The phone keeps the host's answers to a task's changes for every screen of that task. */
  readonly keepAnswers?: boolean;
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
const noInvitesAtom: Atom.Atom<AsyncResult.AsyncResult<KinPeopleListInvitesResult, unknown>> =
  Atom.make(AsyncResult.initial());

/** Who is signed in to this host, by person id; null until the host says. */
export function useKinViewer<R, ER>(
  runtime: KinHookApp<R, ER>["runtime"],
  environmentId: EnvironmentId,
): string | null {
  return useAtomValue(kinAccessMeAtom(runtime, environmentId))?.personId ?? null;
}

export const kinSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

type Paged<Filter extends { readonly text: string }, Row> = ReturnType<
  typeof createKinPagedList<Filter, Row>
>;

/** Lists of one kind kept while their screen is away (`createKinListKeeper`). */
export type KinPagedKeeper<Filter extends { readonly text: string }, Row> = ReturnType<
  typeof createKinListKeeper<Paged<Filter, Row>, KinPagedListState<Filter, Row>>
>;

export const kinPagedKeeper = <Filter extends { readonly text: string }, Row>(): KinPagedKeeper<
  Filter,
  Row
> => createKinListKeeper<Paged<Filter, Row>, KinPagedListState<Filter, Row>>(Date.now);

const NO_WORDS = { text: "" };

const noChoicesAtom: Atom.Atom<
  AsyncResult.AsyncResult<
    {
      readonly clients: ReadonlyArray<KinPartyRow>;
      readonly projects: ReadonlyArray<KinProjectRow>;
      readonly doneProjects: ReadonlyArray<KinProjectRow>;
    },
    unknown
  >
> = Atom.make(AsyncResult.initial());

/** Work's live counts, people, lists, pages, pickers and forms, on one app's client. */
export function makeKinWorkHooks<R, ER>(app: KinHookApp<R, ER>, uses: KinWorkUses) {
  const { kinClient, registry, kinHostConnected } = app;
  const { useKinHostAt, catalogValueAtom } = uses;
  const clientLists = kinPagedKeeper<KinClientsFilter, KinPartyRow>();
  const projectLists = kinPagedKeeper<KinProjectsFilter, KinProjectRow>();
  const kinWorkLiveAtom = ({ environmentId, orgId }: KinScreenTarget) =>
    kinClient.workLive({ environmentId, input: { orgId } });

  // The host's answers to a person's changes, per host and org, read by every screen of a task.
  const kinWorkAnswersAtom = Atom.family((_key: string) =>
    Atom.make<KinWorkAnswersHeld>({}).pipe(Atom.keepAlive),
  );
  const answersAtomOf = ({ environmentId, orgId }: KinScreenTarget) =>
    kinWorkAnswersAtom(JSON.stringify([environmentId, orgId]));
  const viewerAtomOf = (environmentId: EnvironmentId) =>
    kinAccessMeAtom(app.runtime, environmentId);

  function kinWorkAnswersOf(target: KinScreenTarget): KinWorkAnswers {
    const atom = answersAtomOf(target);
    // Who is signed in when asked: another person on the same host never reads these.
    const viewer = () => registry.get(viewerAtomOf(target.environmentId))?.personId ?? null;
    return {
      get: (key) => kinWorkAnswerOf(registry.get(atom), key, viewer()),
      put: (item) => registry.set(atom, kinWorkAnswerKept(registry.get(atom), item, viewer())),
    };
  }

  /** The host's latest answer to this person's change to this task from any screen; null with none. */
  function useKinWorkAnswer(target: KinScreenTarget, key: KinRecordKey) {
    const viewer = useAtomValue(viewerAtomOf(target.environmentId))?.personId ?? null;
    return kinWorkAnswerOf(useAtomValue(answersAtomOf(target)), key, viewer) ?? null;
  }

  /** The owner's changes to tasks on one host, for a list or a task on screen. */
  function useKinWorkChanges(
    { environmentId, orgId }: KinScreenTarget,
    /** A form that opens already typing over this task. */
    editing?: KinRecordDetail,
  ) {
    const update = app.useAtomCommand(kinClient.workUpdate, { reportFailure: false });
    const assign = app.useAtomCommand(kinClient.workAssign, { reportFailure: false });
    const confirm = app.useAtomCommand(kinClient.workConfirm, { reportFailure: false });
    const decline = app.useAtomCommand(kinClient.workDecline, { reportFailure: false });
    const tickStep = app.useAtomCommand(kinClient.workTickStep, { reportFailure: false });
    const [state, setState] = useState(() => kinWorkChangesStart(editing));
    const [changes] = useState(() =>
      createKinWorkChanges({
        orgId,
        update: (input) => update({ environmentId, input }),
        assign: (input) => assign({ environmentId, input }),
        confirm: (input) => confirm({ environmentId, input }),
        decline: (input) => decline({ environmentId, input }),
        tickStep: (input) => tickStep({ environmentId, input }),
        reread: (key) =>
          registry.refresh(kinClient.workItem({ environmentId, input: { orgId, key } })),
        online: () => kinHostConnected(environmentId),
        ...(uses.keepAnswers === true
          ? { answers: kinWorkAnswersOf({ environmentId, orgId }) }
          : {}),
        ...(editing === undefined ? {} : { editing }),
        onChange: setState,
      }),
    );
    return { state, changes };
  }

  /** Work's counts and change number as one screen state, kept current by the host. */
  function useKinWork(target: KinScreenTarget): KinWorkScreenState {
    const allowed = useAtomValue(kinClient.workRead.permissionStateAtom(target.environmentId));
    const live = useAtomValue(allowed === "granted" ? kinWorkLiveAtom(target) : noLiveAtom);
    const host = useKinHostAt(target.environmentId);
    return kinWorkScreenState({ allowed, link: kinHostLink(host), live });
  }

  /**
   * Teammates re-invited who haven't opened the new link, for pickers to show as invited. Only a
   * session that hands out access can read invites; others get none.
   */
  function useKinReinvited({ environmentId, orgId }: KinScreenTarget, enabled = true) {
    const allowed = useAtomValue(kinClient.inviteCreate.permissionAtom(environmentId)) && enabled;
    const result = useAtomValue(
      allowed ? kinClient.invites({ environmentId, input: { orgId } }) : noInvitesAtom,
    );
    return kinInvitedPeople(Option.getOrNull(AsyncResult.value(result))?.invites ?? null);
  }

  /** The company's time zone, where a picked day is a calendar day; `read` once the host answered. */
  function useKinWorkZone({ environmentId, orgId }: KinScreenTarget, enabled = true) {
    const result = useAtomValue(
      enabled ? kinClient.workZone({ environmentId, input: { orgId } }) : noZoneAtom,
    );
    return {
      zone: Option.getOrNull(AsyncResult.value(result))?.timeZone ?? null,
      read: !AsyncResult.isInitial(result),
    };
  }

  /** Who Work can name and be given to. `enabled` is off for a viewer the host would refuse. */
  function useKinWorkDirectory({ environmentId, orgId }: KinScreenTarget, enabled: boolean) {
    const host = useKinHostAt(environmentId);
    const orgs = host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null;
    const result = useAtomValue(
      enabled ? kinClient.people({ environmentId, input: { orgId } }) : noPeopleAtom,
    );
    const listed = Option.getOrNull(AsyncResult.value(result));
    const people = listed?.people ?? null;
    const invited = useKinReinvited({ environmentId, orgId }, enabled);
    const { zone } = useKinWorkZone({ environmentId, orgId }, enabled);
    return {
      orgs,
      people,
      joined: listed?.joined ?? null,
      invited,
      names: kinWorkNames({ orgs, orgId, people, zone }),
    };
  }

  /** Reads the open task again when Work says it changed, and not for anyone else's change. */
  function useKinWorkItemWatch(
    { environmentId, orgId }: KinScreenTarget,
    key: KinRecordKey,
    heldSeq: number | undefined | null,
    /** A milestone's tasks: a change to one reads the milestone again. */
    alsoKeys: ReadonlyArray<KinRecordKey> = [],
  ) {
    const live = Option.getOrNull(
      AsyncResult.value(useAtomValue(kinWorkLiveAtom({ environmentId, orgId }))),
    );
    const [watch] = useState(() =>
      createKinWorkItemWatch({
        key,
        reread: () =>
          registry.refresh(kinClient.workItem({ environmentId, input: { orgId, key } })),
      }),
    );
    const named = Math.max(
      live?.changed[key] ?? 0,
      ...alsoKeys.map((also) => live?.changed[also] ?? 0),
    );
    const unnamed = live?.unnamed ?? 0;
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the open task from the host again when the host announces a change to it
    useEffect(() => {
      watch.changed(
        { changed: { [key]: named }, unnamed },
        heldSeq === null ? null : heldSeq === undefined ? {} : { seq: heldSeq },
      );
    }, [watch, key, named, unnamed, heldSeq]);
  }

  /** Which environments this app can open a thread in, as a task card decides it. */
  function useKinWorkPlace(environmentId: EnvironmentId) {
    const catalog = useAtomValue(catalogValueAtom);
    return {
      environmentId,
      isKnownEnvironment: (id: EnvironmentId) => !catalog.isReady || catalog.entries.has(id),
    };
  }

  /**
   * One of Work's lists on screen: started when it shows, told each change number while current.
   * With `keep`, coming back shows what it held, kept by that keeper under that key.
   */
  function useKinPagedList<Filter extends { readonly text: string }, Row>(
    initial: Filter,
    make: (onChange: (state: KinPagedListState<Filter, Row>) => void) => Paged<Filter, Row>,
    /** The host's latest change number; null while what is held may be behind. */
    seq: number | null,
    keep?: {
      readonly keeper: KinPagedKeeper<Filter, Row>;
      readonly key: string;
      /** The signed-in person (`useKinViewer`): another's kept list is never shown. */
      readonly viewer: string | null;
    },
  ) {
    const [kept] = useState(() =>
      keep === undefined ? null : keep.keeper.take(keep.key, make, keep.viewer),
    );
    const [resumed] = useState(
      () => kept !== null && keep !== undefined && keep.keeper.wasKept(kept),
    );
    const [state, setState] = useState(() =>
      resumed && kept !== null ? kept.list.getState() : kinPagedListInitial<Filter, Row>(initial),
    );
    const [list] = useState(() => kept?.list ?? make(setState));
    const keeper = keep?.keeper ?? null;
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the list's reads from the host when it shows (or catches a kept one up), and abandons what is in flight when it leaves
    useEffect(() => {
      if (keeper === null || kept === null) {
        list.start();
        return list.dispose;
      }
      keeper.show(kept, setState);
      if (resumed) keeper.resume(kept);
      else list.start();
      return () => keeper.hide(kept);
    }, [keeper, kept, list, resumed]);
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the list's reader the host's latest change number, so it reads again only when the rows are behind
    useEffect(() => {
      if (seq !== null) list.changed(seq);
    }, [list, seq]);
    return { state, list };
  }

  /** The clients list: late first, then no next step, then by name, a page at a time. */
  function useKinClientsList(
    { environmentId, orgId }: KinScreenTarget,
    seq: number | null,
    /** Where it starts; read once, as the list is made. */
    initial: KinClientsFilter,
  ) {
    return useKinPagedList<KinClientsFilter, KinPartyRow>(
      initial,
      (onChange) =>
        createKinPagedList({
          initial,
          sameFilter: kinClientsSameFilter,
          idOf: (row) => row.recordId,
          onChange,
          schedule: kinSchedule,
          read: async (filter, page) =>
            mapPage(
              await runKinCommand(registry, kinClient.workClients, {
                environmentId,
                input: { ...kinClientsQuery(orgId, filter), ...page },
              }),
              (value) => ({ ...value, rows: value.parties }),
            ),
        }),
      seq,
      {
        keeper: clientLists,
        key: JSON.stringify([environmentId, orgId, initial]),
        viewer: useKinViewer(app.runtime, environmentId),
      },
    );
  }

  /** The projects list: under way, done or dropped, soonest target first. */
  function useKinProjectsList(
    { environmentId, orgId }: KinScreenTarget,
    seq: number | null,
    view: KinProjectsFilter["view"] = "open",
  ) {
    const initial = { ...KIN_PROJECTS_DEFAULT_FILTER, view };
    return useKinPagedList<KinProjectsFilter, KinProjectRow>(
      initial,
      (onChange) =>
        createKinPagedList({
          initial,
          sameFilter: kinProjectsSameFilter,
          idOf: (row) => row.recordId,
          onChange,
          schedule: kinSchedule,
          read: async (filter, page) =>
            mapPage(
              await runKinCommand(registry, kinClient.workProjects, {
                environmentId,
                input: { ...kinProjectsQuery(orgId, filter), ...page },
              }),
              (value) => ({ ...value, rows: value.projects }),
            ),
        }),
      seq,
      {
        keeper: projectLists,
        key: JSON.stringify([environmentId, orgId, view]),
        viewer: useKinViewer(app.runtime, environmentId),
      },
    );
  }

  /** A client's history, newest first, read again only when its page was. */
  function useKinWorkHistory(
    { environmentId, orgId }: KinScreenTarget,
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
          schedule: kinSchedule,
          read: async (_filter, page) =>
            mapPage(
              await runKinCommand(registry, kinClient.workHistory, {
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
    { environmentId, orgId }: KinScreenTarget,
    own: KinRecordKey,
    page: { readonly of: object; readonly seq: number; readonly held: ReadonlySet<string> } | null,
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
          const result = await runKinCommand(registry, kinClient.workHistory, {
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
    const shellRev = useAtomValue(kinAccessMeAtom(app.runtime, environmentId))?.shell?.rev;
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the open page from the host again when the company's sections change, which shape what the host sends
    useEffect(() => {
      watch.shell(shellRev, page?.of ?? null);
    }, [watch, shellRev, page]);
  }

  /** A client's page, kept current without reading it for changes that are someone else's. */
  function useKinClientPage(target: KinScreenTarget, key: KinRecordKey) {
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
    const refresh = () => registry.refresh(atom);
    useKinWorkPageWatch(target, key, value === null ? null : held, refresh);
    return { state, refresh };
  }

  /** A project's page, kept current the same way. */
  function useKinProjectPage(target: KinScreenTarget, key: KinRecordKey) {
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
    const refresh = () => registry.refresh(atom);
    useKinWorkPageWatch(target, key, value === null ? null : held, refresh);
    return { state, refresh };
  }

  const kinWorkChoicesAtom = ({ environmentId, orgId }: KinScreenTarget) =>
    kinClient.workChoices({ environmentId, input: { orgId } });

  /** The clients and projects a task can be put under. `enabled` is off on a host without them. */
  /** The client and project pickers' choices: none while the company has Clients off. */
  function useKinWorkChoices(target: KinScreenTarget, enabled: boolean) {
    const clientsOn = kinSectionOn(
      useAtomValue(kinAccessMeAtom(app.runtime, target.environmentId))?.shell,
      "clients",
    );
    const result = useAtomValue(enabled && clientsOn ? kinWorkChoicesAtom(target) : noChoicesAtom);
    const held = Option.getOrNull(AsyncResult.value(result));
    return {
      clients: (held?.clients ?? []).map(kinWorkRefOf),
      projects: (held?.projects ?? []).map(kinWorkRefOf),
      doneProjects: (held?.doneProjects ?? []).map(kinWorkRefOf),
      projectClients: kinProjectClients([...(held?.projects ?? []), ...(held?.doneProjects ?? [])]),
    };
  }

  /** A client or project picker's search over every one the person may see, read as they type. */
  function useKinPickerSearch(
    { environmentId, orgId }: KinScreenTarget,
    kind: "clients" | "projects",
    done: boolean,
  ) {
    const [shown, setShown] = useState<{
      readonly search: KinPickerSearch | null;
      readonly state: KinPickerSearchState;
    }>({ search: null, state: KIN_PICKER_SEARCH_IDLE });
    const [slot] = useState(() =>
      createKinPickerSearchSlot((target) => {
        const search: KinPickerSearch = createKinPickerSearch({
          ...target,
          readClients: (input) =>
            runKinCommand(registry, kinClient.workClients, {
              environmentId: target.environmentId,
              input,
            }),
          readProjects: (input) =>
            runKinCommand(registry, kinClient.workProjects, {
              environmentId: target.environmentId,
              input,
            }),
          onChange: (state) => setShown({ search, state }),
          schedule: kinSchedule,
        });
        return search;
      }),
    );
    const search = slot({ environmentId, orgId, kind, done });
    // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons a pending or in-flight search when the picker leaves or its target changes
    useEffect(() => search.dispose, [search]);
    return {
      state: shown.search === search ? shown.state : search.getState(),
      type: search.type,
      retry: search.retry,
    };
  }

  /** A client, contact or project form: what is typed, and why a save didn't go through. */
  function useKinWorkForm<D extends object, A>(
    environmentId: EnvironmentId,
    options: Omit<Parameters<typeof createKinWorkForm<D, A>>[0], "online" | "onChange"> & {
      /** The record being edited as read now, so saving again goes against its newest revision. */
      readonly latest?: D | null;
    },
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
    // The form ignores a revision it has seen, so this sets state only when a newer read lands.
    if (options.editing != null && options.latest != null)
      form.latest(options.latest, options.editing.rev);
    return { state, form };
  }

  return {
    kinWorkLiveAtom,
    useKinWork,
    useKinReinvited,
    useKinWorkZone,
    useKinWorkDirectory,
    useKinWorkItemWatch,
    useKinWorkPlace,
    useKinPagedList,
    useKinClientsList,
    useKinProjectsList,
    useKinWorkHistory,
    useKinClientPage,
    useKinProjectPage,
    kinWorkChoicesAtom,
    useKinWorkChoices,
    useKinPickerSearch,
    useKinWorkForm,
    kinWorkAnswersOf,
    useKinWorkAnswer,
    useKinWorkChanges,
  };
}

export type KinWorkHooks = ReturnType<typeof makeKinWorkHooks>;
export type KinWorkChangesHandle = ReturnType<KinWorkHooks["useKinWorkChanges"]>;
export type KinWorkDirectory = ReturnType<KinWorkHooks["useKinWorkDirectory"]>;
export type KinWorkChoices = ReturnType<KinWorkHooks["useKinWorkChoices"]>;
