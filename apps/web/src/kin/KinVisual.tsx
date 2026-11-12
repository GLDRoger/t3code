import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, KinOrgId, KinVisualCardState } from "@t3tools/contracts";
import {
  htmlRenderFileName,
  htmlRenderFrameHeight,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
} from "@t3tools/shared/htmlRender";
import { readKinVisualMessage } from "@t3tools/shared/kinVisual";
import { AsyncResult } from "effect/reactivity";
import { Maximize2Icon, XIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { useAssetUrlRefresh } from "../assets/assetUrls";
import { useLongLivedAssetUrl } from "../assets/longLivedAssetUrls";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../components/ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useHtmlRenderTheme } from "../hooks/useHtmlRenderTheme";
import { observeResize } from "../lib/observeResize";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";

const MAX_BLOCKED_HOSTS = 3;
// Kept across remounts, so a card scrolled back into view does not jump.
const measuredHeights = new Map<string, number>();

/**
 * The frame an agent's page is drawn in. The page is sealed by the policy its URL is served
 * with; this only sizes it, passes the theme, and turns a tapped link into a question.
 */
function KinVisualFrame(props: {
  readonly src: string;
  readonly title: string;
  readonly className: string;
  readonly onHeight?: (height: number) => void;
  readonly onBlockedHost?: (host: string) => void;
}) {
  const theme = useHtmlRenderTheme();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [src] = useState(() => `${props.src.split("#", 1)[0]}${htmlRenderThemeFragment(theme)}`);
  const [loaded, setLoaded] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const postTheme = () => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- posts the current theme into the sealed frame's window
  useEffect(postTheme, [theme]);
  const { onHeight, onBlockedHost } = props;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- listens for the frame's window messages from commit, before its first height report
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const message = readKinVisualMessage(event.data);
      if (message === undefined) return;
      if (message.type === "height") onHeight?.(message.height);
      else if (message.type === "blocked") onBlockedHost?.(message.host);
      // A page can post this by script, so it only ever asks: the reader's tap in the frame
      // raises the question, and their tap on the answer opens the link.
      else if (
        message.type === "link" &&
        document.activeElement === frame &&
        navigator.userActivation?.isActive !== false
      )
        setLink(message.url);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onHeight, onBlockedHost]);
  return (
    <>
      <iframe
        ref={frameRef}
        src={src}
        title={props.title}
        // Never allow-same-origin, allow-popups, allow-forms or top navigation.
        sandbox="allow-scripts allow-downloads"
        referrerPolicy="no-referrer"
        loading="lazy"
        onLoad={() => {
          setLoaded(true);
          postTheme();
        }}
        className={props.className}
        // A frame whose scheme differs from the page's gets an opaque backdrop.
        style={loaded ? { colorScheme: theme.appearance } : undefined}
      />
      <AlertDialog open={link !== null} onOpenChange={(open) => !open && setLink(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Open this link?</AlertDialogTitle>
            <AlertDialogDescription>
              A link in “{props.title}” goes to this address. It opens in your browser.
            </AlertDialogDescription>
            <p className="rounded-md border border-border bg-muted/50 px-3 py-2 font-mono text-xs break-all select-all">
              {link}
            </p>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => setLink(null)}
              render={<a href={link ?? undefined} target="_blank" rel="noreferrer noopener" />}
            >
              Open link
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function KinVisualFullScreen(props: {
  readonly src: string;
  readonly title: string;
  readonly onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open onOpenChange={(open) => !open && props.onClose()}>
      <DialogPopup
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1"
        initialFocus={closeRef}
      >
        <div className="flex h-[min(88vh,calc(100vh-96px))] w-[min(94vw,72rem)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <DialogTitle className="sr-only">{props.title}</DialogTitle>
            <p aria-hidden className="min-w-0 flex-1 truncate text-sm font-medium">
              {props.title}
            </p>
            <Button
              ref={closeRef}
              aria-label="Close"
              size="icon-xs"
              variant="ghost"
              onClick={props.onClose}
            >
              <XIcon />
            </Button>
          </div>
          <div className="min-h-0 flex-1 p-3">
            <KinVisualFrame
              src={props.src}
              title={props.title}
              className="block size-full border-0"
            />
          </div>
        </div>
      </DialogPopup>
    </Dialog>
  );
}

/** Owner only: a host the page tried to load from, and the one tap that lets it. */
function KinVisualBlockedHost(props: {
  readonly host: string;
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly onAllowed: () => void;
}) {
  const allow = useAtomCommand(kinClient.visualHostAllow, { reportFailure: false });
  const [state, setState] = useState<"idle" | "confirm" | "saving">("idle");
  const [problem, setProblem] = useState(false);
  const run = async () => {
    setState("saving");
    setProblem(false);
    const result = await allow({
      environmentId: props.environmentId,
      input: { orgId: props.orgId, host: props.host },
    });
    setState("idle");
    if (AsyncResult.isSuccess(result)) props.onAllowed();
    else setProblem(true);
  };
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
      <span>
        This visual wanted to load from{" "}
        <span className="font-medium text-foreground">{props.host}</span>.
      </span>
      <Button
        size="xs"
        variant="outline"
        disabled={state === "saving"}
        onClick={() => setState("confirm")}
      >
        {state === "saving" ? "Allowing…" : "Allow"}
      </Button>
      {problem ? (
        <span role="alert" className="text-destructive-foreground">
          Couldn't allow it. Try again.
        </span>
      ) : null}
      <AlertDialog
        open={state === "confirm"}
        onOpenChange={(open) => {
          if (!open) setState((held) => (held === "confirm" ? "idle" : held));
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Let visuals load from {props.host}?</AlertDialogTitle>
            <AlertDialogDescription>
              Every visual in your chats will be able to load images, fonts and data from this host,
              and to send it anything the visual shows. Allow only a host you trust. You can remove
              it later under Team.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button onClick={() => void run()}>Allow this host</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </p>
  );
}

/**
 * A visual an agent sent: its title and the way to full screen are the app's, and the page sits
 * in a frame below them, so nothing the page draws can pass for a card of the app's own.
 */
export function KinVisual(props: {
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
  // The frame keeps the first URL it loads, so a later mint does not reload the page.
  const [loaded, setLoaded] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [retryFailed, setRetryFailed] = useState(false);
  const assetUrl = useLongLivedAssetUrl(loaded === null ? props.environmentId : null, resource);
  if (loaded === null && assetUrl._tag === "Success") setLoaded(assetUrl.url);
  const refresh = useAssetUrlRefresh(props.environmentId, resource);
  const failed = loaded === null && assetUrl._tag === "Failure";
  const [width, setWidth] = useState(0);
  const [contentHeight, setContentHeight] = useState(() => measuredHeights.get(attachmentId));
  const [expanded, setExpanded] = useState(false);
  const [blocked, setBlocked] = useState<ReadonlyArray<string>>([]);
  const canAllow = useAtomValue(kinClient.visualHostAllow.permissionAtom(props.environmentId));
  const height = htmlRenderFrameHeight(
    { attachmentId, title, height: props.visual.height },
    width,
    contentHeight,
  );
  const observeBox = (box: HTMLDivElement | null) => {
    if (box === null) return;
    setWidth(box.clientWidth);
    return observeResize(box, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
  };
  const retry = async () => {
    const url = await refresh().catch(() => null);
    if (url === null) setRetryFailed(true);
    else setLoaded(url);
  };
  return (
    <>
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 truncate font-medium">{title}</h3>
        {loaded === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label="Open full screen"
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => setExpanded(true)}
                />
              }
            >
              <Maximize2Icon />
            </TooltipTrigger>
            <TooltipPopup side="left">Open full screen</TooltipPopup>
          </Tooltip>
        )}
      </div>
      <div ref={observeBox} style={{ height }}>
        {loaded !== null ? (
          <KinVisualFrame
            key={attempt}
            src={loaded}
            title={title}
            className="block size-full border-0"
            onHeight={(next) => {
              measuredHeights.set(attachmentId, next);
              setContentHeight(next);
            }}
            onBlockedHost={(host) =>
              setBlocked((hosts) =>
                hosts.includes(host) || hosts.length >= MAX_BLOCKED_HOSTS
                  ? hosts
                  : [...hosts, host],
              )
            }
          />
        ) : failed ? (
          <div className="flex size-full flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
            {retryFailed ? (
              <p>This visual is no longer available.</p>
            ) : (
              <>
                <p>Couldn't load this visual.</p>
                <Button size="xs" variant="outline" onClick={() => void retry()}>
                  Try again
                </Button>
              </>
            )}
          </div>
        ) : (
          <p className="flex size-full items-center justify-center text-xs text-muted-foreground">
            Loading…
          </p>
        )}
      </div>
      {canAllow
        ? blocked.map((host) => (
            <KinVisualBlockedHost
              key={host}
              host={host}
              environmentId={props.environmentId}
              orgId={props.orgId}
              onAllowed={() => {
                setBlocked([]);
                // The same URL now answers with the wider policy.
                setAttempt((value) => value + 1);
              }}
            />
          ))
        : null}
      {expanded && loaded !== null ? (
        <KinVisualFullScreen src={loaded} title={title} onClose={() => setExpanded(false)} />
      ) : null}
    </>
  );
}
