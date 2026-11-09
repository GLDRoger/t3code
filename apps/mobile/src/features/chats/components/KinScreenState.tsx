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
import { formatKinTime, kinInboxNotice, type KinInboxScreenState } from "../state/kinScreenState";

export type KinReadyState = Extract<KinInboxScreenState, { readonly _tag: "ready" }>;

/** A Kin page: its bar, then the inbox's state, with `children` drawing the ready inbox. */
export function KinInboxPage(props: {
  readonly title: string;
  readonly state: KinInboxScreenState;
  readonly onRetry: () => void;
  readonly children: (ready: KinReadyState) => ReactNode;
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
          <KinScreenState {...props} />
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

/** The spec's state table for one Kin screen. `loading` replaces the default spinner. */
export function KinScreenState(props: {
  readonly state: KinInboxScreenState;
  readonly onRetry: () => void;
  readonly loading?: ReactNode;
  readonly children: (ready: KinReadyState) => ReactNode;
}) {
  const navigation = useNavigation();
  const { state } = props;
  switch (state._tag) {
    case "loading":
      if (props.loading !== undefined) return props.loading;
      return (
        <View
          className="items-center py-12"
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel="Loading Kin"
        >
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
    case "noIdentity":
      return (
        <EmptyState
          variant="plain"
          title="Kin doesn't know who you are on this server yet"
          detail="Ask whoever runs Kin here to add you, then come back."
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
          <KinInboxNotice state={state} />
          {props.children(state)}
        </>
      );
  }
}

/** "Offline. Last updated 9:41." over a cached inbox; nothing while it is live. */
export function KinInboxNotice(props: { readonly state: KinReadyState }) {
  const notice = kinInboxNotice(props.state, (date) => formatKinTime(date));
  if (notice === null) return null;
  return (
    <Notice {...(notice.offline ? { icon: "wifi.slash" as const } : {})} message={notice.message} />
  );
}
