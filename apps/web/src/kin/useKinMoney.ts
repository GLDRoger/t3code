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
import { kinMoneyAgent } from "@t3tools/client-runtime/kin/kinMoney";
import { kinWorkReadState } from "@t3tools/client-runtime/kin/kinWorkForms";
import {
  createKinPagedList,
  kinPagedListInitial,
  mapPage,
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
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { prefillKinDraft } from "./KinChatView";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import { kinHostConnected } from "./useKinHost";
import { kinWorkChoicesAtom, type KinWorkDirectory, type KinWorkTarget } from "./useKinWork";

const noListsAtom: Atom.Atom<AsyncResult.AsyncResult<KinListsResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noMoneyAtom: Atom.Atom<AsyncResult.AsyncResult<KinMoneySummary, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const noCompanyAtom: Atom.Atom<AsyncResult.AsyncResult<KinCompanyProfile, unknown>> = Atom.make(
  AsyncResult.initial(),
);

const listsAtom = ({ environmentId, orgId }: KinWorkTarget, archived: boolean) =>
  kinClient.workLists({ environmentId, input: archived ? { orgId, archived: true } : { orgId } });
const moneyAtom = ({ environmentId, orgId }: KinWorkTarget) =>
  kinClient.workMoney({ environmentId, input: { orgId } });

const refreshKinLists = (target: KinWorkTarget) => {
  appAtomRegistry.refresh(listsAtom(target, false));
  appAtomRegistry.refresh(listsAtom(target, true));
};

/** Reads again when Work says something changed; `seq` is null while that isn't known. */
function useRereadOnChange(seq: number | null, reread: () => void) {
  const seen = useRef(seq);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the host's figures again when the host announces a change to Work
  useEffect(() => {
    if (seq === null || seq === seen.current) return;
    const first = seen.current === null;
    seen.current = seq;
    if (!first) reread();
  }, [seq, reread]);
}

/** Every list there is, as its definition. `enabled` is off for a viewer the host would refuse. */
export function useKinLists(
  target: KinWorkTarget,
  options: { readonly enabled: boolean; readonly archived?: boolean; readonly seq: number | null },
) {
  const archived = options.archived === true;
  const atom = listsAtom(target, archived);
  const state = kinWorkReadState(useAtomValue(options.enabled ? atom : noListsAtom));
  useRereadOnChange(options.seq, () => appAtomRegistry.refresh(atom));
  return { state, refresh: () => appAtomRegistry.refresh(atom) };
}

export type KinListsHandle = ReturnType<typeof useKinLists>;

export const kinListsOf = (handle: KinListsHandle): ReadonlyArray<KinListDefinition> =>
  handle.state._tag === "ready" ? handle.state.value.lists : [];

/** The Money summary, read again whenever Work changes. */
export function useKinMoneySummary(
  target: KinWorkTarget,
  options: { readonly enabled: boolean; readonly seq: number | null },
) {
  const atom = moneyAtom(target);
  const state = kinWorkReadState(useAtomValue(options.enabled ? atom : noMoneyAtom));
  useRereadOnChange(options.seq, () => appAtomRegistry.refresh(atom));
  return { state, refresh: () => appAtomRegistry.refresh(atom) };
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
    createKinPagedList<KinListFilter, KinRecord>({
      initial,
      sameFilter: kinListSameFilter,
      idOf: (record) => record.recordId,
      onChange: setState,
      schedule,
      read: async (filter, page) => {
        const result = await kinClient.workList.run(appAtomRegistry, {
          environmentId,
          input: { ...kinListQuery(orgId, list, filter), ...page },
        });
        if (AsyncResult.isSuccess(result) && result.value.totals !== undefined)
          setTotals({ filter, totals: result.value.totals });
        return mapPage(result, (value) => ({ ...value, rows: value.records }));
      },
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
  const item = kinClient.workItem({ environmentId, input: { orgId, key } });
  const run = async <A>(send: () => Promise<AsyncResult.AsyncResult<A, unknown>>) => {
    setBusy(true);
    setProblem(null);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: send as Parameters<typeof kinListSend<A>>[0]["send"],
    });
    setBusy(false);
    // The entry is read again either way: the answer, or what it became meanwhile.
    appAtomRegistry.refresh(item);
    appAtomRegistry.refresh(moneyAtom({ environmentId, orgId }));
    return outcome;
  };
  const shown = async <A>(send: () => Promise<AsyncResult.AsyncResult<A, unknown>>) => {
    const outcome = await run(send);
    if (!outcome.ok) setProblem(outcome.problem);
    return outcome.ok;
  };
  type Patch = Omit<Parameters<typeof update>[0]["input"], "orgId" | "key" | "rev">;
  return {
    busy,
    problem,
    dismiss: () => setProblem(null),
    update: (rev: number, patch: Patch) =>
      shown(() => update({ environmentId, input: { orgId, key, rev, ...patch } })),
    /** For a box that shows its own problem beside what was typed: the reason, or null once saved. */
    edit: async (rev: number, patch: Patch) => {
      const outcome = await run(() =>
        update({ environmentId, input: { orgId, key, rev, ...patch } }),
      );
      return outcome.ok ? null : outcome.problem;
    },
    pay: (input: Omit<Parameters<typeof pay>[0]["input"], "orgId" | "key">) =>
      shown(() => pay({ environmentId, input: { orgId, key, ...input } })),
    takeBack: (paymentId: string) =>
      shown(() => takeBack({ environmentId, input: { orgId, key, paymentId } })),
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
      refreshKinLists(target);
      if (!outcome.ok) setProblem(outcome.problem);
      return outcome.ok;
    },
  };
}

/** Opens the chat with the agent that keeps the books, with a message ready to send. */
export function useKinAskAgent({ environmentId, orgId }: KinWorkTarget) {
  const navigate = useNavigate();
  const canRestore = useAtomValue(kinClient.leadRestore.permissionAtom(environmentId));
  const result = useAtomValue(
    canRestore
      ? kinClient.agents({ environmentId, orgId })
      : kinClient.leads({ environmentId, input: { orgId } }),
  );
  const agent = kinMoneyAgent(Option.getOrNull(AsyncResult.value(result))?.leads ?? []);
  if (agent === null) return null;
  return {
    name: agent.name,
    ask: (message: string) => {
      prefillKinDraft(environmentId, orgId, agent.ownerChatId, message);
      void navigate({
        to: "/kin/$environmentId/$orgId/$chatId",
        params: { environmentId, orgId, chatId: agent.ownerChatId },
      });
    },
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

const noReceiptsAtom: ReturnType<typeof kinClient.receipts> = Atom.make(AsyncResult.initial());
const noRecipesAtom: ReturnType<typeof kinClient.recipes> = Atom.make(AsyncResult.initial());

/** Money's receipts, newest first, read again whenever Work changes. */
export function useKinReceipts(
  target: KinWorkTarget,
  options: { readonly enabled: boolean; readonly seq: number | null },
) {
  const atom = kinClient.receipts({
    environmentId: target.environmentId,
    input: { orgId: target.orgId },
  });
  const state = kinWorkReadState(useAtomValue(options.enabled ? atom : noReceiptsAtom));
  useRereadOnChange(options.seq, () => appAtomRegistry.refresh(atom));
  return { state, refresh: () => appAtomRegistry.refresh(atom) };
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
  const receipt = useAtomCommand(kinClient.makeReceipt, { reportFailure: false });
  const render = useAtomCommand(kinClient.docRender, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reread = (key?: KinRecordKey) => {
    if (key !== undefined)
      appAtomRegistry.refresh(kinClient.workItem({ environmentId, input: { orgId, key } }));
    appAtomRegistry.refresh(moneyAtom({ environmentId, orgId }));
    appAtomRegistry.refresh(kinClient.receipts({ environmentId, input: { orgId } }));
  };
  const run = async <A>(
    send: () => Promise<AsyncResult.AsyncResult<A, unknown>>,
    key: KinRecordKey | undefined,
    said: (value: A) => string | null,
  ): Promise<A | null> => {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: send as Parameters<typeof kinListSend<A>>[0]["send"],
    });
    setBusy(false);
    reread(key);
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
    dismiss: () => {
      setProblem(null);
      setNotice(null);
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
    preview: async (recipe: string, entry: KinRecordKey | undefined) => {
      const made = await run(
        () =>
          render({
            environmentId,
            input: {
              orgId,
              recipe,
              ...(entry === undefined ? {} : { entry }),
              preview: true,
              clientRequestId: randomUUID(),
            },
          }),
        undefined,
        () => null,
      );
      return made?.preview ?? null;
    },
    file: (recipe: string, entry: KinRecordKey, clientRequestId: string) =>
      run(
        () => render({ environmentId, input: { orgId, recipe, entry, clientRequestId } }),
        entry,
        () => KIN_INVOICES.filed,
      ),
  };
}
