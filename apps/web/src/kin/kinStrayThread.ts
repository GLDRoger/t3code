import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import { toastManager } from "../components/ui/toast";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { kinClient } from "./kinClient";
import { kinHostAtom, kinHostKeptTarget } from "./useKinHost";

const KIN_STRAY_THREAD_COPY = {
  helperOf: (name: string) =>
    `That was one of ${name}'s helper tasks. Kin doesn't open those: ask ${name} what it did.`,
  workOf: (name: string) => `That was ${name}'s own working thread. Kin doesn't open those.`,
  unknown: "That link was to an agent's working thread. Kin doesn't open those.",
} as const;

type StrayLanding =
  | { readonly _tag: "pending" }
  | {
      readonly _tag: "settled";
      readonly text: string;
      readonly chat: {
        readonly environmentId: EnvironmentId;
        readonly orgId: string;
        readonly chatId: string;
      } | null;
    };

const UNKNOWN: StrayLanding = { _tag: "settled", text: KIN_STRAY_THREAD_COPY.unknown, chat: null };

/**
 * Whose a stray thread was: the agent its root thread is titled after. Kin titles an agent's
 * working threads with its name; a renamed agent's older ones don't match and land on Kin's home.
 */
const strayLandingAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [string, string];
  const ref = scopeThreadRef(EnvironmentId.make(environmentId), ThreadId.make(threadId));
  return Atom.make((get): StrayLanding => {
    const host = get(kinHostAtom);
    if (host._tag === "searching") return { _tag: "pending" };
    const target = kinHostKeptTarget(host);
    if (target === null || target.environmentId !== ref.environmentId) {
      return host._tag === "host" && host.probe._tag === "pending" ? { _tag: "pending" } : UNKNOWN;
    }
    if (!get(environmentShell.hasSnapshotAtom(ref.environmentId))) return { _tag: "pending" };
    const thread = get(environmentThreadShells.threadShellAtom(ref));
    if (thread === null) return UNKNOWN;
    const rootId = thread.lineage.rootThreadId;
    const root =
      rootId === thread.id
        ? thread
        : get(environmentThreadShells.threadShellAtom(scopeThreadRef(ref.environmentId, rootId)));
    const leads = get(
      kinClient.leads({ environmentId: target.environmentId, input: { orgId: target.orgId } }),
    );
    if (AsyncResult.isInitial(leads)) return { _tag: "pending" };
    const named = Option.getOrNull(AsyncResult.value(leads))?.leads.filter(
      (lead) => lead.name === root?.title.trim(),
    );
    const lead = named?.length === 1 ? named[0]! : null;
    if (lead === null) return UNKNOWN;
    return {
      _tag: "settled",
      text:
        root === thread ? KIN_STRAY_THREAD_COPY.workOf(lead.name) : KIN_STRAY_THREAD_COPY.helperOf(lead.name),
      chat: { ...target, chatId: lead.ownerChatId },
    };
  }).pipe(Atom.withLabel(`kin:stray-thread:${key}`));
});

/**
 * After the guard turned a thread's address back to Kin's home: opens the chat of the agent whose
 * thread it was, when that is known, and says in one line what happened.
 */
export function startKinStrayThreadLanding(
  router: AnyRouter,
  registry: AtomRegistry.AtomRegistry,
): () => void {
  let stopWaiting = () => {};
  const land = () => {
    const { location } = router.state;
    const stray = location.state.kinStrayThread;
    if (stray === undefined || location.pathname !== "/kin") return;
    const landedAt = location.state.__TSR_key;
    stopWaiting();
    let done = false;
    const unsubscribe = registry.subscribe(
      strayLandingAtom(JSON.stringify([stray.environmentId, stray.threadId])),
      (landing) => {
        if (done || landing._tag === "pending") return;
        done = true;
        stopWaiting();
        // The person has moved on while Kin looked: their page stays.
        if (router.state.location.state.__TSR_key !== landedAt) return;
        if (landing.chat !== null)
          void router.navigate({
            to: "/kin/$environmentId/$orgId/$chatId",
            params: landing.chat,
            replace: true,
          });
        else void router.navigate({ to: "/kin", replace: true });
        toastManager.add({ type: "info", title: landing.text });
      },
      { immediate: true },
    );
    stopWaiting = unsubscribe;
    if (done) unsubscribe();
  };
  land();
  const stopListening = router.subscribe("onResolved", land);
  return () => {
    stopListening();
    stopWaiting();
  };
}
