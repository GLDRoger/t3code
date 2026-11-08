import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppBar } from "../../../components/ui/AppBar";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { Notice } from "../../../components/ui/Notice";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import type { KinInboxScreenState } from "../state/kinScreenState";

type ReadyState = Extract<KinInboxScreenState, { readonly _tag: "ready" }>;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** A Kin page: its bar, then the inbox's state, with `children` drawing the ready inbox. */
export function KinInboxPage(props: {
  readonly title: string;
  readonly state: KinInboxScreenState;
  readonly onRetry: () => void;
  readonly children: (ready: ReadyState) => ReactNode;
}) {
  const navigation = useNavigation();
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={props.title} onBack={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, gap: 12 }}
        >
          <KinInboxStateBody {...props} />
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function KinInboxStateBody(props: {
  readonly state: KinInboxScreenState;
  readonly onRetry: () => void;
  readonly children: (ready: ReadyState) => ReactNode;
}) {
  const navigation = useNavigation();
  const { state } = props;
  switch (state._tag) {
    case "loading":
      return (
        <View className="items-center py-12" accessibilityLabel="Loading Kin">
          <AppActivityIndicator />
        </View>
      );
    case "offline":
      return (
        <EmptyState
          variant="plain"
          title="Kin is offline"
          detail="Chats load when the Kin environment reconnects."
        />
      );
    case "noHost":
      return (
        <EmptyState
          variant="plain"
          title="Kin isn't set up on this environment"
          detail="Connect this phone to a T3 server that runs Kin."
          actionLabel="Open environments"
          onAction={() => navigation.navigate("SettingsEnvironments")}
        />
      );
    case "unauthorized":
      return (
        <EmptyState
          variant="plain"
          title="This device can't read Kin chats"
          detail="Pair it again from the Mac."
        />
      );
    case "error":
      return (
        <View className="gap-3">
          <ErrorBanner message={state.message} />
          <View className="self-start">
            <Button tone="secondary" size="compact" label="Retry" onPress={props.onRetry} />
          </View>
        </View>
      );
    case "ready":
      return (
        <>
          {state.inbox.live || state.inbox.savedAt === null ? null : (
            <Notice
              {...(state.connected ? {} : { icon: "wifi.slash" as const })}
              message={`${state.connected ? "Updating" : "Offline"}. Last updated ${timeFormat.format(new Date(state.inbox.savedAt))}.`}
            />
          )}
          {props.children(state)}
        </>
      );
  }
}
