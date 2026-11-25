import { useAtomValue } from "@effect/atom-react";
import {
  KIN_ASK_RECORD,
  kinAskAgents,
  kinAskRecordDraft,
  type KinAskAgent,
} from "@t3tools/client-runtime/kin/kinAskRecord";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { Alert } from "react-native";

import type { AppBarAction, AppBarMenu } from "../../../components/ui/AppBar";
import { kinClient } from "./kinClient";
import { useKinOpenAgentChat, useKinOpenChat } from "./useKinOpenChat";
import type { KinWorkTarget } from "./useKinWork";

/**
 * Ask an agent about a task or project, as app bar items: any agent the viewer may message, its chat
 * made on the pick when they have none. One agent is a button that asks it, several are a menu to
 * pick from, none is nothing. The chat opens with the record named in its box.
 */
export function useKinAskRecord(
  { environmentId, orgId }: KinWorkTarget,
  record: { readonly key: string; readonly title: string } | null,
): { readonly actions: ReadonlyArray<AppBarAction>; readonly menus: ReadonlyArray<AppBarMenu> } {
  const openChat = useKinOpenChat();
  const openAgentChat = useKinOpenAgentChat();
  const result = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const agents = record === null ? [] : kinAskAgents(Option.getOrNull(AsyncResult.value(result)));
  const [only] = agents;
  if (record === null || only === undefined) return { actions: [], menus: [] };
  const draft = kinAskRecordDraft(record);
  const ask = async (agent: KinAskAgent) => {
    if (agent.chatId !== null) return openChat(environmentId, orgId, agent.chatId, draft);
    const problem = await openAgentChat(environmentId, orgId, agent.agentId, draft);
    if (problem !== null) Alert.alert(problem);
  };
  if (agents.length === 1)
    return {
      actions: [
        {
          accessibilityLabel: KIN_ASK_RECORD.ask(only.name),
          icon: "bubble.left",
          onPress: () => void ask(only),
        },
      ],
      menus: [],
    };
  return {
    actions: [],
    menus: [
      {
        title: KIN_ASK_RECORD.askWho,
        icon: "bubble.left",
        items: agents.map((agent) => ({
          id: `ask-${agent.agentId}`,
          title: agent.name,
          onPress: () => void ask(agent),
        })),
      },
    ],
  };
}
