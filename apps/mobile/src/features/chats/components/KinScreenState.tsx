import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { KIN_HOST_OFFLINE, KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_ONLY } from "../../../lib/kinOnly";
import {
  KIN_ONLY_NO_HOST,
  KIN_ONLY_UNAUTHORIZED,
  KIN_ONLY_UNREACHABLE,
  KIN_TEAMMATE_NO_HOST,
  KIN_TEAMMATE_UNREACHABLE,
} from "../kinOnlyCopy";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppBar } from "../../../components/ui/AppBar";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { ErrorBanner } from "../../../components/ui/ErrorBanner";
import { Notice } from "../../../components/ui/Notice";
import { ScreenContent } from "../../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { environmentPresentations } from "../../../state/presentation";
import { KIN_USE_THIS_HOST, kinStandInLine } from "@t3tools/client-runtime/kin/kinHost";
import { kinAccessAtom } from "@t3tools/client-runtime/kin/kinAccess";
import { kinOwnerLevel, type KinPersonAccess } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { connectionAtomRuntime } from "../../../connection/runtime";

const noAccessAtom = Atom.make<KinPersonAccess | null>(null);
import {
  formatKinTime,
  kinInboxNotice,
  type KinInboxScreenState,
  type KinReconnectStatus,
  type KinStaleNotice,
} from "@t3tools/client-runtime/kin/kinScreenState";
import { useKinAppShell } from "../state/kinChatOnly";
import { useKinHost, useKinHostChooser } from "../state/useKinHost";
import { kinCachedOrgsAtom } from "../state/kinClient";
import { AsyncResult } from "effect/reactivity";
import { useKinReconnect } from "../state/useKinReconnect";
import { kinAccessEndedCopy } from "@t3tools/client-runtime/kin/kinJoin";

const ACCESS_ENDED = kinAccessEndedCopy("phone");

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
          {...(state.unreachable === true
            ? { ...KIN_TEAMMATE_UNREACHABLE, onAction: () => navigation.navigate("KinJoin") }
            : KIN_TEAMMATE_NO_HOST)}
        />
      ) : (
        <EmptyState
          variant="plain"
          {...(KIN_ONLY
            ? {
                ...(state.unreachable === true ? KIN_ONLY_UNREACHABLE : KIN_ONLY_NO_HOST),
                onAction: () => navigation.navigate("SettingsEnvironmentNew"),
              }
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
          title={ACCESS_ENDED.title}
          detail={ACCESS_ENDED.detail}
          actionLabel={ACCESS_ENDED.action}
          onAction={() => navigation.navigate("KinJoin")}
        />
      ) : (
        <EmptyState
          variant="plain"
          {...(KIN_ONLY
            ? KIN_ONLY_UNAUTHORIZED
            : {
                title: KIN_DEVICE_COPY.cantReadChats("phone"),
                detail: KIN_DEVICE_COPY.pairAgain,
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
      title={status === "failed" ? "Couldn't reconnect to Kin" : KIN_HOST_OFFLINE}
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

const noDirectoryAtom = Atom.make(AsyncResult.success(null));

/** The stand-in line for a screen, or null while the usual computer is the one showing. */
export function useKinStandIn(environmentId?: EnvironmentId) {
  const host = useKinHost();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const access = useAtomValue(
    host._tag === "host" ? kinAccessAtom(connectionAtomRuntime, host.environmentId) : noAccessAtom,
  );
  const usualDirectory = useAtomValue(
    host._tag === "host" && host.standInFor !== undefined
      ? kinCachedOrgsAtom(host.standInFor)
      : noDirectoryAtom,
  );
  const useHere = useKinHostChooser();
  const line = kinStandInLine(
    host,
    (id) => presentations.get(id)?.entry.target.label ?? null,
    kinOwnerLevel(access ?? undefined),
    AsyncResult.getOrElse(usualDirectory, () => null),
  );
  const { status, reconnect } = useKinReconnect(line?.usual ?? null);
  if (line === null || host._tag !== "host") return null;
  if (environmentId !== undefined && environmentId !== host.environmentId) return null;
  return {
    message: status === "failed" ? `${line.message} Still no answer.` : line.message,
    action: reconnect === null ? null : status === "pending" ? "Trying…" : KIN_RETRY,
    onPress: status === "pending" ? null : reconnect,
    onUseHere: () => useHere(line.shown),
  };
}

/**
 * "Showing Studio Mac. Office Mac can't be reached." while another computer's Kin stands in: one
 * quiet line in the layout, never over content, that tries the usual one again or makes the one
 * showing the usual one.
 */
export function KinStandInLine(props: {
  readonly line: NonNullable<ReturnType<typeof useKinStandIn>>;
}) {
  const { message, action, onPress, onUseHere } = props.line;
  return (
    <View className="flex-row items-start gap-2 py-1">
      <View className="pt-0.5">
        <SymbolView name="wifi.slash" size={12} tintColorClassName="accent-icon-muted" />
      </View>
      {/* A status line, capped like the chat title so it never crowds out the chats. */}
      <View className="min-w-0 flex-1 gap-1">
        <AppText
          textRole="caption"
          maxFontSizeMultiplier={1.5}
          accessibilityLiveRegion="polite"
          className="text-foreground-muted"
        >
          {message}
        </AppText>
        <View className="flex-row gap-4">
          {action === null ? null : (
            <Pressable
              accessibilityRole="button"
              disabled={onPress === null}
              onPress={onPress ?? undefined}
              hitSlop={8}
              className="active:opacity-60"
            >
              <AppText
                textRole="caption"
                maxFontSizeMultiplier={1.5}
                className="font-t3-medium text-primary"
              >
                {action}
              </AppText>
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            onPress={onUseHere}
            hitSlop={8}
            className="active:opacity-60"
          >
            <AppText
              textRole="caption"
              maxFontSizeMultiplier={1.5}
              className="font-t3-medium text-primary"
            >
              {KIN_USE_THIS_HOST}
            </AppText>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

/** The stand-in line in a padded view, drawn only when there is one. */
export function KinStandInNotice(props: { readonly className?: string | undefined }) {
  const line = useKinStandIn();
  if (line === null) return null;
  return (
    <View className={props.className}>
      <KinStandInLine line={line} />
    </View>
  );
}

/** "Offline. Last updated 9:41." over a cached inbox, with Reconnect; nothing while it is live. */
export function KinInboxNotice(props: {
  readonly state: KinReadyState;
  /** Padding for the notice, so nothing pads the list when there is none. */
  readonly className?: string;
}) {
  const { status, reconnect } = useKinReconnect(props.state.environmentId);
  const notice = kinInboxNotice(props.state, status, (date) => formatKinTime(date));
  if (notice === null) return <KinStandInNotice className={props.className} />;
  return (
    <View className={props.className}>
      <KinStaleNoticeView notice={notice} status={status} reconnect={reconnect} />
    </View>
  );
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
