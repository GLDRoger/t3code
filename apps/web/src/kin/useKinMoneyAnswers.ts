import { useAtomValue } from "@effect/atom-react";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import { KIN_QUOTES } from "@t3tools/client-runtime/kin/kinMoneyAnswers";
import { kinWorkReadState } from "@t3tools/client-runtime/kin/kinWorkForms";
import type {
  KinCash,
  KinDocumentLine,
  KinMoneyBudgetSetInput,
  KinMoneyBudgets,
  KinOutlook,
  KinRecordKey,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { kinHostConnected } from "./useKinHost";
import { useRereadOnChange } from "./useKinMoney";
import type { KinWorkTarget } from "./useKinWork";

const none = <A>(): Atom.Atom<AsyncResult.AsyncResult<A, unknown>> =>
  Atom.make(AsyncResult.initial());
const noCash = none<KinCash>();
const noOutlook = none<KinOutlook>();
const noBudgets = none<KinMoneyBudgets>();

const cashAtom = ({ environmentId, orgId }: KinWorkTarget) =>
  kinClient.workCash({ environmentId, input: { orgId } });
const outlookAtom = ({ environmentId, orgId }: KinWorkTarget) =>
  kinClient.workOutlook({ environmentId, input: { orgId } });
const budgetsAtom = ({ environmentId, orgId }: KinWorkTarget) =>
  kinClient.workBudgets({ environmentId, input: { orgId } });

/** A Money answer, read again when its topic moves and whenever Work changes. */
function useAnswer<A>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  fallback: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
  enabled: boolean,
  seq: number | null,
) {
  const state = kinWorkReadState(useAtomValue(enabled ? atom : fallback));
  useRereadOnChange(seq, () => appAtomRegistry.refresh(atom));
  return { state, refresh: () => appAtomRegistry.refresh(atom) };
}

export const useKinCash = (target: KinWorkTarget, enabled: boolean, seq: number | null) =>
  useAnswer(cashAtom(target), noCash, enabled, seq);
export const useKinOutlook = (target: KinWorkTarget, enabled: boolean, seq: number | null) =>
  useAnswer(outlookAtom(target), noOutlook, enabled, seq);
export const useKinBudgets = (target: KinWorkTarget, enabled: boolean, seq: number | null) =>
  useAnswer(budgetsAtom(target), noBudgets, enabled, seq);

/** The owner's set, change and removal of a budget; says why when the host refuses. */
export function useKinBudgetSet(target: KinWorkTarget) {
  const send = useAtomCommand(kinClient.workSetBudget, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return {
    busy,
    problem,
    dismiss: () => setProblem(null),
    set: async (input: KinMoneyBudgetSetInput) => {
      setBusy(true);
      setProblem(null);
      const outcome = await kinListSend({
        online: () => kinHostConnected(target.environmentId),
        send: () => send({ environmentId: target.environmentId, input }),
      });
      setBusy(false);
      appAtomRegistry.refresh(budgetsAtom(target));
      if (!outcome.ok) setProblem(outcome.problem);
      return outcome.ok;
    },
  };
}

/** The lines an entry's latest document was made with, for its Make invoice form. */
export function useKinEntryLines(target: KinWorkTarget) {
  const read = useAtomCommand(kinClient.workEntryLines, { reportFailure: false });
  return async (key: KinRecordKey): Promise<ReadonlyArray<KinDocumentLine> | null> => {
    const outcome = await kinListSend({
      online: () => kinHostConnected(target.environmentId),
      send: () =>
        read({ environmentId: target.environmentId, input: { orgId: target.orgId, key } }),
    });
    return outcome.ok ? outcome.value.lines : null;
  };
}

/** "Make invoice" on a quote: the draft invoice from it, and what Kin said. */
export function useKinInvoiceFromQuote(target: KinWorkTarget) {
  const send = useAtomCommand(kinClient.workInvoiceFromQuote, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{
    readonly problem: string | null;
    readonly notice: string | null;
    readonly invoice: KinRecordKey | null;
  }>({ problem: null, notice: null, invoice: null });
  return {
    busy,
    ...said,
    make: async (key: KinRecordKey, clientRequestId: string) => {
      setBusy(true);
      setSaid({ problem: null, notice: null, invoice: null });
      const outcome = await kinListSend({
        online: () => kinHostConnected(target.environmentId),
        send: () =>
          send({
            environmentId: target.environmentId,
            input: { orgId: target.orgId, key, clientRequestId },
          }),
      });
      setBusy(false);
      appAtomRegistry.refresh(outlookAtom(target));
      if (!outcome.ok) return setSaid({ problem: outcome.problem, notice: null, invoice: null });
      const { invoice, problems } = outcome.value;
      setSaid({
        problem: null,
        notice:
          problems.length === 0
            ? KIN_QUOTES.invoiceMade(invoice)
            : `${KIN_QUOTES.invoiceMade(invoice)} ${KIN_QUOTES.invoiceProblems} ${problems.join(" ")}`,
        invoice,
      });
    },
  };
}
