import { selectKinInboxView } from "@t3tools/client-runtime/kin/kinInboxModel";
import {
  KIN_PINS_COPY,
  kinPinFailureText,
  kinPinnableChats,
  type KinPinnableChat,
} from "@t3tools/client-runtime/kin/kinPins";
import { kinDirectory } from "@t3tools/client-runtime/kin/kinScreenState";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinChatId, KinOrgId, KinRecordKey } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Alert, AlertDescription } from "../components/ui/alert";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Spinner } from "../components/ui/spinner";
import { toastManager } from "../components/ui/toast";
import { KinAvatar } from "./KinAvatar";
import { kinClient } from "./kinClient";
import { useKinHostAt } from "./useKinHost";
import { useKinPinActions } from "./useKinPins";

/** Picker of the viewer's writable chats in chat-list order, for pinning a task, project or goal. */
export function KinPinToChatDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly recordKey: KinRecordKey;
  readonly recordTitle: string;
}) {
  const { environmentId, orgId, recordKey } = props;
  const host = useKinHostAt(environmentId);
  const inboxResult = useAtomValue(kinClient.inbox({ environmentId, input: {} }));
  const actions = useKinPinActions({ environmentId, orgId });
  const [pendingChatId, setPendingChatId] = useState<KinChatId | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const inbox = Option.getOrNull(AsyncResult.value(inboxResult))?.value ?? null;
  const chats =
    inbox === null
      ? null
      : kinPinnableChats({
          orgId,
          inbox: selectKinInboxView(inbox),
          directory: kinDirectory(host),
        });

  const pick = async (chat: KinPinnableChat) => {
    if (pendingChatId !== null) return;
    setPendingChatId(chat.chatId);
    setProblem(null);
    const outcome = await actions.pin({ chatId: chat.chatId, key: recordKey });
    setPendingChatId(null);
    if (AsyncResult.isFailure(outcome)) {
      setProblem(kinPinFailureText(squashAtomCommandFailure(outcome), "pin"));
      return;
    }
    props.onOpenChange(false);
    toastManager.add({ type: "success", title: KIN_PINS_COPY.pinnedTo(chat.title) });
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (pendingChatId !== null) return;
        if (!next) setProblem(null);
        props.onOpenChange(next);
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{KIN_PINS_COPY.pinToChat}</DialogTitle>
          <DialogDescription>{props.recordTitle}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2 px-6 pb-6">
          {problem === null ? null : (
            <Alert variant="error">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          )}
          {chats === null ? (
            <div
              className="flex items-center gap-2 py-4 text-sm text-muted-foreground"
              role="status"
            >
              <Spinner />
              {KIN_PINS_COPY.loadingChats}
            </div>
          ) : chats.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">{KIN_PINS_COPY.noChats}</p>
          ) : (
            <ul className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
              {chats.map((chat) => (
                <li key={chat.chatId}>
                  <button
                    type="button"
                    disabled={pendingChatId !== null}
                    onClick={() => void pick(chat)}
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-start text-sm text-foreground outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset disabled:opacity-50"
                  >
                    <KinAvatar avatar={chat.avatar} size="xs" />
                    <span className="min-w-0 flex-1 truncate">{chat.title}</span>
                    {pendingChatId === chat.chatId ? <Spinner /> : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
