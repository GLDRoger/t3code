import { useAtomMount } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import { EnvironmentId, KinChatId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { kinClient } from "../state/kinClient";
import { dismissKinNotifications } from "./kinNotificationSync";

const subscribeAppState = (onChange: () => void) => {
  const subscription = AppState.addEventListener("change", onChange);
  return () => subscription.remove();
};
const appIsActive = () => AppState.currentState === "active";

const isEnvironmentId = Schema.is(EnvironmentId);
const isChatId = Schema.is(KinChatId);

function Watch(props: { readonly environmentId: EnvironmentId; readonly chatId: KinChatId }) {
  const { environmentId, chatId } = props;
  useAtomMount(kinClient.pushWatch({ environmentId, input: { chatId } }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- delivered notifications live in the OS, outside React
  useEffect(() => {
    void dismissKinNotifications(environmentId, (id) => id === chatId).catch((cause: unknown) =>
      console.warn("Clearing this chat's Kin notifications failed", cause),
    );
  }, [environmentId, chatId]);
  return null;
}

/**
 * While this chat is focused and the app is in front, the host doesn't push it to this device,
 * and what it pushed before is cleared from the notification pane.
 */
export function KinChatPushWatch(props: {
  readonly environmentId: string;
  readonly chatId: string;
}) {
  const focused = useIsFocused();
  const active = useSyncExternalStore(subscribeAppState, appIsActive);
  const { environmentId, chatId } = props;
  // Route params come from links, so they are checked before they reach the host.
  if (!focused || !active || !isEnvironmentId(environmentId) || !isChatId(chatId)) return null;
  return <Watch environmentId={environmentId} chatId={chatId} />;
}
