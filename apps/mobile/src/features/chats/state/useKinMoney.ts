import { useAtomValue } from "@effect/atom-react";
import { kinReadDates, type KinDatesWindow } from "@t3tools/client-runtime/kin/kinDates";
import {
  kinListQuery,
  kinListSameFilter,
  kinListSend,
  type KinListContext,
  type KinListFilter,
} from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_INVOICES,
  kinIssueNotice,
  kinReceiptNotice,
} from "@t3tools/client-runtime/kin/kinInvoices";
import { kinAccessMeAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { kinRatesOf } from "@t3tools/client-runtime/kin/kinCurrency";
import { kinWorkAgent, type KinWorkPlace } from "@t3tools/client-runtime/kin/kinWorkHome";
import type { KinMoneyUse } from "@t3tools/client-runtime/kin/kinScreenReads";
import { kinWorkReadState } from "@t3tools/client-runtime/kin/kinWorkForms";
import {
  createKinListEntries,
  kinPagedListInitial,
  type KinPagedListState,
} from "@t3tools/client-runtime/kin/kinWorkList";
import type {
  KinCompanyProfile,
  KinDateRow,
  KinListDefinition,
  KinListId,
  KinListTotals,
  KinListsResult,
  KinMoneySummary,
  KinRecord,
  KinRecordKey,
  KinWorkFile,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { useNowMinuteMs } from "../../../lib/clock";
import { uuidv4 } from "../../../lib/uuid";
import { connectionAtomRuntime } from "../../../connection/runtime";
import { appAtomRegistry } from "../../../state/atom-registry";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient, kinReads } from "./kinClient";
import { useKinOpenChat } from "./useKinOpenChat";
import { useKinMoneyLive } from "./useKinMoneyLive";
import { kinHostConnected } from "./useKinHost";
import {
  kinWorkChoicesAtom,
  kinWorkLiveAtom,
  type KinWorkDirectory,
  type KinWorkTarget,
} from "./useKinWork";

const noListsAtom: Atom.Atom<AsyncResult.AsyncResult<KinListsResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noMoneyAtom: Atom.Atom<AsyncResult.AsyncResult<KinMoneySummary, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noCompanyAtom: Atom.Atom<AsyncResult.AsyncResult<KinCompanyProfile, unknown>> = Atom.make(
  AsyncResult.initial(),
);

export type { KinMoneyUse };

/** Every list there is, as its definition. `enabled` is off for a viewer the host would refuse. */
export function useKinLists(
  target: KinWorkTarget,
  options: {
    readonly enabled: boolean;
    readonly archived?: boolean;
    /** Money's own screen: from Money's stream where the host streams it. */
    readonly money?: boolean;
  },
) {
  const archived = options.archived === true;
  const streamed = useKinMoneyLive(target, "lists");
  const read = kinReads.chosen(
    options.money === true && !archived ? streamed : null,
    kinReads.lists(target, archived),
    options.enabled,
  );
  const state = kinWorkReadState(useAtomValue(read.atom ?? noListsAtom));
  return { state, refresh: read.refresh };
}

export type KinListsHandle = ReturnType<typeof useKinLists>;

export const kinListsOf = (handle: KinListsHandle): ReadonlyArray<KinListDefinition> =>
  handle.state._tag === "ready" ? handle.state.value.lists : [];

/** The Money summary, kept current by Work's changes (`kinWorkRefreshOn`). */
export function useKinMoneySummary(
  target: KinWorkTarget,
  options: {
    readonly enabled: boolean;
    readonly use?: KinMoneyUse;
    /** A client's page: the host answers what this viewer may see owed by that client. */
    readonly party?: KinRecordKey;
  },
) {
  const use = options.use ?? "line";
  const streamed = useKinMoneyLive(target, "summary");
  const read = kinReads.chosen(
    use === "rows" ? null : streamed,
    kinReads.money(target, use, options.party),
    options.enabled,
  );
  const state = kinWorkReadState(useAtomValue(read.atom ?? noMoneyAtom));
  return { state, refresh: read.refresh };
}

const noChoicesAtom: ReturnType<typeof kinWorkChoicesAtom> = Atom.make(AsyncResult.initial());

/** What every list row and entry needs to read its values: names, clients and projects, now. */
export function useKinListContext(
  target: KinWorkTarget,
  directory: KinWorkDirectory,
  enabled = true,
): KinListContext {
  const now = new Date(useNowMinuteMs());
  const held = Option.getOrNull(
    AsyncResult.value(useAtomValue(enabled ? kinWorkChoicesAtom(target) : noChoicesAtom)),
  );
  const me = useAtomValue(kinAccessMeAtom(connectionAtomRuntime, target.environmentId));
  return {
    names: directory.names,
    // A link field stores the record's id, which the pickers' rows carry beside the name.
    refs: new Map(
      [...(held?.clients ?? []), ...(held?.projects ?? [])].map((row) => [
        row.recordId,
        { key: row.key, title: row.name },
      ]),
    ),
    now,
    ...(me?.financialYearStartMonth === undefined
      ? {}
      : { yearStartMonth: me.financialYearStartMonth }),
  };
}

const schedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

/** One list's entries a page at a time, with the host's exact totals for the whole filter. */
export function useKinListEntries(
  { environmentId, orgId }: KinWorkTarget,
  list: KinListId,
  initial: KinListFilter,
  seq: number | null,
) {
  const [state, setState] = useState<KinPagedListState<KinListFilter, KinRecord>>(() =>
    kinPagedListInitial(initial),
  );
  const [totals, setTotals] = useState<{
    readonly filter: KinListFilter;
    readonly totals: KinListTotals;
  } | null>(null);
  const [entries] = useState(() =>
    createKinListEntries<KinListFilter>({
      initial,
      sameFilter: kinListSameFilter,
      query: (filter) => kinListQuery(orgId, list, filter),
      onChange: setState,
      schedule,
      read: async (input, filter) => {
        const result = await kinClient.workList.run(appAtomRegistry, { environmentId, input });
        if (AsyncResult.isSuccess(result) && result.value.totals !== undefined)
          setTotals({ filter, totals: result.value.totals });
        return result;
      },
      rows: () =>
        appAtomRegistry
          .get(kinWorkLiveAtom({ environmentId, orgId }))
          .pipe(AsyncResult.value, Option.getOrNull)?.rows ?? null,
    }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the list's reads from the host when it shows, and abandons what is in flight when it leaves
  useEffect(() => {
    entries.start();
    return entries.dispose;
  }, [entries]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the list's reader the host's latest change number, so it reads again only when the rows are behind
  useEffect(() => {
    if (seq !== null) entries.changed(seq);
  }, [entries, seq]);
  return {
    state,
    entries,
    // Totals read for other words or another status can't stand in for these.
    totals:
      totals !== null && kinListSameFilter(totals.filter, state.filter) ? totals.totals : null,
  };
}

export type KinDatesState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | {
      readonly _tag: "ready";
      readonly rows: ReadonlyArray<KinDateRow>;
      readonly more: boolean;
      /** Rows are up while they are read again. */
      readonly refreshing: boolean;
    };

/** Everything dated in a window, across lists, read again when the window or Work changes. */
export function useKinDates(
  { environmentId, orgId }: KinWorkTarget,
  window: KinDatesWindow | null,
  openOnly: boolean,
  seq: number | null,
) {
  const [held, setHeld] = useState<{
    readonly request: string;
    readonly rows: ReadonlyArray<KinDateRow>;
    readonly more: boolean;
    readonly failed: boolean;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const request = `${environmentId}:${orgId}:${window?.from}:${window?.to}:${openOnly}:${seq}:${attempt}`;
  const from = window?.from ?? null;
  const to = window?.to ?? null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the window's dates from the host, again when the window, the filter or Work changes
  useEffect(() => {
    if (from === null || to === null) return;
    let current = true;
    void kinReadDates(
      (input) => kinClient.workDates.run(appAtomRegistry, { environmentId, input }),
      {
        orgId,
        from,
        to,
        ...(openOnly ? { open: true } : {}),
      },
    ).then((result) => {
      if (!current) return;
      setHeld((before) =>
        AsyncResult.isSuccess(result)
          ? { request, ...result.value, failed: false }
          : before !== null && !before.failed
            ? { ...before, request }
            : { request, rows: [], more: false, failed: true },
      );
    });
    return () => {
      current = false;
    };
  }, [environmentId, orgId, from, to, openOnly, request]);
  const state: KinDatesState =
    held === null || (held.failed && held.request !== request)
      ? { _tag: "loading" }
      : held.failed
        ? { _tag: "failed" }
        : { _tag: "ready", rows: held.rows, more: held.more, refreshing: held.request !== request };
  return { state, retry: () => setAttempt((count) => count + 1) };
}

/** The owner's taps on an entry: its status, dates, repeat and payments. */
export function useKinEntryChanges({ environmentId, orgId }: KinWorkTarget, key: KinRecordKey) {
  const update = useAtomCommand(kinClient.workUpdate, { reportFailure: false });
  const pay = useAtomCommand(kinClient.workPaymentRecord, { reportFailure: false });
  const takeBack = useAtomCommand(kinClient.workPaymentVoid, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async <A>(send: () => Promise<AsyncResult.AsyncResult<A, unknown>>) => {
    setBusy(true);
    setProblem(null);
    const outcome = await kinReads.sendEntryChange(
      { environmentId, orgId },
      key,
      () => kinHostConnected(environmentId),
      send as Parameters<typeof kinListSend<A>>[0]["send"],
    );
    setBusy(false);
    if (!outcome.ok) setProblem(outcome.problem);
    return outcome.ok;
  };
  return {
    busy,
    problem,
    dismiss: () => setProblem(null),
    update: (
      rev: number,
      patch: Omit<Parameters<typeof update>[0]["input"], "orgId" | "key" | "rev">,
    ) => run(() => update({ environmentId, input: { orgId, key, rev, ...patch } })),
    pay: (input: Omit<Parameters<typeof pay>[0]["input"], "orgId" | "key">) =>
      run(() => pay({ environmentId, input: { orgId, key, ...input } })),
    takeBack: (paymentId: string) =>
      run(() => takeBack({ environmentId, input: { orgId, key, paymentId } })),
  };
}

export type KinWorkFilesState =
  | { readonly _tag: "loading" }
  | { readonly _tag: "failed" }
  | { readonly _tag: "ready"; readonly files: ReadonlyArray<KinWorkFile> };

/** The newest files in the owner's chats whose names match `text`, read as it is typed. */
export function useKinWorkFiles({ environmentId, orgId }: KinWorkTarget, text: string) {
  const [held, setHeld] = useState<{
    readonly request: string;
    readonly files: ReadonlyArray<KinWorkFile> | null;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const words = text.trim();
  const request = `${environmentId}:${orgId}:${words}:${attempt}`;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the matching files from the host, a moment after typing stops
  useEffect(() => {
    let current = true;
    const cancel = schedule(
      () =>
        void kinClient.workFiles
          .run(appAtomRegistry, {
            environmentId,
            input: { orgId, limit: 50, ...(words === "" ? {} : { text: words }) },
          })
          .then((result) => {
            if (current)
              setHeld({
                request,
                files: AsyncResult.isSuccess(result) ? result.value.files : null,
              });
          }),
      words === "" ? 0 : 250,
    );
    return () => {
      current = false;
      cancel();
    };
  }, [environmentId, orgId, words, request]);
  const state: KinWorkFilesState =
    held === null || held.request !== request
      ? { _tag: "loading" }
      : held.files === null
        ? { _tag: "failed" }
        : { _tag: "ready", files: held.files };
  return { state, retry: () => setAttempt((count) => count + 1) };
}

/** The owner's changes to a list itself: its names, its fields, and putting it away. */
export function useKinListChanges(target: KinWorkTarget) {
  const { environmentId } = target;
  const update = useAtomCommand(kinClient.workListUpdate, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return {
    busy,
    problem,
    dismiss: () => setProblem(null),
    setProblem,
    send: async (input: Parameters<typeof update>[0]["input"]) => {
      setBusy(true);
      setProblem(null);
      const outcome = await kinListSend({
        online: () => kinHostConnected(environmentId),
        send: () => update({ environmentId, input }),
      });
      setBusy(false);
      kinReads.refreshLists(target);
      if (!outcome.ok) setProblem(outcome.problem);
      return outcome.ok;
    },
  };
}

/** Opens the chat with the agent a place hands over to, with a message ready to send. */
export function useKinAskAgent(
  { environmentId, orgId }: KinWorkTarget,
  place: KinWorkPlace | null = "money",
) {
  const openChat = useKinOpenChat();
  const canRestore = useAtomValue(kinClient.leadRestore.permissionAtom(environmentId));
  const result = useAtomValue(kinReads.askLeads({ environmentId, orgId }, canRestore));
  const agent = kinWorkAgent(Option.getOrNull(AsyncResult.value(result))?.leads ?? [], place);
  if (agent === null) return null;
  return {
    name: agent.name,
    ask: (message: string) => openChat(environmentId, orgId, agent.ownerChatId, message),
  };
}

/** The company's legal and bank details. `enabled` is off where the host would refuse. */
export function useKinCompanyProfile(target: KinWorkTarget, enabled: boolean) {
  const atom = kinClient.companyProfile({
    environmentId: target.environmentId,
    input: { orgId: target.orgId },
  });
  const state = kinWorkReadState(useAtomValue(enabled ? atom : noCompanyAtom));
  return { state, refresh: () => appAtomRegistry.refresh(atom) };
}

/** The rates estimates use, from the company profile, read again when the owner changes them. */
export function useKinRates(target: KinWorkTarget, enabled = true) {
  // A teammate's phone never asks: the host would refuse, and no figure reaches them anyway.
  const allowed = useAtomValue(kinClient.companyRead.permissionAtom(target.environmentId));
  const profile = useKinCompanyProfile(target, enabled && allowed);
  return profile.state._tag === "ready" ? kinRatesOf(profile.state.value) : null;
}

/** The company's home currency, which a form starts amounts in: every member reads it, rates or not. */
export function useKinHomeCurrency(target: KinWorkTarget) {
  return useAtomValue(kinAccessMeAtom(connectionAtomRuntime, target.environmentId))?.homeCurrency;
}

/** Whether the company was made new and its country is not chosen: no money is recorded until it is. */
export function useKinCountryNeeded(target: KinWorkTarget) {
  return (
    useAtomValue(kinAccessMeAtom(connectionAtomRuntime, target.environmentId))?.countryNeeded ===
    true
  );
}

/** The company's country, which decides whether forms ask for India's tax fields. */
export function useKinCompanyCountry(target: KinWorkTarget) {
  return useAtomValue(kinAccessMeAtom(connectionAtomRuntime, target.environmentId))?.country;
}

const noReceiptsAtom: ReturnType<typeof kinClient.receipts> = Atom.make(AsyncResult.initial());
const noRecipesAtom: ReturnType<typeof kinClient.recipes> = Atom.make(AsyncResult.initial());

/** Money's receipts, newest first, kept current by Work's changes. */
export function useKinReceipts(target: KinWorkTarget, options: { readonly enabled: boolean }) {
  const read = kinReads.chosen(
    useKinMoneyLive(target, "receipts"),
    kinClient.receipts({ environmentId: target.environmentId, input: { orgId: target.orgId } }),
    options.enabled,
  );
  const state = kinWorkReadState(useAtomValue(read.atom ?? noReceiptsAtom));
  return { state, refresh: read.refresh };
}

/** The company's document templates; `enabled` is off where the host would refuse. */
export function useKinRecipes(target: KinWorkTarget, enabled: boolean) {
  const atom = kinClient.recipes({
    environmentId: target.environmentId,
    input: { orgId: target.orgId },
  });
  const state = kinWorkReadState(useAtomValue(enabled ? atom : noRecipesAtom));
  return { state, refresh: () => appAtomRegistry.refresh(atom) };
}

export interface KinPreviewFile {
  readonly name: string;
  readonly mimeType: string;
  readonly base64: string;
}

/**
 * The owner's taps on invoices and receipts: issue, void and undo it, make a receipt, set an
 * advance against an invoice, and make an entry's document, previewed first. Each says what it did.
 */
export function useKinMoneyActions({ environmentId, orgId }: KinWorkTarget) {
  const issue = useAtomCommand(kinClient.workIssue, { reportFailure: false });
  const voidIt = useAtomCommand(kinClient.workVoid, { reportFailure: false });
  const unvoid = useAtomCommand(kinClient.workUnvoid, { reportFailure: false });
  const readNext = useAtomCommand(kinClient.workNextNumber, { reportFailure: false });
  const receipt = useAtomCommand(kinClient.makeReceipt, { reportFailure: false });
  const render = useAtomCommand(kinClient.docRender, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The document the last action filed, for its notice to open. */
  const [filed, setFiled] = useState<KinRecordKey | null>(null);
  const run = async <A>(
    send: () => Promise<AsyncResult.AsyncResult<A, unknown>>,
    key: KinRecordKey | undefined,
    said: (value: A) => string | null,
  ): Promise<A | null> => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    setFiled(null);
    const outcome = await kinReads.sendEntryChange(
      { environmentId, orgId },
      key,
      () => kinHostConnected(environmentId),
      send as Parameters<typeof kinListSend<A>>[0]["send"],
    );
    appAtomRegistry.refresh(kinClient.receipts({ environmentId, input: { orgId } }));
    setBusy(false);
    if (!outcome.ok) {
      setProblem(outcome.problem);
      return null;
    }
    setNotice(said(outcome.value));
    return outcome.value;
  };
  return {
    busy,
    problem,
    notice,
    filed,
    dismiss: () => {
      setProblem(null);
      setNotice(null);
      setFiled(null);
    },
    issue: (key: KinRecordKey) =>
      run(() => issue({ environmentId, input: { orgId, key } }), key, kinIssueNotice),
    void: (key: KinRecordKey) =>
      run(
        () => voidIt({ environmentId, input: { orgId, key } }),
        key,
        () => null,
      ),
    unvoid: (key: KinRecordKey) =>
      run(
        () => unvoid({ environmentId, input: { orgId, key } }),
        key,
        () => null,
      ),
    /** The number Issue would give now; null when it can't be read. Changes nothing. */
    nextNumber: async (key: KinRecordKey) => {
      const read = await kinListSend({
        online: () => kinHostConnected(environmentId),
        send: () => readNext({ environmentId, input: { orgId, key } }),
      });
      return read.ok ? read.value.number : null;
    },
    makeReceipt: (
      key: KinRecordKey | undefined,
      input: Omit<Parameters<typeof receipt>[0]["input"], "orgId" | "clientRequestId">,
      clientRequestId: string,
    ) =>
      run(
        () => receipt({ environmentId, input: { orgId, ...input, clientRequestId } }),
        key,
        kinReceiptNotice,
      ),
    /** The document as it would be made, never filed; null when it couldn't be made. */
    preview: async (
      recipe: string,
      entry: KinRecordKey | undefined,
      inputs?: Readonly<Record<string, unknown>>,
    ) => {
      const made = await run(
        () =>
          render({
            environmentId,
            input: {
              orgId,
              recipe,
              ...(entry === undefined ? {} : { entry }),
              ...(inputs === undefined ? {} : { inputs }),
              preview: true,
              clientRequestId: uuidv4(),
            },
          }),
        undefined,
        () => null,
      );
      return made?.preview ?? null;
    },
    file: (
      recipe: string,
      entry: KinRecordKey,
      clientRequestId: string,
      inputs?: Readonly<Record<string, unknown>>,
    ) =>
      run(
        () =>
          render({
            environmentId,
            input: {
              orgId,
              recipe,
              entry,
              ...(inputs === undefined ? {} : { inputs }),
              clientRequestId,
            },
          }),
        entry,
        (made) => {
          setFiled(made.documents[0]?.key ?? null);
          return KIN_INVOICES.filed(made.documents);
        },
      ),
  };
}
