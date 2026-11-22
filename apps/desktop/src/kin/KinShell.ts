import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
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
  kinShellCrashReload,
  kinShellNavigation,
  kinShellOutsideOpen,
  kinShellRedeemResult,
  kinShellRootRedirect,
  kinShellSessionProbe,
  kinTeamHome,
  readKinDesktopLink,
  readKinOsLink,
} from "./kinDesktopLink.ts";
import { isAppPageUrl } from "./appPage.ts";
import * as Channels from "./kinShellChannels.ts";
import {
  KIN_SHELL_COPY,
  KIN_SHELL_PAGE_HTML,
  KIN_SHELL_PAGE_POLICY,
  KIN_SHELL_PAGE_SCRIPT,
  kinShellJoinQuestion,
  type KinShellView,
} from "./kinShellPages.ts";
import { makeKinShellTransitions } from "./kinShellTransitions.ts";

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
const PAIR_PAGE = "/pair";
const PAIR_SESSION_ROUTE = "/api/auth/browser-session";
const SESSION_STATE_ROUTE = "/api/auth/session";
const SESSION_PROBE_TIMEOUT_MS = 10_000;
const ERR_ABORTED = -3;
const HOST_DOWN_STATUSES = new Set([502, 503, 504]);

const { logInfo, logWarning } = makeComponentLogger("kin-shell");

const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(KinShellSettings));

class KinShellSessionCheckError extends Schema.TaggedError<KinShellSessionCheckError>()(
  "KinShellSessionCheckError",
  { cause: Schema.Defect() },
) {}

class KinShellClearStorageError extends Schema.TaggedError<KinShellClearStorageError>()(
  "KinShellClearStorageError",
  { cause: Schema.Defect() },
) {}

export class KinShell extends Context.Service<
  KinShell,
  {
    /** Serves the app's own pages and their controls, in place of the bundled server. */
    readonly start: Effect.Effect<boolean, DesktopIpc.DesktopIpcRegistrationError, Scope.Scope>;
    /** A join link the operating system handed over: `kin://kin/join?link=…` or `kin://pair?…`. */
    readonly receiveLink: (url: string) => Effect.Effect<void>;
    readonly useDifferentLink: Effect.Effect<void>;
    /** Asks first, then leaves the team on this computer: the way out that needs no new link. */
    readonly signOut: Effect.Effect<void>;
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
  const transitionLock = yield* Semaphore.make(1);
  /** Open once the app's scheme, the session's rules and the IPC guard are installed. */
  const rulesInstalled = yield* Deferred.make<void>();
  const runPromise = Effect.runPromiseWith(yield* Effect.context<Path.Path>());

  const appUrl = getDesktopUrl(environment.isDevelopment);
  const appScheme = getDesktopScheme(environment.isDevelopment);
  const settingsPath = path.join(environment.stateDir, KIN_SHELL_SETTINGS_FILE);
  const preloadPath = path.join(path.dirname(environment.preloadPath), "kin-shell-preload.cjs");
  const isAppPage = isAppPageUrl;

  const saved = Option.flatMap(
    yield* fileSystem.readFileString(settingsPath).pipe(Effect.option),
    decodeSettings,
  );
  const owner = makeKinShellTransitions(
    Option.getOrNull(Option.map(saved, (settings) => settings.origin)),
  );
  let view: KinShellView = { view: "join", host: null, problem: null, canGoBack: false };
  /** What Try again opens: the host page that failed, else the last one the shell opened. */
  let lastTarget: string | null = null;
  let retried = false;
  let crashes: ReadonlyArray<number> = [];
  /** The last click or Enter in the window; only a person's action may open the browser. */
  let lastPersonAction = Number.NEGATIVE_INFINITY;

  const readableHost = (origin: string) => new URL(origin).host;
  const hostHome = kinTeamHome;
  const locked = <A, E, R>(effect: Effect.Effect<A, E, R>) => transitionLock.withPermits(1)(effect);

  const persist = Effect.fn("KinShell.persist")(
    function* (origin: string | null) {
      if (origin === null) {
        yield* fileSystem.remove(settingsPath, { force: true });
        return;
      }
      const encoded = yield* encodeSettings({ mode: "join", origin });
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      const temporary = `${settingsPath}.tmp`;
      yield* fileSystem.writeFileString(temporary, `${encoded}\n`);
      yield* fileSystem.rename(temporary, settingsPath);
    },
    Effect.catch((error) =>
      logWarning("could not save which Kin this computer joined", { message: error.message }),
    ),
  );

  /** Removes what a team's host stored on this computer; false when that failed. */
  const clearOrigin = Effect.fn("KinShell.clearOrigin")(
    function* (origin: string) {
      yield* Effect.tryPromise({
        try: () => Electron.session.defaultSession.clearStorageData({ origin }),
        catch: (cause) => new KinShellClearStorageError({ cause }),
      });
      return true;
    },
    Effect.catch((error) =>
      logWarning("could not clear a team's storage", { message: error.message }).pipe(
        Effect.as(false),
      ),
    ),
  );

  const mainWindow = electronWindow.main.pipe(
    Effect.map(Option.filter((window) => !window.isDestroyed())),
  );

  /** Every main-process load goes through here, and is checked against the current team then. */
  const load = Effect.fn("KinShell.load")(function* (url: string) {
    const allowed =
      isAppPage(url) ||
      kinShellNavigation({ url, hostOrigin: owner.hostOrigin(), isAppPage }) === "stay";
    if (!allowed) {
      yield* logWarning("refused to load a page off the team's host");
      return;
    }
    const window = yield* mainWindow;
    if (Option.isNone(window)) return;
    window.value.loadURL(url).catch(() => undefined);
  });

  const showPage = Effect.fn("KinShell.showPage")(function* (next: KinShellView) {
    view = next;
    yield* load(appUrl);
  });

  const showJoin = (problem: string | null) => {
    const team = owner.remembered();
    return showPage({
      view: "join",
      host: team === null ? null : readableHost(team),
      problem,
      canGoBack: team !== null,
    });
  };

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

  const notify = Effect.fn("KinShell.notify")(function* (message: string, detail: string) {
    const window = yield* mainWindow;
    yield* electronDialog
      .showMessageBox(
        { type: "info", message, detail, buttons: ["OK"] },
        Option.getOrUndefined(window),
      )
      .pipe(Effect.ignore);
  });

  const stampPersonAction = () =>
    void runPromise(
      Effect.map(Clock.currentTimeMillis, (now) => {
        lastPersonAction = now;
      }),
    );

  const ask = Effect.fn("KinShell.ask")(function* (question: {
    readonly message: string;
    readonly detail: string;
    readonly confirm: string;
    readonly defaultToCancel: boolean;
  }) {
    const window = yield* mainWindow;
    const result = yield* electronDialog
      .showMessageBox(
        {
          type: "question",
          message: question.message,
          detail: question.detail,
          buttons: [question.confirm, "Cancel"],
          defaultId: question.defaultToCancel ? 1 : 0,
          cancelId: 1,
        },
        Option.getOrUndefined(window),
      )
      .pipe(Effect.orElseSucceed(() => ({ response: 1, checkboxChecked: false })));
    return result.response === 0;
  });

  /** Whether the host still knows this computer; only its own direct answer counts. */
  const sessionState = Effect.fn("KinShell.sessionState")(function* (origin: string) {
    const response = yield* Effect.tryPromise({
      try: async () => {
        const answer = await Electron.session.defaultSession.fetch(
          new URL(SESSION_STATE_ROUTE, origin).toString(),
          {
            credentials: "include",
            cache: "no-store",
            redirect: "error",
            signal: AbortSignal.timeout(SESSION_PROBE_TIMEOUT_MS),
          },
        );
        const body: unknown = await answer.json().catch(() => null);
        return { status: answer.status, url: answer.url, redirected: answer.redirected, body };
      },
      catch: (cause) => new KinShellSessionCheckError({ cause }),
    }).pipe(Effect.orElseSucceed(() => null));
    return kinShellSessionProbe({ origin, response });
  });

  /** A link the host is redeeming didn't work: back to the team the window was on, if any. */
  const joinFailed = Effect.fn("KinShell.joinFailed")(function* (seen: number, problem: string) {
    const failed = owner.failed(seen);
    if (failed === null) return;
    yield* logWarning("the link didn't sign this computer in", {
      host: readableHost(failed.origin),
    });
    if (failed.previous === null) return yield* showJoin(problem);
    yield* goHost(hostHome(failed.previous));
    void runPromise(notify(problem, KIN_SHELL_COPY.backOnTeam(failed.previous)));
  });

  const joinFinished = Effect.fn("KinShell.joinFinished")(function* (
    seen: number,
    status: number | null,
  ) {
    const result = kinShellRedeemResult(status);
    if (result === "limit") return yield* joinFailed(seen, KIN_SHELL_COPY.limit);
    if (result === "spent") return yield* joinFailed(seen, KIN_SHELL_COPY.spent);
    if (result === "try-again") return yield* joinFailed(seen, KIN_SHELL_COPY.tryAgain);
    const joined = owner.joined(seen);
    if (joined === null) return;
    yield* persist(joined.origin);
    yield* logInfo("joined", { host: readableHost(joined.origin) });
    if (joined.clear === null) return;
    if (!(yield* clearOrigin(joined.clear))) {
      void runPromise(
        notify(
          KIN_SHELL_COPY.clearFailed,
          KIN_SHELL_COPY.clearFailedDetail(joined.origin, joined.clear),
        ),
      );
    }
  });

  /** A pasted link is the person's own action; a link from outside the app is only a proposal. */
  const joinWith = Effect.fn("KinShell.joinWith")(function* (text: string, fromOutside: boolean) {
    const link = fromOutside ? readKinOsLink(text) : readKinDesktopLink(text);
    if (link._tag !== "Link") {
      const problem =
        link._tag === "Insecure"
          ? KIN_SHELL_COPY.insecure
          : link._tag === "Ambiguous"
            ? KIN_SHELL_COPY.ambiguous
            : KIN_SHELL_COPY.notALink;
      return { problem, leaving: false };
    }
    const question = kinShellJoinQuestion({
      origin: link.origin,
      current: owner.remembered(),
      fromOutside,
    });
    if (question !== null && !(yield* ask(question))) return { problem: null, leaving: false };
    const page = new URL(link.url).pathname;
    owner.startJoin(
      link.origin,
      page,
      page === PAIR_PAGE ? PAIR_SESSION_ROUTE : KIN_INVITE_BROWSER_ACCEPT_ROUTE,
    );
    retried = false;
    yield* logInfo("joining", { host: readableHost(link.origin) });
    yield* goHost(link.url);
    return { problem: null, leaving: true };
  });

  const openStart = Effect.gen(function* () {
    const launch = yield* locked(
      Effect.gen(function* () {
        const seen = owner.begin();
        const origin = owner.remembered();
        if (origin !== null) return { seen, origin };
        yield* showJoin(null);
        return null;
      }),
    );
    if (launch === null) return;
    const { seen, origin } = launch;
    const probe = yield* sessionState(origin);
    yield* locked(
      Effect.gen(function* () {
        if (!owner.isCurrent(seen)) return yield* logInfo("dropped a launch check that came late");
        if (probe === "signed-out" && owner.signedOut(seen, origin)) {
          yield* persist(null);
          yield* clearOrigin(origin);
          return yield* showJoin(KIN_SHELL_COPY.signedOut);
        }
        if (probe === "unreachable") {
          lastTarget = hostHome(origin);
          return yield* showUnreachable(origin);
        }
        yield* goHost(hostHome(origin));
      }),
    );
  }).pipe(Effect.withSpan("KinShell.openStart"));

  /** An address off the team's host; only a person's click or Enter opens the browser. */
  const openOutsideFromPage = Effect.fn("KinShell.openOutsideFromPage")(function* (
    url: string,
    cause: "navigate" | "new-window" | "redirect",
  ) {
    const now = yield* Clock.currentTimeMillis;
    const rule = kinShellOutsideOpen({ cause, sincePersonAction: now - lastPersonAction });
    if (rule === "block") {
      return yield* logWarning("kept a page from opening the browser by itself", { cause });
    }
    lastPersonAction = Number.NEGATIVE_INFINITY;
    if (rule === "ask") {
      const open = yield* ask({
        message: "Open this address in your browser?",
        detail: `Your team's Kin sent this window to ${url}`,
        confirm: "Open",
        defaultToCancel: true,
      });
      if (!open) return;
    }
    yield* electronShell.openExternal(url).pipe(Effect.asVoid);
  });

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
    yield* Deferred.await(rulesInstalled);
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
        devTools: environment.isDevelopment,
      },
    });
    const contents = window.webContents;

    contents.on("before-input-event", (_event, input) => {
      if (input.type === "keyDown" && (input.key === "Enter" || input.key === " ")) {
        stampPersonAction();
      }
    });
    contents.on("before-mouse-event", (_event, mouse) => {
      if (mouse.type === "mouseUp" && mouse.button !== "right") stampPersonAction();
    });
    // The main process decides when the window leaves a page; a page can't hold it there.
    contents.on("will-prevent-unload", (event) => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (kinShellNavigation({ url, hostOrigin: null, isAppPage }) === "outside") {
        void runPromise(openOutsideFromPage(url, "new-window"));
      }
      return { action: "deny" };
    });
    contents.on("will-navigate", (event) => {
      const decision = kinShellNavigation({
        url: event.url,
        hostOrigin: owner.hostOrigin(),
        isAppPage,
      });
      if (decision === "stay") return;
      event.preventDefault();
      if (decision === "outside") void runPromise(openOutsideFromPage(event.url, "navigate"));
    });
    contents.on("will-redirect", (event) => {
      if (!event.isMainFrame) return;
      const host = owner.hostOrigin();
      const decision = kinShellNavigation({ url: event.url, hostOrigin: host, isAppPage });
      if (decision === "stay") return;
      event.preventDefault();
      const attempt = owner.attempt();
      if (attempt !== null && !attempt.committed) {
        void runPromise(locked(joinFailed(attempt.generation, KIN_SHELL_COPY.redirected)));
        return;
      }
      // A load the shell started, sent off the host before it showed anything.
      const shown = contents.getURL();
      if (host !== null && (!URL.canParse(shown) || new URL(shown).origin !== host)) {
        void runPromise(locked(showUnreachable(host)));
        return;
      }
      if (decision === "outside") void runPromise(openOutsideFromPage(event.url, "redirect"));
    });
    contents.on("will-attach-webview", (event) => event.preventDefault());
    contents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        const host = owner.hostOrigin();
        if (!isMainFrame || errorCode === ERR_ABORTED || host === null) return;
        if (!URL.canParse(validatedURL) || new URL(validatedURL).origin !== host) return;
        lastTarget = validatedURL;
        void runPromise(
          logWarning("team's Kin did not load", { errorCode, errorDescription }).pipe(
            Effect.andThen(locked(showUnreachable(host))),
          ),
        );
      },
    );
    contents.on("did-navigate", (_event, url, httpResponseCode) => {
      const host = owner.hostOrigin();
      if (host === null || !URL.canParse(url) || new URL(url).origin !== host) return;
      const attempt = owner.attempt();
      if (attempt !== null && new URL(url).pathname === attempt.page) {
        owner.committed(attempt.generation);
        // The host has no such page, so nothing will redeem the link.
        if (httpResponseCode >= 400 && !HOST_DOWN_STATUSES.has(httpResponseCode)) {
          void runPromise(locked(joinFailed(attempt.generation, KIN_SHELL_COPY.notALink)));
          return;
        }
      }
      if (!HOST_DOWN_STATUSES.has(httpResponseCode)) {
        retried = false;
        return;
      }
      lastTarget = url;
      void runPromise(locked(showUnreachable(host)));
    });
    contents.on("render-process-gone", (_event, details) => {
      if (details.reason === "clean-exit" || window.isDestroyed()) return;
      void runPromise(
        Effect.gen(function* () {
          const next = kinShellCrashReload(crashes, yield* Clock.currentTimeMillis);
          crashes = next.crashes;
          if (next.reload) return contents.reload();
          const host = owner.hostOrigin();
          const crashed = contents.getURL();
          if (host !== null && URL.canParse(crashed) && new URL(crashed).origin === host) {
            lastTarget = crashed;
          }
          yield* logWarning("team's Kin kept stopping", { reason: details.reason });
          yield* locked(
            showPage({
              view: "stopped",
              host: host === null ? null : readableHost(host),
              problem: null,
              canGoBack: false,
            }),
          );
        }),
      );
    });
    const sendFullscreen = (fullscreen: boolean) =>
      contents.send(Channels.KIN_SHELL_FULLSCREEN_CHANNEL, fullscreen);
    window.on("enter-full-screen", () => sendFullscreen(true));
    window.on("leave-full-screen", () => sendFullscreen(false));
    contents.on("dom-ready", () => sendFullscreen(window.isFullScreen()));
    installContextMenu(window);
    window.once("ready-to-show", () => void runPromise(electronWindow.reveal(window)));
    window.on("close", () => void runPromise(saveBounds(window)));
    window.on("closed", () => void runPromise(electronWindow.clearMain(Option.some(window))));
    if (settings.mainWindowMaximized) window.maximize();

    yield* electronWindow.setMain(window);
    void runPromise(openStart);
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

  /** The join page, with the way back to the team; nothing is signed out until a new link works. */
  const useDifferentLink = Effect.gen(function* () {
    yield* activate;
    yield* locked(
      Effect.gen(function* () {
        owner.begin();
        yield* showJoin(null);
      }),
    );
  }).pipe(
    Effect.catch((error) => logWarning("could not show the join page", { message: error.message })),
    Effect.withSpan("KinShell.useDifferentLink"),
  );

  const signOut = Effect.gen(function* () {
    const team = owner.remembered();
    if (team === null) return;
    yield* activate;
    const host = readableHost(team);
    const sure = yield* ask({
      message: KIN_SHELL_COPY.signOutQuestion,
      detail: KIN_SHELL_COPY.signOutDetail(host),
      confirm: KIN_SHELL_COPY.signOutConfirm,
      defaultToCancel: true,
    });
    if (!sure) return;
    const cleared = yield* locked(
      Effect.gen(function* () {
        // The team may have changed while the question was up.
        if (owner.remembered() !== team) return true;
        owner.forget();
        // The join page first, so the team's page is gone before its storage is.
        yield* showJoin(null);
        yield* persist(null);
        return yield* clearOrigin(team);
      }),
    );
    if (!cleared) yield* notify(KIN_SHELL_COPY.signOutClearFailed(host), "");
  }).pipe(
    Effect.catch((error) => logWarning("could not sign out", { message: error.message })),
    Effect.withSpan("KinShell.signOut"),
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

  /** The host's own page redeems the link; this attempt's answer says whether the computer got in. */
  const redeemAnswer = (
    details: { readonly url: string; readonly method: string; readonly webContentsId?: number },
    status: number | null,
  ) => {
    const attempt = owner.attempt();
    if (attempt === null || !attempt.committed || details.method !== "POST") return;
    if (!URL.canParse(details.url)) return;
    const url = new URL(details.url);
    if (url.origin !== attempt.origin || url.pathname !== attempt.redeemRoute) return;
    void runPromise(
      Effect.gen(function* () {
        const window = yield* mainWindow;
        if (Option.isNone(window) || window.value.webContents.id !== details.webContentsId) return;
        yield* locked(joinFinished(attempt.generation, status));
      }),
    );
  };

  const installSessionRules = Effect.sync(() => {
    const session = Electron.session.defaultSession;
    session.setPermissionRequestHandler((_contents, permission, callback, details) =>
      callback(
        kinShellAllowsPermission({
          permission,
          requestingUrl: details.requestingUrl,
          hostOrigin: owner.hostOrigin(),
        }),
      ),
    );
    session.setPermissionCheckHandler((_contents, permission, requestingOrigin) =>
      kinShellAllowsPermission({
        permission,
        requestingUrl: requestingOrigin,
        hostOrigin: owner.hostOrigin(),
      }),
    );
    session.setDevicePermissionHandler(() => false);
    session.webRequest.onBeforeRequest({ urls: ["*://*/"] }, (details, callback) => {
      const home =
        details.resourceType === "mainFrame"
          ? kinShellRootRedirect(details.url, owner.hostOrigin())
          : null;
      callback(home === null ? {} : { redirectURL: home });
    });
    const redeemRoutes = {
      urls: [`*://*${KIN_INVITE_BROWSER_ACCEPT_ROUTE}`, `*://*${PAIR_SESSION_ROUTE}`],
    };
    session.webRequest.onCompleted(redeemRoutes, (details) =>
      redeemAnswer(details, details.statusCode),
    );
    session.webRequest.onErrorOccurred(redeemRoutes, (details) => redeemAnswer(details, null));
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
          view: Schema.Literals(["join", "unreachable", "stopped"]),
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
        result: Schema.Struct({ problem: Schema.NullOr(Schema.String), leaving: Schema.Boolean }),
        handler: (text) => locked(joinWith(text, false)),
      }),
    );
    yield* ipc.handle(
      DesktopIpc.makeIpcMethod({
        channel: Channels.KIN_SHELL_RETRY_CHANNEL,
        payload: Schema.Void,
        result: Schema.Void,
        handler: () =>
          locked(
            Effect.gen(function* () {
              const host = owner.hostOrigin();
              retried = true;
              crashes = [];
              yield* goHost(lastTarget ?? (host === null ? appUrl : hostHome(host)));
            }),
          ),
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
        handler: () =>
          locked(
            Effect.gen(function* () {
              owner.begin();
              const team = owner.remembered();
              if (team !== null) yield* goHost(hostHome(team));
            }),
          ),
      }),
    );
    yield* Deferred.succeed(rulesInstalled, undefined);
    yield* logInfo("kin shell ready", { joined: owner.remembered() !== null });
    return false;
  }).pipe(Effect.withSpan("KinShell.start"));

  const shell = KinShell.of({
    start,
    receiveLink: Effect.fn("KinShell.receiveLink")(
      function* (url) {
        yield* Deferred.await(rulesInstalled);
        const window = yield* ensureMain;
        if (Option.isNone(window)) return;
        yield* electronWindow.reveal(window.value);
        const result = yield* locked(joinWith(url, true));
        if (result.problem !== null) yield* notify(result.problem, "");
      },
      Effect.catch((error) => logWarning("could not open a join link", { message: error.message })),
    ),
    useDifferentLink,
    signOut,
    openHostInBrowser: Effect.suspend(() => {
      const team = owner.remembered();
      return team === null
        ? Effect.void
        : electronShell.openExternal(hostHome(team)).pipe(Effect.asVoid);
    }),
  });

  return Context.make(DesktopWindow.DesktopWindow, windowService).pipe(
    Context.add(KinShell, shell),
  );
});

/** Kin's window on the team's host, in place of the T3 Code window. */
export const layer = Layer.effectContext(make);

/** Join links the operating system hands over (`open-url`, a second launch) go to the shell. */
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
