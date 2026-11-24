import { useAtomValue } from "@effect/atom-react";
import type {
  KinAttachment,
  KinBillBatchSummary,
  KinBillRow,
  KinBillsListResult,
  KinChatId,
  KinWidgetId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useRef, useState } from "react";

import {
  kinBillsAddingStart,
  kinBillsKeptAll,
  kinBillsSend,
  kinBillsStep,
  type KinBillRowView,
  type KinBillsEvent,
} from "../kinBills.ts";
import { kinListSend } from "../kinLists.ts";
import type { KinScreenTarget } from "../kinScreenReads.ts";
import type { AtomCommandResult } from "../../state/runtime.ts";
import { kinWorkReadState } from "../kinWorkForms.ts";
import type { KinHookApp } from "./kinHookApp.ts";

const none: Atom.Atom<AsyncResult.AsyncResult<KinBillsListResult, unknown>> = Atom.make(
  AsyncResult.initial(),
);
const NO_ROWS: ReadonlyArray<KinBillRow> = [];

export type KinBillTap = "keep" | "drop" | "addAnyway" | "dismiss" | "readAgain";

/** Bills added in bulk on one app's client: the batches, one batch's bills, its taps, and adding. */
export function makeKinBillsHooks<R, ER>(app: KinHookApp<R, ER>) {
  const { kinClient, registry, useAtomCommand, kinHostConnected, newId } = app;
  const batchesAtom = ({ environmentId, orgId }: KinScreenTarget) =>
    kinClient.bills({ environmentId, input: { orgId } });
  const refreshBatches = (target: KinScreenTarget) => registry.refresh(batchesAtom(target));

  /** The batches, newest first; nothing is asked of a host that would refuse this viewer. */
  function useKinBillBatches(target: KinScreenTarget, enabled = true) {
    const allowed = useAtomValue(kinClient.billsRead.permissionAtom(target.environmentId));
    const state = kinWorkReadState(
      useAtomValue(enabled && allowed ? batchesAtom(target) : none),
    );
    return { allowed, state, refresh: () => refreshBatches(target) };
  }

  /**
   * One batch's bills in the order added. An add takes at most 100 files and a page holds 50, so
   * two pages hold any batch. `follow` is its card, for the person who added it.
   */
  function useKinBillBatch(
    target: KinScreenTarget,
    batchId: string,
    follow: { readonly chatId: KinChatId; readonly widgetId: KinWidgetId } | null,
  ) {
    const input = {
      orgId: target.orgId,
      batchId,
      ...(follow === null ? {} : { follow }),
    };
    const firstAtom = kinClient.bills({ environmentId: target.environmentId, input });
    const first = kinWorkReadState(useAtomValue(firstAtom));
    const next = first._tag === "ready" ? (first.value.next ?? null) : null;
    const secondAtom =
      next === null
        ? none
        : kinClient.bills({
            environmentId: target.environmentId,
            input: { ...input, cursor: next },
          });
    const second = kinWorkReadState(useAtomValue(secondAtom));
    const rows =
      first._tag !== "ready"
        ? NO_ROWS
        : second._tag === "ready"
          ? [...first.value.bills, ...second.value.bills]
          : first.value.bills;
    return {
      state: first,
      rows,
      refresh: () => {
        registry.refresh(firstAtom);
        if (next !== null) registry.refresh(secondAtom);
        refreshBatches(target);
      },
    };
  }

  /**
   * A bill's taps and Keep all. Each request keeps its id until the host answers it, so a tap
   * repeated after a dropped connection is the same request.
   */
  function useKinBillActions(target: KinScreenTarget, batchId: string, refresh: () => void) {
    const { environmentId, orgId } = target;
    const allowed = useAtomValue(kinClient.billsKeepRead.permissionAtom(environmentId));
    const confirm = useAtomCommand(kinClient.workConfirm, { reportFailure: false });
    const decline = useAtomCommand(kinClient.workDecline, { reportFailure: false });
    const addAnyway = useAtomCommand(kinClient.billsAddAnyway, { reportFailure: false });
    const dismiss = useAtomCommand(kinClient.billsDismiss, { reportFailure: false });
    const readAgain = useAtomCommand(kinClient.billsReadAgain, { reportFailure: false });
    const keepRead = useAtomCommand(kinClient.billsKeepRead, { reportFailure: false });
    const ids = useRef(new Map<string, string>());
    const idFor = (key: string) => {
      const held = ids.current.get(key) ?? newId();
      ids.current.set(key, held);
      return held;
    };
    const [busy, setBusy] = useState<string | null>(null);
    const [problem, setProblem] = useState<{ readonly key: string; readonly text: string } | null>(
      null,
    );
    const [kept, setKept] = useState<ReturnType<typeof kinBillsKeptAll> | null>(null);
    const online = () => kinHostConnected(environmentId);

    const send = (
      view: KinBillRowView,
      tap: KinBillTap,
    ): (() => Promise<AtomCommandResult<unknown, unknown>>) | null => {
      const sha256 = view.row.sha256;
      switch (tap) {
        case "keep":
        case "drop": {
          const expense = view.expense;
          if (expense === null) return null;
          const input = { orgId, key: expense.key, rev: expense.rev };
          return () => (tap === "keep" ? confirm : decline)({ environmentId, input });
        }
        case "addAnyway":
          return () =>
            addAnyway({
              environmentId,
              input: { orgId, sha256, clientRequestId: idFor(`addAnyway:${sha256}`) },
            });
        case "dismiss":
          return () => dismiss({ environmentId, input: { orgId, sha256 } });
        case "readAgain":
          return () => readAgain({ environmentId, input: { orgId, sha256 } });
      }
    };

    return {
      allowed,
      busy,
      problem,
      kept,
      act: async (view: KinBillRowView, tap: KinBillTap) => {
        const request = send(view, tap);
        if (request === null || busy !== null) return;
        setBusy(view.key);
        setProblem(null);
        const outcome = await kinListSend({ online, send: request });
        setBusy(null);
        if (outcome.ok) {
          ids.current.delete(`${tap}:${view.row.sha256}`);
          refresh();
        } else {
          setProblem({ key: view.key, text: outcome.problem });
        }
      },
      keepAll: async () => {
        if (busy !== null) return;
        setBusy("all");
        setProblem(null);
        const key = `keepRead:${batchId}`;
        const outcome = await kinListSend({
          online,
          send: () =>
            keepRead({
              environmentId,
              input: { orgId, batchId, clientRequestId: idFor(key) },
            }),
        });
        setBusy(null);
        if (outcome.ok) {
          ids.current.delete(key);
          setKept(kinBillsKeptAll(outcome.value));
          refresh();
        } else {
          setProblem({ key: "all", text: outcome.problem });
        }
      },
    };
  }

  /**
   * Adding bills: the chosen files, each one's upload, then one `kin.bills.add`. The app hands
   * over how a file of its own uploads; the host's refusal is said as the host said it.
   */
  function useKinBillsAdd<F>(
    target: KinScreenTarget,
    upload: (source: F, name: string) => Promise<KinAttachment>,
  ) {
    const { environmentId, orgId } = target;
    const allowed = useAtomValue(kinClient.billsAdd.permissionAtom(environmentId));
    const add = useAtomCommand(kinClient.billsAdd, { reportFailure: false });
    const [state, setState] = useState(kinBillsAddingStart<F>);
    const held = useRef(state);
    const dispatch = (event: KinBillsEvent<F>) => {
      held.current = kinBillsStep(held.current, event);
      setState(held.current);
    };
    return {
      allowed,
      state,
      choose: (
        files: ReadonlyArray<{
          readonly id: string;
          readonly name: string;
          readonly mimeType: string;
          readonly source: F;
        }>,
      ) => dispatch({ _tag: "chose", files }),
      remove: (id: string) => dispatch({ _tag: "removed", id }),
      send: () =>
        kinBillsSend({
          state: () => held.current,
          dispatch,
          upload,
          newId,
          add: async (attachments, clientRequestId) => {
            const outcome = await kinListSend({
              online: () => kinHostConnected(environmentId),
              send: () =>
                add({ environmentId, input: { orgId, attachments, clientRequestId } }),
            });
            if (!outcome.ok) return { ok: false, problem: outcome.problem };
            refreshBatches(target);
            return { ok: true, value: outcome.value };
          },
        }),
    };
  }

  return { useKinBillBatches, useKinBillBatch, useKinBillActions, useKinBillsAdd };
}

/** The batch a card or address names, from the batches the host listed; null before it loads. */
export const kinBillBatchOf = (
  batches: ReadonlyArray<KinBillBatchSummary>,
  batchId: string,
): KinBillBatchSummary | null => batches.find((batch) => batch.batchId === batchId) ?? null;
