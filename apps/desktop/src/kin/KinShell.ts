import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import * as Electron from "electron";

import { KIN_INVITE_BROWSER_ACCEPT_ROUTE } from "@t3tools/contracts";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopState from "../app/DesktopState.ts";
import * as DesktopWebLinks from "../app/DesktopWebLinks.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import { DESKTOP_HOST, getDesktopScheme, getDesktopUrl } from "../electron/ElectronProtocol.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
  kinShellAllowsPermission,
  kinShellNavigation,
  kinShellRootRedirect,
  kinTeamHome,
  readKinDesktopLink,
} from "./kinDesktopLink.ts";
import { isAppPageUrl } from "./appPage.ts";
import * as Channels from "./kinShellChannels.ts";
import {
  KIN_SHELL_COPY,
  KIN_SHELL_PAGE_HTML,
  KIN_SHELL_PAGE_POLICY,
  KIN_SHELL_PAGE_SCRIPT,
  type KinShellView,
} from "./kinShellPages.ts";

/**
 * What this computer is to Kin, kept in the desktop's state folder. `join` is a window on the
 * team's host; phase 2 adds `host` (this computer runs the team's Kin).
 */
const KinShellSettings = Schema.Struct({
  mode: Schema.Literal("join"),
  origin: Schema.String,
});
type KinShellSettings = typeof KinShellSettings.Type;
const decodeSettings = Schema.decodeUnknownOption(Schema.fromJsonString(KinShellSettings));

const KIN_SHELL_SETTINGS_FILE = "kin-desktop.json";
const PAIR_SESSION_ROUTE = "/api/auth/browser-session";
const SESSION_STATE_ROUTE = "/api/auth/session";
const ERR_ABORTED = -3;
const HOST_DOWN_STATUSES = new Set([502, 503, 504]);

const { logInfo, logWarning } = makeComponentLogger("kin-shell");

const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(KinShellSettings));

class KinShellSessionCheckError extends Schema.TaggedError<KinShellSessionCheckError>()(
  "KinShellSessionCheckError",
  { cause: Schema.Defect() },
) {}

export class KinShell extends Context.Service<
  KinShell,
  {
    /** Serves the app's own pages and their controls, in place of the bundled server. */
    readonly start: Effect.Effect<boolean, DesktopIpc.DesktopIpcRegistrationError, Scope.Scope>;
    /** A join link from outside the window: `kin://kin/join?link=…` or a pasted link. */
    readonly receiveLink: (url: string) => Effect.Effect<void>;
    readonly useDifferentLink: Effect.Effect<void>;
    readonly openHostInBrowser: Effect.Effect<void>;
  }
>()("@t3tools/desktop/kin/KinShell") {}

const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const desktopState = yield* DesktopState.DesktopState;
  const assets = yield* DesktopAssets.DesktopAssets;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronShell = yield* ElectronShell.ElectronShell;
  const electronTheme = yield* ElectronTheme.ElectronTheme;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const ipc = yield* DesktopIpc.DesktopIpc;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const mainWindowMutex = yield* Semaphore.make(1);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<Path.Path>());

  const appUrl = getDesktopUrl(environment.isDevelopment);
  const appScheme = getDesktopScheme(environment.isDevelopment);
  const settingsPath = path.join(environment.stateDir, KIN_SHELL_SETTINGS_FILE);
  const preloadPath = path.join(path.dirname(environment.preloadPath), "kin-shell-preload.cjs");
  const isAppPage = isAppPageUrl;

  let remembered: Option.Option<KinShellSettings> = Option.flatMap(
    yield* fileSystem.readFileString(settingsPath).pipe(Effect.option),
    decodeSettings,
  );
  let view: KinShellView = { view: "join", host: null, problem: null, canGoBack: false };
  /** What Try again opens: the host page that failed, else the last one the shell opened. */
  let lastTarget: string | null = null;
  let retried = false;
  /** A link the host's page is redeeming, and what was remembered before it. */
  let joining: {
    readonly origin: string;
    readonly previous: Option.Option<KinShellSettings>;
  } | null = null;
  let pendingLink: string | null = null;

  const readableHost = (origin: string) => new URL(origin).host;
  const currentHostOrigin = () =>
    joining?.origin ?? Option.getOrNull(Option.map(remembered, (settings) => settings.origin));
  const hostHome = kinTeamHome;

  const remember = Effect.fn("KinShell.remember")(
    function* (next: Option.Option<KinShellSettings>) {
      remembered = next;
      if (Option.isNone(next)) {
        yield* fileSystem.remove(settingsPath, { force: true });
        return;
      }
      const encoded = yield* encodeSettings(next.value);
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      const temporary = `${settingsPath}.tmp`;
      yield* fileSystem.writeFileString(temporary, `${encoded}\n`);
      yield* fileSystem.rename(temporary, settingsPath);
    },
    Effect.catch((error) =>
      logWarning("could not save which Kin this computer joined", { message: error.message }),
    ),
  );

  const mainWindow = electronWindow.main.pipe(
    Effect.map(Option.filter((window) => !window.isDestroyed())),
  );

  const load = Effect.fn("KinShell.load")(function* (url: string) {
    const window = yield* mainWindow;
    if (Option.isNone(window)) return;
    window.value.loadURL(url).catch(() => undefined);
  });

  const showPage = Effect.fn("KinShell.showPage")(function* (next: KinShellView) {
    view = next;
    yield* load(appUrl);
  });

  const showJoin = (problem: string | null) =>
    showPage({
      view: "join",
      host: Option.getOrNull(Option.map(remembered, (settings) => readableHost(settings.origin))),
      problem,
      canGoBack: problem !== null && Option.isSome(remembered),
    });

  const showUnreachable = (origin: string) =>
    showPage({
      view: "unreachable",
      host: readableHost(origin),
      problem: retried ? KIN_SHELL_COPY.stillUnreachable : null,
      canGoBack: false,
    });

  const goHost = Effect.fn("KinShell.goHost")(function* (url: string) {
    lastTarget = url;
    yield* load(url);
  });

  /** Whether the host still knows this computer; a lapsed session lands on the join page. */
  const sessionState = Effect.fn("KinShell.sessionState")(
    function* (origin: string) {
      return yield* Effect.tryPromise({
        try: async () => {
          const response = await Electron.session.defaultSession.fetch(
            new URL(SESSION_STATE_ROUTE, origin).toString(),
            { credentials: "include", cache: "no-store" },
          );
          if (!response.ok) return "unknown" as const;
          const body: unknown = await response.json();
          return typeof body === "object" &&
            body !== null &&
            "authenticated" in body &&
            body.authenticated === false
            ? ("signed-out" as const)
            : ("signed-in" as const);
        },
        catch: (cause) => new KinShellSessionCheckError({ cause }),
      });
    },
    Effect.orElseSucceed(() => "unknown" as const),
  );

  const confirmLeaving = Effect.fn("KinShell.confirmLeaving")(function* (
    origin: string,
    message: string,
    confirmLabel: string,
  ) {
    const window = yield* mainWindow;
    const result = yield* electronDialog
      .showMessageBox(
        {
          type: "question",
          message,
          detail: `Kin on this computer signs out of your team's Kin at ${readableHost(origin)}. To come back to it, you'll need a new join link.`,
          buttons: [confirmLabel, "Cancel"],
          defaultId: 0,
          cancelId: 1,
        },
        Option.getOrUndefined(window),
      )
      .pipe(Effect.orElseSucceed(() => ({ response: 1, checkboxChecked: false })));
    return result.response === 0;
  });

  const forget = Effect.fn("KinShell.forget")(function* (origin: string) {
    yield* Effect.promise(() =>
      Electron.session.defaultSession.clearStorageData({ origin }).catch(() => undefined),
    );
    yield* remember(Option.none());
  });

  const joinWith = Effect.fn("KinShell.joinWith")(function* (text: string) {
    const link = readKinDesktopLink(text);
    if (link._tag === "NotALink") return KIN_SHELL_COPY.notALink;
    if (link._tag === "Insecure") return KIN_SHELL_COPY.insecure;
    if (Option.isSome(remembered) && remembered.value.origin !== link.origin) {
      const previousOrigin = remembered.value.origin;
      if (!(yield* confirmLeaving(previousOrigin, "Join a different team's Kin?", "Join"))) {
        return null;
      }
      yield* forget(previousOrigin);
    }
    joining = { origin: link.origin, previous: remembered };
    yield* remember(Option.some({ mode: "join", origin: link.origin }));
    yield* logInfo("joining", { host: readableHost(link.origin) });
    yield* goHost(link.url);
    return null;
  });

  const linkFailed = Effect.fn("KinShell.linkFailed")(function* (status: number) {
    const failed = joining;
    joining = null;
    if (failed === null) return;
    yield* logWarning("the host refused the link", { status });
    yield* remember(failed.previous);
    yield* showJoin(status === 409 ? KIN_SHELL_COPY.limit : KIN_SHELL_COPY.spent);
  });

  const handleLink = Effect.fn("KinShell.handleLink")(function* (text: string) {
    const problem = yield* joinWith(text);
    if (problem !== null) yield* showJoin(problem);
  });

  const openStart = Effect.gen(function* () {
    if (pendingLink !== null) {
      const link = pendingLink;
      pendingLink = null;
      return yield* handleLink(link);
    }
    if (Option.isNone(remembered)) return yield* showJoin(null);
    const origin = remembered.value.origin;
    if ((yield* sessionState(origin)) === "signed-out") {
      yield* remember(Option.none());
      return yield* showJoin(KIN_SHELL_COPY.signedOut);
    }
    yield* goHost(hostHome(origin));
  }).pipe(Effect.withSpan("KinShell.openStart"));

  const openOutside = (url: string) =>
    kinShellNavigation({ url, hostOrigin: null, isAppPage }) === "outside"
      ? electronShell.openExternal(url).pipe(Effect.asVoid)
      : Effect.void;

  const installContextMenu = (window: Electron.BrowserWindow) => {
    window.webContents.on("context-menu", (_event, params) => {
      const template: Electron.MenuItemConstructorOptions[] = [];
      for (const suggestion of params.dictionarySuggestions.slice(0, 5)) {
        template.push({
          label: suggestion,
          click: () => window.webContents.replaceMisspelling(suggestion),
        });
      }
      if (template.length > 0) template.push({ type: "separator" });
      if (kinShellNavigation({ url: params.linkURL, hostOrigin: null, isAppPage }) === "outside") {
        template.push(
          {
            label: "Copy Link",
            click: () => void runPromise(electronShell.copyText(params.linkURL)),
          },
          { type: "separator" },
        );
      }
      template.push(
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "selectAll", enabled: params.editFlags.canSelectAll },
      );
      void runPromise(electronMenu.popupTemplate({ window, template }));
    });
  };

  const saveBounds = Effect.fn("KinShell.saveBounds")(function* (window: Electron.BrowserWindow) {
    if (window.isDestroyed() || window.isMinimized()) return;
    const bounds = DesktopAppSettings.normalizeMainWindowBounds(window.getNormalBounds());
    if (bounds === null) return;
    yield* desktopSettings.setMainWindowBounds(bounds, window.isMaximized()).pipe(Effect.ignore);
  });

  const createWindow = Effect.gen(function* () {
    if (yield* Ref.get(desktopState.quitting)) return Option.none<Electron.BrowserWindow>();
    const settings = yield* desktopSettings.get;
    const displays = yield* Effect.sync(() =>
      Electron.screen.getAllDisplays().map((display) => display.bounds),
    );
    const bounds = DesktopWindow.resolveInitialMainWindowBounds(
      settings.mainWindowBounds,
      displays,
    );
    const iconPaths = yield* assets.iconPaths;
    const icon =
      environment.platform === "darwin"
        ? Option.none<string>()
        : environment.platform === "win32"
          ? iconPaths.ico
          : iconPaths.png;
    const dark = yield* electronTheme.shouldUseDarkColors;
    const window = yield* electronWindow.create({
      ...bounds,
      minWidth: 420,
      minHeight: 520,
      show: false,
      title: environment.displayName,
      backgroundColor: dark ? "#0c1018" : "#ffffff",
      autoHideMenuBar: true,
      ...DesktopWindow.getWindowTitleBarOptions(dark, environment.platform),
      ...(Option.isSome(icon) ? { icon: icon.value } : {}),
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
        spellcheck: true,
      },
    });
    const contents = window.webContents;

    contents.setWindowOpenHandler(({ url }) => {
      void runPromise(openOutside(url));
      return { action: "deny" };
    });
    const guardNavigation = (event: Electron.Event, url: string) => {
      const decision = kinShellNavigation({ url, hostOrigin: currentHostOrigin(), isAppPage });
      if (decision === "stay") return;
      event.preventDefault();
      if (decision === "outside") void runPromise(openOutside(url));
    };
    contents.on("will-navigate", (event, url) => guardNavigation(event, url));
    contents.on("will-redirect", (event) => {
      if (event.isMainFrame) guardNavigation(event, event.url);
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        const host = currentHostOrigin();
        if (!isMainFrame || errorCode === ERR_ABORTED || host === null) return;
        if (!URL.canParse(validatedURL) || new URL(validatedURL).origin !== host) return;
        lastTarget = validatedURL;
        void runPromise(
          logWarning("team's Kin did not load", { errorCode, errorDescription }).pipe(
            Effect.andThen(showUnreachable(host)),
          ),
        );
      },
    );
    contents.on("did-navigate", (_event, url, httpResponseCode) => {
      const host = currentHostOrigin();
      if (host === null || !URL.canParse(url) || new URL(url).origin !== host) return;
      if (!HOST_DOWN_STATUSES.has(httpResponseCode)) {
        retried = false;
        return;
      }
      lastTarget = url;
      void runPromise(showUnreachable(host));
    });
    contents.on("render-process-gone", (_event, details) => {
      if (details.reason !== "clean-exit" && !window.isDestroyed()) contents.reload();
    });
    installContextMenu(window);
    window.once("ready-to-show", () => void runPromise(electronWindow.reveal(window)));
    window.on("close", () => void runPromise(saveBounds(window)));
    window.on("closed", () => void runPromise(electronWindow.clearMain(Option.some(window))));
    if (settings.mainWindowMaximized) window.maximize();

    yield* electronWindow.setMain(window);
    yield* openStart;
    return Option.some(window);
  }).pipe(Effect.withSpan("KinShell.createWindow"));

  const ensureMain = Effect.gen(function* () {
    const existing = yield* mainWindow;
    if (Option.isSome(existing)) return existing;
    return yield* createWindow;
  }).pipe(mainWindowMutex.withPermits(1));

  const requireWindow = (window: Option.Option<Electron.BrowserWindow>) =>
    Option.match(window, { onNone: () => Effect.interrupt, onSome: Effect.succeed });

  const activate = Effect.gen(function* () {
    const window = yield* ensureMain;
    if (Option.isSome(window)) yield* electronWindow.reveal(window.value);
  }).pipe(Effect.withSpan("KinShell.activate"));

  const useDifferentLink = Effect.gen(function* () {
    yield* activate;
    if (Option.isSome(remembered)) {
      const origin = remembered.value.origin;
      if (!(yield* confirmLeaving(origin, "Use a different link?", "Use a different link"))) {
        return;
      }
      yield* forget(origin);
    }
    joining = null;
    yield* showJoin(null);
  }).pipe(
    Effect.catch((error) => logWarning("could not show the join page", { message: error.message })),
    Effect.withSpan("KinShell.useDifferentLink"),
  );

  const changeZoom = (direction: DesktopWindow.MainWindowZoomDirection) =>
    Effect.map(
      mainWindow,
      Option.map((window) => {
        const { webContents } = window;
        webContents.setZoomLevel(
          direction === "reset"
            ? 0
            : webContents.getZoomLevel() + (direction === "in" ? 0.5 : -0.5),
        );
        if (environment.platform === "darwin") DesktopWindow.syncMacosWindowButtons(window);
      }),
    );

  const runContentsCommand = (command: DesktopWindow.MainWindowContentsCommand) =>
    Effect.map(
      mainWindow,
      Option.map(({ webContents }) =>
        command === "reload"
          ? webContents.reload()
          : command === "forceReload"
            ? webContents.reloadIgnoringCache()
            : webContents.toggleDevTools(),
      ),
    );

  const windowService = DesktopWindow.DesktopWindow.of({
    createMain: createWindow.pipe(Effect.flatMap(requireWindow)),
    ensureMain: ensureMain.pipe(Effect.flatMap(requireWindow)),
    revealOrCreateMain: ensureMain.pipe(
      Effect.flatMap(requireWindow),
      Effect.tap((window) => electronWindow.reveal(window)),
    ),
    activate,
    createMainIfBackendReady: Effect.asVoid(ensureMain),
    showConnectingSplash: Effect.void,
    handleBackendReady: Effect.fn("KinShell.handleBackendReady")(function* () {}),
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: mainWindow.pipe(
      Effect.flatMap((window) => (Option.isSome(window) ? saveBounds(window.value) : Effect.void)),
    ),
    prepareCaptureReveal: Effect.void,
    dispatchMenuAction: Effect.fn("KinShell.dispatchMenuAction")(function* () {}),
    dispatchSnapShotEvent: Effect.fn("KinShell.dispatchSnapShotEvent")(function* () {}),
    zoomMain: Effect.fn("KinShell.zoomMain")(function* (direction) {
      yield* changeZoom(direction);
    }),
    runMainContentsCommand: Effect.fn("KinShell.runMainContentsCommand")(function* (command) {
      yield* runContentsCommand(command);
    }),
    syncAppearance: Effect.gen(function* () {
      const dark = yield* electronTheme.shouldUseDarkColors;
      yield* electronWindow.syncAllAppearance((window, { titleBarOverlay }) =>
        DesktopWindow.syncWindowAppearance(window, titleBarOverlay, dark, environment.platform),
      );
    }),
  });

  const servePage = (request: Request) => {
    const url = new URL(request.url);
    const headers = {
      "content-security-policy": KIN_SHELL_PAGE_POLICY,
      "cache-control": "no-store",
    };
    if (url.host !== DESKTOP_HOST || request.method !== "GET") {
      return new Response(null, { status: 404 });
    }
    if (url.pathname === "/shell.js") {
      return new Response(KIN_SHELL_PAGE_SCRIPT, {
        headers: { ...headers, "content-type": "text/javascript; charset=utf-8" },
      });
    }
    if (url.pathname === "/") {
      return new Response(KIN_SHELL_PAGE_HTML, {
        headers: { ...headers, "content-type": "text/html; charset=utf-8" },
      });
    }
    return new Response(null, { status: 404 });
  };

  const installSessionRules = Effect.sync(() => {
    const session = Electron.session.defaultSession;
    session.setPermissionRequestHandler((_contents, permission, callback, details) =>
      callback(
        kinShellAllowsPermission({
          permission,
          requestingUrl: details.requestingUrl,
          hostOrigin: currentHostOrigin(),
        }),
      ),
    );
    session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
      kinShellAllowsPermission({
        permission,
        requestingUrl: requestingOrigin,
        hostOrigin: currentHostOrigin(),
      }),
    );
    session.setDevicePermissionHandler(() => false);
    session.webRequest.onBeforeRequest({ urls: ["*://*/"] }, (details, callback) => {
      const home =
        details.resourceType === "mainFrame"
          ? kinShellRootRedirect(details.url, currentHostOrigin())
          : null;
      callback(home === null ? {} : { redirectURL: home });
    });
    // The host's own page redeems the link; its answer says whether this computer got in.
    session.webRequest.onCompleted(
      { urls: [`*://*${KIN_INVITE_BROWSER_ACCEPT_ROUTE}`, `*://*${PAIR_SESSION_ROUTE}`] },
      (details) => {
        if (joining === null || details.method !== "POST") return;
        if (!URL.canParse(details.url) || new URL(details.url).origin !== joining.origin) return;
        if (details.statusCode >= 200 && details.statusCode < 300) joining = null;
        else void runPromise(linkFailed(details.statusCode));
      },
    );
  });

  const start = Effect.gen(function* () {
    yield* Effect.acquireRelease(
      Effect.sync(() => Electron.protocol.handle(appScheme, servePage)),
      () => Effect.sync(() => Electron.protocol.unhandle(appScheme)),
    );
    yield* installSessionRules;
    yield* Effect.sync(() => {
      for (const channel of Channels.CLERK_CHANNELS) Electron.ipcMain.removeHandler(channel);
      Electron.ipcMain.removeAllListeners(Channels.ELECTRON_STORE_CHANNEL);
    });
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: Channels.KIN_SHELL_STATE_CHANNEL,
        payload: Schema.Void,
        result: Schema.Struct({
          view: Schema.Literals(["join", "unreachable"]),
          host: Schema.NullOr(Schema.String),
          problem: Schema.NullOr(Schema.String),
          canGoBack: Schema.Boolean,
        }),
        handler: () => Effect.sync(() => view),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: Channels.KIN_SHELL_JOIN_CHANNEL,
        payload: Schema.String,
        result: Schema.Struct({ problem: Schema.NullOr(Schema.String) }),
        handler: (text) => joinWith(text).pipe(Effect.map((problem) => ({ problem }))),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: Channels.KIN_SHELL_RETRY_CHANNEL,
        payload: Schema.Void,
        result: Schema.Void,
        handler: Effect.fn("KinShell.retry")(function* () {
          const host = currentHostOrigin();
          retried = true;
          yield* goHost(lastTarget ?? (host === null ? appUrl : hostHome(host)));
        }),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: Channels.KIN_SHELL_USE_DIFFERENT_LINK_CHANNEL,
        payload: Schema.Void,
        result: Schema.Void,
        handler: () => useDifferentLink,
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: Channels.KIN_SHELL_BACK_CHANNEL,
        payload: Schema.Void,
        result: Schema.Void,
        handler: Effect.fn("KinShell.back")(function* () {
          if (Option.isSome(remembered)) yield* goHost(hostHome(remembered.value.origin));
        }),
      }),
    );
    yield* logInfo("kin shell ready", { joined: Option.isSome(remembered) });
    return false;
  }).pipe(Effect.withSpan("KinShell.start"));

  const shell = KinShell.of({
    start,
    receiveLink: Effect.fn("KinShell.receiveLink")(function* (url) {
      const window = yield* mainWindow;
      if (Option.isNone(window)) {
        pendingLink = url;
        return;
      }
      yield* electronWindow.reveal(window.value);
      yield* handleLink(url);
    }),
    useDifferentLink,
    openHostInBrowser: Effect.suspend(() =>
      Option.isSome(remembered) ? openOutside(hostHome(remembered.value.origin)) : Effect.void,
    ),
  });

  return Context.make(DesktopWindow.DesktopWindow, windowService).pipe(
    Context.add(KinShell, shell),
  );
});

/** Kin's window on the team's host, in place of the T3 Code window. */
export const layer = Layer.effectContext(make);

/** Join links handed to the app (`open-url`, a second launch) go to the shell. */
export const layerWebLinks = Layer.effect(
  DesktopWebLinks.DesktopWebLinks,
  Effect.gen(function* () {
    const shell = yield* KinShell;
    return DesktopWebLinks.DesktopWebLinks.of({
      receive: Effect.fn("KinShell.webLinks.receive")(function* (url) {
        yield* shell.receiveLink(url);
      }),
      setRendererReady: Effect.fn("KinShell.webLinks.setRendererReady")(function* () {}),
    });
  }),
);
