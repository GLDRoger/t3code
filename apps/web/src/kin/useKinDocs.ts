import { useAtomValue } from "@effect/atom-react";
import {
  KIN_SEARCH_INITIAL,
  createKinSearch,
  kinDocChat,
  kinDocSuggestStarter,
  kinPendingRefAtom,
  kinPendingRefKey,
  type KinDocAsk,
  type KinSearchState,
} from "@t3tools/client-runtime/kin/kinDocs";
import { makeKinDocsHooks } from "@t3tools/client-runtime/kin/react/kinDocsHooks";
import type { KinDocDetail, KinLeadsListResult, KinMessageRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { prefillKinDraft } from "./kinDraft";
import { kinClient } from "./kinClient";
import { kinHookApp } from "./kinHookApp";
import { useKinOpenChat } from "./useKinOpenChat";
import { useKinInbox } from "./useKinHost";
import { kinSchedule, useKinPagedList, type KinWorkTarget } from "./useKinWork";

export const {
  useKinDocsLive,
  useKinDocsList,
  useKinDocsUnder,
  useKinWhatWeSell,
  useKinWhatWeSellStart,
  useKinDoc,
  useKinDocHistory,
  useKinSearch,
} = makeKinDocsHooks(kinHookApp, { useKinOpenChat, useKinPagedList });

/** The work items and docs matching what is typed in the command palette; none without a host. */
export function useKinPaletteHits(target: KinWorkTarget | null, text: string) {
  const [state, setState] = useState<KinSearchState>(KIN_SEARCH_INITIAL);
  const environmentId = target?.environmentId ?? null;
  const orgId = target?.orgId ?? null;
  const [held, setHeld] = useState<{
    readonly at: string | null;
    readonly search: ReturnType<typeof createKinSearch> | null;
  }>({ at: null, search: null });
  const at = environmentId === null || orgId === null ? null : `${environmentId}:${orgId}`;
  if (held.at !== at)
    setHeld({
      at,
      search:
        environmentId === null || orgId === null
          ? null
          : createKinSearch({
              onChange: setState,
              schedule: kinSchedule,
              read: ({ text: asked, closed }) =>
                kinClient.search.run(appAtomRegistry, {
                  environmentId,
                  input: { orgId, text: asked, closed, everything: true },
                }),
            }),
    });
  const { search } = held;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- abandons the search in flight when the palette or its host goes
  useEffect(() => search?.dispose, [search]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the palette owns its box; the server is asked as it settles
  useEffect(() => {
    search?.setText(text);
  }, [search, text]);
  return search === null || state.answered !== text.trim() ? [] : (state.hits ?? []);
}

/**
 * Opens the chat with the agent that keeps a doc, with what was pointed at waiting above its
 * composer. A teammate, who can't change a company doc, suggests instead: in their chat with that
 * agent or else the team agent, with a starter line, and the agent puts it to the owner. Null where
 * there is nobody to ask.
 */
export function useKinDocAsk(
  target: KinWorkTarget,
  doc: Pick<KinDocDetail, "owner" | "latest"> | null,
  me: Parameters<typeof kinDocChat>[2],
  ownerLevel: boolean,
) {
  const navigate = useNavigate();
  const inbox = useKinInbox();
  const leads = useAtomValue(
    ownerLevel
      ? noLeadsAtom
      : kinClient.leads({ environmentId: target.environmentId, input: { orgId: target.orgId } }),
  );
  const chats = inbox.state._tag === "ready" ? inbox.state.inbox.value.chats : [];
  const held = leads === null ? null : Option.getOrNull(AsyncResult.value(leads));
  const teamChat =
    held?.contacts?.find((contact) => contact.agentId === held.teamAgentId)?.chatId ?? null;
  const chatId =
    doc === null ? null : (kinDocChat(chats, doc, me)?.chatId ?? (ownerLevel ? null : teamChat));
  if (chatId === null) return null;
  return (ref: KinMessageRef, asked: KinDocAsk) => {
    const intent = ownerLevel || asked === "ask" ? asked : "suggest";
    appAtomRegistry.set(kinPendingRefAtom(kinPendingRefKey(target.environmentId, chatId)), {
      ref,
      intent,
    });
    if (intent === "suggest")
      prefillKinDraft(target.environmentId, target.orgId, chatId, kinDocSuggestStarter(ref));
    void navigate({
      to: "/kin/$environmentId/$orgId/$chatId",
      params: { environmentId: target.environmentId, orgId: target.orgId, chatId },
    });
  };
}

const noLeadsAtom = Atom.make<AsyncResult.AsyncResult<KinLeadsListResult, unknown> | null>(null);
