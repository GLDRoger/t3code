import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, KinOrgId, KinVisualCardState } from "@t3tools/contracts";
import {
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import {
  KIN_VISUAL_PRELUDE,
  type KinVisualMessage,
  kinVisualHostUnicode,
  kinVisualSaveFile,
  readKinVisualMessage,
} from "@t3tools/shared/kinVisual";
import { kinVisualSaveBytes } from "@t3tools/shared/kinVisualSvg";
import { AsyncResult } from "effect/reactivity";
import { memo, useEffect, useRef, useState } from "react";
import { Modal, Platform, Pressable, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../../components/ui/AppText";
import { REVIEW_MONO_FONT_FAMILY } from "../../review/reviewDiffRendering";
import * as Dialog from "../../../components/ui/Dialog";
import { shareGeneratedAttachment } from "../../../lib/attachmentDownload";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { useAssetUrlState, useRefreshAssetUrl } from "../../../state/assets";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useHtmlRenderTheme } from "../../threads/HtmlRenderWebView";
import { KinWorkPrivateMark } from "../components/KinWorkPieces";
import { kinClient } from "../state/kinClient";
import { fromVisualPage } from "./kinVisualMessage";

// A link request counts only this soon after the reader touched the visual.
const TOUCH_WINDOW_MS = 1500;
// Kept across remounts, so a card scrolled back into view does not jump.
const measuredHeights = new Map<string, number>();

const location = (url: string) => url.split(/[?#]/, 1)[0];

function readMessage(data: string): KinVisualMessage | undefined {
  try {
    return readKinVisualMessage(JSON.parse(data));
  } catch {
    return undefined;
  }
}

function postTheme(view: WebView<object> | null, theme: HtmlRenderTheme) {
  view?.injectJavaScript(
    `window.postMessage(${JSON.stringify(htmlRenderThemeMessage(theme))}, "*"); true;`,
  );
}

/**
 * The WebView an agent's page is drawn in. The page is sealed by the policy its URL is served
 * with; here the view refuses to go anywhere but that URL, and a link only ever asks.
 */
function KinVisualWebView(props: {
  readonly uri: string;
  readonly title: string;
  readonly onHeight?: (height: number) => void;
  readonly onBlockedHost?: (host: string) => void;
  readonly onLoadError: () => void;
}) {
  const theme = useHtmlRenderTheme();
  const [initialTheme] = useState(theme);
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const webView = useRef<WebView<object>>(null);
  const crashes = useRef(0);
  const touchedAt = useRef<number | null>(null);
  const asking = useRef(false);
  const shownTheme = useRef<HtmlRenderTheme | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- posts theme changes into the already loaded WebView
  useEffect(() => {
    if (shownTheme.current === null || shownTheme.current === theme) return;
    shownTheme.current = theme;
    postTheme(webView.current, theme);
  }, [theme]);
  const restart = () => {
    crashes.current += 1;
    if (crashes.current > 1) {
      props.onLoadError();
      return;
    }
    shownTheme.current = null;
    setLoaded(false);
    setGeneration((value) => value + 1);
  };
  // A save counts only after the reader's own touch, like a link; the share sheet is their choice.
  const save = (file: Extract<KinVisualMessage, { readonly type: "save" }>) => {
    const touched = touchedAt.current;
    if (touched === null || performance.now() - touched > TOUCH_WINDOW_MS) return;
    touchedAt.current = null;
    const saved = kinVisualSaveFile(file.name, file.mimeType);
    if (saved === null) return;
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0));
    } catch {
      return;
    }
    const cleaned = kinVisualSaveBytes(saved.mimeType, bytes);
    if ("error" in cleaned) {
      Dialog.alert(
        "Couldn't save this file",
        `Kin couldn't save this SVG safely: ${cleaned.error}.`,
      );
      return;
    }
    void shareGeneratedAttachment({
      bytes: cleaned.bytes,
      attachment: { name: saved.name, mimeType: saved.mimeType },
      signal: new AbortController().signal,
    }).then(
      (shared) => {
        if (!shared)
          Dialog.alert("Couldn't save this file", "Sharing is unavailable on this device.");
      },
      () => Dialog.alert("Couldn't save this file", "Try again."),
    );
  };
  const askToOpen = (url: string) => {
    // Any frame can post a message, so a link counts only right after the reader's own touch,
    // and even then it only asks: their tap on the answer is what opens it.
    const touched = touchedAt.current;
    if (asking.current || touched === null || performance.now() - touched > TOUCH_WINDOW_MS) return;
    touchedAt.current = null;
    asking.current = true;
    const done = () => {
      asking.current = false;
    };
    Dialog.confirm({
      title: "Open this link?",
      message: `A link in “${props.title}” goes to:\n\n${url}`,
      confirmText: "Open link",
      onCancel: done,
      onConfirm: () => {
        done();
        void tryOpenExternalUrl(url, "html-render");
      },
    });
  };
  return (
    <View
      style={{ flex: 1 }}
      onTouchStart={() => {
        touchedAt.current = performance.now();
      }}
    >
      <WebView<object>
        key={generation}
        ref={webView}
        source={{ uri: props.uri + htmlRenderThemeFragment(initialTheme) }}
        accessibilityLabel={props.title}
        style={{ flex: 1, backgroundColor: "transparent" }}
        // Every address reaches the check below; the default list hands other schemes to the OS.
        originWhitelist={["*"]}
        // The view and the frame inside it load this visual's own address and nothing else.
        onShouldStartLoadWithRequest={(request) =>
          location(request.url) === location(props.uri) ||
          (request.isTopFrame === false && request.url.startsWith("about:"))
        }
        // The server puts the same prelude first in the page; this runs it in every frame below
        // ours too (iOS only). Not in the top frame: the prelude removes frames, ours included.
        injectedJavaScriptBeforeContentLoaded={`if(window.top!==window){${KIN_VISUAL_PRELUDE}}true;`}
        injectedJavaScriptBeforeContentLoadedForMainFrameOnly={false}
        mediaCapturePermissionGrantType="deny"
        allowsInlineMediaPlayback
        mediaPlaybackRequiresUserAction
        allowsLinkPreview={false}
        allowFileAccess={false}
        geolocationEnabled={false}
        thirdPartyCookiesEnabled={false}
        sharedCookiesEnabled={false}
        setSupportMultipleWindows={false}
        javaScriptCanOpenWindowsAutomatically={false}
        contentInsetAdjustmentBehavior="never"
        bounces={false}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        showsHorizontalScrollIndicator={false}
        overScrollMode="never"
        onMessage={(event) => {
          if (!fromVisualPage(Platform.OS, event.nativeEvent.url, props.uri)) return;
          const message = readMessage(event.nativeEvent.data);
          if (message === undefined) return;
          if (message.type === "height") props.onHeight?.(message.height);
          else if (message.type === "blocked") props.onBlockedHost?.(message.host);
          else if (message.type === "save") save(message);
          else askToOpen(message.url);
        }}
        onLoadEnd={() => {
          setLoaded(true);
          shownTheme.current = theme;
          if (theme !== initialTheme) postTheme(webView.current, theme);
        }}
        onError={props.onLoadError}
        onHttpError={props.onLoadError}
        onContentProcessDidTerminate={restart}
        onRenderProcessGone={restart}
      />
      {loaded ? null : (
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center">
          <AppActivityIndicator />
        </View>
      )}
    </View>
  );
}

function KinVisualFullScreen(props: {
  readonly uri: string;
  readonly title: string;
  readonly onClose: () => void;
}) {
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={props.onClose}
    >
      {/* A Modal is its own native hierarchy, so it measures its own safe area. */}
      <SafeAreaProvider style={{ flex: 1 }}>
        <View className="flex-1 bg-screen">
          <SafeAreaView style={{ flex: 1 }}>
            <View className="flex-row items-center gap-3 border-b border-border px-4 py-3">
              <Text
                textRole="headline"
                numberOfLines={1}
                className="min-w-0 flex-1 text-foreground"
              >
                {props.title}
              </Text>
              <Pressable accessibilityRole="button" hitSlop={12} onPress={props.onClose}>
                <Text textRole="body" className="font-t3-medium text-primary">
                  Close
                </Text>
              </Pressable>
            </View>
            <View className="flex-1 px-4 py-3">
              <KinVisualWebView uri={props.uri} title={props.title} onLoadError={props.onClose} />
            </View>
          </SafeAreaView>
        </View>
      </SafeAreaProvider>
    </Modal>
  );
}

/**
 * A visual an agent sent: its title and the way to full screen are the app's, and the page sits
 * in a WebView below them, so nothing the page draws can pass for a card of the app's own.
 */
export const KinVisual = memo(function KinVisual(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly visual: KinVisualCardState;
}) {
  const { attachmentId, title } = props.visual;
  const resource = {
    _tag: "attachment" as const,
    attachmentId,
    fileName: htmlRenderFileName(title),
    mimeType: "text/html",
    disposition: "inline" as const,
  };
  const asset = useAssetUrlState(props.environmentId, resource);
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  // Signed URLs are re-minted periodically; following them would reload the page.
  const [uri, setUri] = useState<string | null>(null);
  if (uri === null && asset._tag === "Success") setUri(asset.url);
  const [failed, setFailed] = useState<"once" | "gone" | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [width, setWidth] = useState(0);
  const [contentHeight, setContentHeight] = useState(() => measuredHeights.get(attachmentId));
  const [expanded, setExpanded] = useState(false);
  // One request line at a time; once the reader says not now, this visual asks no more.
  const [blocked, setBlocked] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  const [allowing, setAllowing] = useState<string | null>(null);
  const [problem, setProblem] = useState(false);
  const canAllow = useAtomValue(kinClient.visualHostAllow.permissionAtom(props.environmentId));
  const allow = useAtomCommand(kinClient.visualHostAllow, { reportFailure: false });
  const height = htmlRenderFrameHeight(
    { attachmentId, title, height: props.visual.height },
    width,
    contentHeight,
  );
  const showing = uri !== null && failed === null;
  const retry = async () => {
    const next = await refresh().catch(() => null);
    if (next === null) {
      setFailed("gone");
      return;
    }
    setFailed(null);
    setUri(next);
    setAttempt((value) => value + 1);
  };
  const allowHost = (host: string) => {
    const unicode = kinVisualHostUnicode(host);
    return Dialog.confirm({
      title: "Allow this host for every visual?",
      message: `${host}${unicode === null ? "" : `\n(shown as “${unicode}”)`}\n\nThe visual asked for this itself; nobody checked the host. Once allowed, every visual in this workspace can load from it and send it anything a visual shows. Allow only a host you trust. You can remove it later under Team.`,
      confirmText: "Allow for every visual",
      onConfirm: () => {
        setAllowing(host);
        setProblem(false);
        void allow({
          environmentId: props.environmentId,
          input: { orgId: props.orgId, host },
        }).then((result) => {
          setAllowing(null);
          if (!AsyncResult.isSuccess(result)) {
            setProblem(true);
            return;
          }
          setBlocked(null);
          // The same address now answers with the wider policy.
          setAttempt((value) => value + 1);
        });
      },
    });
  };
  return (
    <View className="gap-2 rounded-[20px] border border-border bg-card-alt p-4">
      <View className="flex-row items-center gap-3">
        <Text textRole="headline" numberOfLines={2} className="min-w-0 flex-1 text-foreground">
          {title}
        </Text>
        {props.visual.sensitive === true ? <KinWorkPrivateMark label="" /> : null}
        {showing ? (
          <Pressable accessibilityRole="button" hitSlop={12} onPress={() => setExpanded(true)}>
            <Text textRole="footnote" className="font-t3-medium text-primary">
              Full screen
            </Text>
          </Pressable>
        ) : null}
      </View>
      <View style={{ height }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
        {showing ? (
          <KinVisualWebView
            key={`${uri}:${attempt}`}
            uri={uri}
            title={title}
            onHeight={(next) => {
              measuredHeights.set(attachmentId, next);
              setContentHeight(next);
            }}
            onBlockedHost={(host) => {
              if (!declined) setBlocked((held) => held ?? host);
            }}
            onLoadError={() => setFailed("once")}
          />
        ) : failed === "gone" ? (
          <View className="flex-1 items-center justify-center">
            <Text textRole="footnote" className="text-foreground-muted">
              This visual is no longer available.
            </Text>
          </View>
        ) : failed === "once" || asset._tag === "Failure" ? (
          <View className="flex-1 items-center justify-center gap-2">
            <Text textRole="footnote" className="text-foreground-muted">
              Couldn't load this visual.
            </Text>
            <Pressable accessibilityRole="button" hitSlop={12} onPress={() => void retry()}>
              <Text textRole="footnote" className="font-t3-medium text-primary">
                Try again
              </Text>
            </Pressable>
          </View>
        ) : (
          <View className="flex-1 items-center justify-center">
            <AppActivityIndicator />
          </View>
        )}
      </View>
      {canAllow && blocked !== null ? (
        <View className="flex-row flex-wrap items-center gap-x-3 gap-y-1">
          <Text textRole="caption" className="min-w-0 shrink text-foreground-muted">
            This visual asks to load from{" "}
            <Text
              textRole="caption"
              className="text-foreground"
              style={{ fontFamily: REVIEW_MONO_FONT_FAMILY }}
            >
              {blocked}
            </Text>
            {kinVisualHostUnicode(blocked) === null
              ? ""
              : ` (shown as “${kinVisualHostUnicode(blocked)}”)`}
            .
          </Text>
          <Pressable
            accessibilityRole="button"
            hitSlop={12}
            disabled={allowing !== null}
            onPress={() => allowHost(blocked)}
          >
            <Text textRole="caption" className="font-t3-medium text-primary">
              {allowing === blocked ? "Allowing…" : "Allow"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            hitSlop={12}
            disabled={allowing !== null}
            onPress={() => {
              setBlocked(null);
              setDeclined(true);
            }}
          >
            <Text textRole="caption" className="text-foreground-muted">
              Not now
            </Text>
          </Pressable>
        </View>
      ) : null}
      {problem ? (
        <Text accessibilityRole="alert" textRole="caption" className="text-danger-foreground">
          Couldn't allow it. Try again.
        </Text>
      ) : null}
      {expanded && uri !== null ? (
        <KinVisualFullScreen uri={uri} title={title} onClose={() => setExpanded(false)} />
      ) : null}
    </View>
  );
});
