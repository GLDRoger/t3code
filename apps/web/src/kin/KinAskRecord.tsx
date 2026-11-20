import { useAtomValue } from "@effect/atom-react";
import {
  KIN_ASK_RECORD,
  kinAskAgents,
  kinAskRecordDraft,
  type KinAskAgent,
} from "@t3tools/client-runtime/kin/kinAskRecord";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { ChevronDownIcon, MessageSquareIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { kinClient } from "./kinClient";
import { useKinOpenChat } from "./useKinOpenChat";
import type { KinWorkTarget } from "./useKinWork";

/**
 * Ask an agent about a task or project, with the record named in the chat's box. One agent is asked
 * directly; several are picked from a menu. Nothing shows when the viewer can message no agent.
 * The chat is pushed over the task without closing it first, so Back returns to the task.
 */
export function KinAskRecord(
  props: KinWorkTarget & {
    readonly record: { readonly key: string; readonly title: string };
    readonly disabled?: boolean;
  },
) {
  const { environmentId, orgId } = props;
  const openChat = useKinOpenChat();
  const result = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const agents = kinAskAgents(Option.getOrNull(AsyncResult.value(result)));
  const ask = (agent: KinAskAgent) => {
    openChat(environmentId, orgId, agent.chatId, kinAskRecordDraft(props.record));
  };
  const [only] = agents;
  if (only === undefined) return null;
  if (agents.length === 1)
    return (
      <Button size="sm" variant="outline" disabled={props.disabled} onClick={() => ask(only)}>
        <MessageSquareIcon />
        {/* Agent names run to 80 characters; a long one must not push the header off the screen. */}
        <span className="max-w-40 truncate">{KIN_ASK_RECORD.ask(only.name)}</span>
      </Button>
    );
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="outline" disabled={props.disabled} />}>
        <MessageSquareIcon />
        {KIN_ASK_RECORD.askWho}
        <ChevronDownIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        {agents.map((agent) => (
          <MenuItem key={agent.agentId} onClick={() => ask(agent)}>
            {agent.name}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}
