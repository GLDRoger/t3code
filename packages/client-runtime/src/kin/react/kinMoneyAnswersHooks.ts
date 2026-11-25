import { useAtomValue } from "@effect/atom-react";
import type {
  KinCash,
  KinDocumentLine,
  KinMoneyBudgetSetInput,
  KinMoneyBudgets,
  KinNewExpenseInput,
  KinNewInvoiceInput,
  KinOutlook,
  KinPersonId,
  KinRecordKey,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";

import {
  kinAmountAsking,
  kinAmountConfirmed,
  kinListSend,
  type KinAmountAsk,
} from "../kinLists.ts";
import { KIN_OUTLOOK, KIN_QUOTES, type KinPartnerSeen } from "../kinMoneyAnswers.ts";
import type { KinScreenTarget } from "../kinScreenReads.ts";
import { kinWorkReadState } from "../kinWorkForms.ts";
import type { AtomCommandResult } from "../../state/runtime.ts";
import type { KinHookApp, KinUseMoneyLive } from "./kinHookApp.ts";

const none = <A>(): Atom.Atom<AsyncResult.AsyncResult<A, unknown>> =>
  Atom.make(AsyncResult.initial());
const noCash = none<KinCash>();
const noOutlook = none<KinOutlook>();
const noBudgets = none<KinMoneyBudgets>();

/** Cash, the outlook, budgets and invoices made from quotes, on one app's client. */
export function makeKinMoneyAnswersHooks<R, ER>(
  app: KinHookApp<R, ER>,
  uses: { readonly useKinMoneyLive: KinUseMoneyLive },
) {
  const { kinClient, registry, useAtomCommand, kinHostConnected } = app;
  const { useKinMoneyLive } = uses;
  const cashAtom = ({ environmentId, orgId }: KinScreenTarget) =>
    kinClient.workCash({ environmentId, input: { orgId } });
  const outlookAtom = ({ environmentId, orgId }: KinScreenTarget) =>
    kinClient.workOutlook({ environmentId, input: { orgId } });
  const budgetsAtom = ({ environmentId, orgId }: KinScreenTarget) =>
    kinClient.workBudgets({ environmentId, input: { orgId } });

  /**
   * A Money answer: from Money's stream where the host streams it to this viewer, else read again
   * when its topic moves and whenever a money list changes.
   */
  function useAnswer<A>(
    read: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
    live:
      | {
          readonly atom: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>;
          readonly refresh: () => void;
        }
      | null
      | undefined,
    fallback: Atom.Atom<AsyncResult.AsyncResult<A, unknown>>,
    enabled: boolean,
  ) {
    const atom = live?.atom ?? read;
    const state = kinWorkReadState(useAtomValue(enabled && live !== undefined ? atom : fallback));
    return { state, refresh: live?.refresh ?? (() => registry.refresh(atom)) };
  }

  const useKinCash = (target: KinScreenTarget, enabled: boolean) =>
    useAnswer(cashAtom(target), useKinMoneyLive(target, "cash"), noCash, enabled);
  const useKinOutlook = (target: KinScreenTarget, enabled: boolean) =>
    useAnswer(outlookAtom(target), useKinMoneyLive(target, "outlook"), noOutlook, enabled);
  const useKinBudgets = (target: KinScreenTarget, enabled: boolean) =>
    useAnswer(budgetsAtom(target), useKinMoneyLive(target, "budgets"), noBudgets, enabled);

  /** The owner's set, change and removal of a budget; says why when the host refuses. */
  function useKinBudgetSet(target: KinScreenTarget) {
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
        registry.refresh(budgetsAtom(target));
        if (!outcome.ok) setProblem(outcome.problem);
        return outcome.ok;
      },
    };
  }

  /** The lines an entry's latest document was made with, for its Make invoice form. */
  function useKinEntryLines(target: KinScreenTarget) {
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
  function useKinInvoiceFromQuote(target: KinScreenTarget) {
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
        registry.refresh(outlookAtom(target));
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

  /**
   * An invoice typed by hand: the draft and its document, or why nothing was saved. The form keeps
   * every word either way; a retry with the same request id finishes the same draft.
   */
  function useKinNewInvoice(target: KinScreenTarget) {
    const send = useAtomCommand(kinClient.workNewInvoice, { reportFailure: false });
    const saving = useAsking(target);
    return {
      busy: saving.busy,
      problem: saving.problem,
      slip: saving.slip,
      /** `about` is the amount as the form holds it (`kinInvoiceAmountAbout`). */
      save: (input: KinNewInvoiceInput, about: string) =>
        saving.send(about, (confirmed) =>
          send({ environmentId: target.environmentId, input: { ...input, ...confirmed } }),
        ),
    };
  }

  /** An expense typed by hand: its key, or why nothing was saved, the words kept. */
  function useKinNewExpense(target: KinScreenTarget) {
    const send = useAtomCommand(kinClient.workNewExpense, { reportFailure: false });
    const saving = useAsking(target);
    return {
      busy: saving.busy,
      problem: saving.problem,
      slip: saving.slip,
      save: async (input: KinNewExpenseInput, about: string) =>
        (
          await saving.send(about, (confirmed) =>
            send({ environmentId: target.environmentId, input: { ...input, ...confirmed } }),
          )
        )?.expense ?? null,
    };
  }

  /**
   * The owner or a co-owner names the person an import's partner address is (null: the owed
   * expenses with none); Money reads again after, and says so when nothing was left to match.
   */
  function useKinMatchPartner(target: KinScreenTarget) {
    const send = useAtomCommand(kinClient.workMatchPartner, { reportFailure: false });
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    return {
      busy,
      problem,
      match: async (
        address: string | null,
        seen: KinPartnerSeen,
        personId: KinPersonId,
        settled?: "owed" | "repaid",
      ) => {
        setBusy(true);
        setProblem(null);
        const outcome = await kinListSend({
          online: () => kinHostConnected(target.environmentId),
          send: () =>
            send({
              environmentId: target.environmentId,
              input: {
                orgId: target.orgId,
                personId,
                ...(address === null ? {} : { address }),
                ...(settled === undefined ? {} : { settled }),
                seen,
              },
            }),
        });
        setBusy(false);
        registry.refresh(outlookAtom(target));
        if (!outcome.ok) setProblem(outcome.changed ? KIN_OUTLOOK.matchMoved : outcome.problem);
        else if (outcome.value.matched.length === 0) setProblem(KIN_OUTLOOK.nothingMatched);
        return outcome.ok;
      },
    };
  }

  /**
   * One form's save that asks once about an amount far above its list: the line stands while the
   * amount is the one asked about, and the next save of it keeps it.
   */
  function useAsking(target: KinScreenTarget) {
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<string | null>(null);
    const [asked, setAsked] = useState<KinAmountAsk | null>(null);
    return {
      busy,
      problem,
      slip: (about: string) => kinAmountAsking(asked, about)?.line ?? null,
      send: async <A>(
        about: string,
        send: (confirmed: {
          readonly amountConfirmed: boolean;
        }) => Promise<AtomCommandResult<A, unknown>>,
      ) => {
        setBusy(true);
        setProblem(null);
        const outcome = await kinListSend({
          online: () => kinHostConnected(target.environmentId),
          send: () => send(kinAmountConfirmed(asked, about)),
        });
        setBusy(false);
        if (!outcome.ok && outcome.slip !== undefined) setAsked({ line: outcome.slip, about });
        else if (!outcome.ok) setProblem(outcome.problem);
        return outcome.ok ? outcome.value : null;
      },
    };
  }

  return {
    useKinNewInvoice,
    useKinNewExpense,
    useKinMatchPartner,
    useKinCash,
    useKinOutlook,
    useKinBudgets,
    useKinBudgetSet,
    useKinEntryLines,
    useKinInvoiceFromQuote,
  };
}
