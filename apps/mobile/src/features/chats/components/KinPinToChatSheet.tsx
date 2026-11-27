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
import { Pressable, ScrollView, View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../../components/ui/AppText";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { Sheet } from "../../../components/ui/Sheet";
import { kinClient } from "../state/kinClient";
import { useKinHostAt } from "../state/useKinHost";
import { useKinPinActions } from "../state/useKinPins";
import { KinAvatar } from "./KinAvatar";

/** Sheet listing the viewer's writable chats in chat-list order for pinning a record. */
export function KinPinToChatSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly recordKey: KinRecordKey;
  readonly recordTitle: string;
  readonly onClose: () => void;
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
    props.onClose();
  };

  return (
    <Sheet
      title={KIN_PINS_COPY.pinToChat}
      dismissDisabled={pendingChatId !== null}
      onClose={props.onClose}
    >
      <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerClassName="px-5 pb-10">
        <Text textRole="footnote" className="pb-3 text-foreground-muted">
          {props.recordTitle}
        </Text>
        {problem === null ? null : (
          <View className="pb-3">
            <ErrorBanner message={problem} />
          </View>
        )}
        {chats === null ? (
          <View className="flex-row items-center gap-2 py-4">
            <AppActivityIndicator size="small" />
            <Text textRole="footnote" className="text-foreground-muted">
              {KIN_PINS_COPY.loadingChats}
            </Text>
          </View>
        ) : chats.length === 0 ? (
          <Text textRole="body" className="py-2 text-foreground-muted">
            {KIN_PINS_COPY.noChats}
          </Text>
        ) : (
          chats.map((chat) => (
            <Pressable
              key={chat.chatId}
              accessibilityRole="button"
              disabled={pendingChatId !== null}
              onPress={() => void pick(chat)}
              className="min-h-11 flex-row items-center gap-3 border-b border-border py-3 active:opacity-70"
            >
              <KinAvatar avatar={chat.avatar} size="small" />
              <Text textRole="body" numberOfLines={1} className="min-w-0 flex-1 text-foreground">
                {chat.title}
              </Text>
              {pendingChatId === chat.chatId ? <AppActivityIndicator size="small" /> : null}
            </Pressable>
          ))
        )}
      </ScrollView>
    </Sheet>
  );
}
