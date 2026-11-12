import { KIN_ONLY } from "../../../lib/kinOnly";
import { KIN_ONLY_NO_HOST, KIN_ONLY_UNAUTHORIZED } from "../kinOnlyCopy";
import { useAtomValue } from "@effect/atom-react";
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
import { environmentPresentations } from "../../../state/presentation";
import { kinStandInLine } from "@t3tools/client-runtime/kin/kinHost";
import {
  formatKinTime,
  kinInboxNotice,
  type KinInboxScreenState,
  type KinReconnectStatus,
  type KinStaleNotice,
} from "@t3tools/client-runtime/kin/kinScreenState";
import { useKinAppShell } from "../state/kinChatOnly";
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
  // A teammate has no computer to pair or environments to open, so each dead end says what they can do.
  const teammate = useKinAppShell() === "chatOnly";
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
      return teammate ? (
        <EmptyState
          variant="plain"
          title="Your team's Kin isn't available"
          detail="Try again in a bit. If it stays this way, ask your team whether something changed."
        />
      ) : (
        <EmptyState
          variant="plain"
          {...(KIN_ONLY
            ? { ...KIN_ONLY_NO_HOST, onAction: () => navigation.navigate("SettingsEnvironmentNew") }
            : {
                title: "No server with Kin yet",
                detail: "Connect this phone to a T3 Code server that has Kin turned on.",
                actionLabel: "Open environments",
                onAction: () => navigation.navigate("SettingsEnvironments"),
              })}
        />
      );
    case "unauthorized":
      return teammate ? (
        <EmptyState
          variant="plain"
          title="You no longer have access"
          detail="Ask your team for a new join link to get back in."
          actionLabel="Join with a new link"
          onAction={() => navigation.navigate("KinJoin")}
        />
      ) : (
        <EmptyState
          variant="plain"
          {...(KIN_ONLY
            ? KIN_ONLY_UNAUTHORIZED
            : {
                title: "This phone can't read Kin chats",
                detail: "Pair it again with the computer that runs T3 Code.",
              })}
        />
      );
    case "noIdentity":
      return teammate ? (
        <EmptyState
          variant="plain"
          title="You're not on this team yet"
          detail="Ask your team to add you, then come back."
        />
      ) : (
        <EmptyState
          variant="plain"
          title="You're not in Kin on this server yet"
          detail="Ask whoever runs it to add you, then come back."
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
  const teammate = useKinAppShell() === "chatOnly";
  return (
    <EmptyState
      variant="plain"
      title={status === "failed" ? "Couldn't reconnect to Kin" : "Kin is offline"}
      detail={
        teammate
          ? `${props.resource} when you're back online.`
          : `${props.resource} when the Kin environment reconnects.`
      }
      {...(reconnect === null
        ? {}
        : {
            actionLabel: status === "pending" ? "Reconnecting…" : "Reconnect",
            onAction: reconnect,
          })}
    />
  );
}

/**
 * "Showing Studio Mac. Office Mac can't be reached." while another computer's Kin stands in, with
 * a retry for the usual one. `environmentId` limits it to a screen showing that computer's Kin.
 */
export function KinStandInNotice(props: {
  readonly environmentId?: EnvironmentId;
  readonly floating?: boolean;
  /** Wraps it in a padded view, drawn only when the line is. */
  readonly className?: string;
}) {
  const host = useKinHost();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const line = kinStandInLine(host, (id) => presentations.get(id)?.entry.target.label ?? null);
  const { status, reconnect } = useKinReconnect(line?.usual ?? null);
  if (line === null || host._tag !== "host") return null;
  if (props.environmentId !== undefined && props.environmentId !== host.environmentId) return null;
  const shown = (
    <Notice
      icon="wifi.slash"
      message={status === "failed" ? `${line.message} Still no answer.` : line.message}
      {...(props.floating ? { floating: true } : {})}
      {...(reconnect === null
        ? {}
        : { action: { label: "Try again", onPress: reconnect, pending: status === "pending" } })}
    />
  );
  return props.className === undefined ? shown : <View className={props.className}>{shown}</View>;
}

/** "Offline. Last updated 9:41." over a cached inbox, with Reconnect; nothing while it is live. */
export function KinInboxNotice(props: { readonly state: KinReadyState }) {
  const { status, reconnect } = useKinReconnect(props.state.environmentId);
  const notice = kinInboxNotice(props.state, status, (date) => formatKinTime(date));
  if (notice === null) return <KinStandInNotice />;
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
