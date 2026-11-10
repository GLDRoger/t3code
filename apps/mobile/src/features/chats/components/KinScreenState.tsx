import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
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
import {
  formatKinTime,
  kinInboxNotice,
  type KinInboxScreenState,
  type KinReconnectStatus,
  type KinStaleNotice,
} from "@t3tools/client-runtime/kin/kinScreenState";
import { useKinHost } from "../state/useKinHost";
import { useKinReconnect } from "../state/useKinReconnect";

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
      return <KinInboxOfflineState />;
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

function KinInboxOfflineState() {
  const host = useKinHost();
  return (
    <KinOfflineState
      environmentId={host._tag === "host" ? host.environmentId : null}
      resource="Chats load"
    />
  );
}

/** Offline with nothing cached: what loads once Kin is back, and Reconnect. */
export function KinOfflineState(props: {
  readonly environmentId: EnvironmentId | null;
  /** "Chats load", finished as "… when the Kin environment reconnects." */
  readonly resource: string;
}) {
  const { status, reconnect } = useKinReconnect(props.environmentId);
  return (
    <EmptyState
      variant="plain"
      title={status === "failed" ? "Couldn't reconnect to Kin" : "Kin is offline"}
      detail={`${props.resource} when the Kin environment reconnects.`}
      {...(reconnect === null
        ? {}
        : {
            actionLabel: status === "pending" ? "Reconnecting…" : "Reconnect",
            onAction: reconnect,
          })}
    />
  );
}

/** "Offline. Last updated 9:41." over a cached inbox, with Reconnect; nothing while it is live. */
export function KinInboxNotice(props: { readonly state: KinReadyState }) {
  const { status, reconnect } = useKinReconnect(props.state.environmentId);
  const notice = kinInboxNotice(props.state, status, (date) => formatKinTime(date));
  if (notice === null) return null;
  return <KinStaleNoticeView notice={notice} status={status} reconnect={reconnect} />;
}

/** A stale-data notice; offline ones carry Reconnect. */
export function KinStaleNoticeView(props: {
  readonly notice: KinStaleNotice;
  readonly status: KinReconnectStatus;
  readonly reconnect: (() => void) | null;
  readonly floating?: boolean;
}) {
  const { notice, reconnect } = props;
  return (
    <Notice
      {...(notice.offline ? { icon: "wifi.slash" as const } : {})}
      message={notice.message}
      {...(props.floating ? { floating: true } : {})}
      {...(notice.offline && reconnect !== null
        ? {
            action: {
              label: "Reconnect",
              onPress: reconnect,
              pending: props.status === "pending",
            },
          }
        : {})}
    />
  );
}
