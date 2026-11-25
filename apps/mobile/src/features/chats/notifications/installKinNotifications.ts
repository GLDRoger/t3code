import {
  environmentSessionGenerationAtom,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentAuthorizationError,
  KinChatError,
  type EnvironmentId,
  type KinWidgetsActInput,
} from "@t3tools/contracts";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AtomRegistry } from "effect/reactivity";
import { Linking, Platform } from "react-native";

import * as Dialog from "../../../components/ui/Dialog";
import { connectionAtomRuntime } from "../../../connection/runtime";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentPresentations } from "../../../state/presentation";
import { requestAgentNotificationPermission } from "../../agent-awareness/notificationPermissions";
import { resolveApsEnvironment } from "../../agent-awareness/registrationPayload";
import { startApproverKeyCleanup } from "../approvals/useKinApproverKey";
import { kinCachedOrgsAtom, kinClient } from "../state/kinClient";
import { kinHostAtom } from "../state/useKinHost";
import { KIN_ANDROID_CHANNELS, KIN_NOTIFICATION_CATEGORIES } from "./kinCategories";
import { kinActionDelivery, kinNotificationRoute, kinRefusedActionAlert } from "./kinPushPayload";
import {
  createKinPushFence,
  createKinPushRefusals,
  kinPushHost,
  kinPushLeaveOrgs,
  kinPushLeaveOutcome,
  kinPushOs,
  kinPushPermissionStep,
  kinPushRegisterInput,
  kinPushToken,
  type KinPushLeave,
} from "./kinPushRegistration";

// A refusal is final for this response; anything else (a dropped socket) waits for a connect.
const isFinalRefusal = Schema.is(Schema.Union([KinChatError, EnvironmentAuthorizationError]));

// Android shows a push only in a channel the app made; the server names one per kind.
function createChannels(): void {
  if (Platform.OS !== "android") return;
  for (const [identifier, { name, description, ...channel }] of Object.entries(
    KIN_ANDROID_CHANNELS,
  ))
    void Notifications.setNotificationChannelAsync(identifier, {
      name,
      description,
      importance:
        "quiet" in channel
          ? Notifications.AndroidImportance.LOW
          : Notifications.AndroidImportance.HIGH,
    }).catch((cause: unknown) => console.warn(`Creating ${identifier} failed`, cause));
}

function registerCategories(): void {
  for (const [identifier, actions] of Object.entries(KIN_NOTIFICATION_CATEGORIES)) {
    // An older build may have registered buttons here; the OS keeps them until removed.
    if (actions.length === 0) {
      void Notifications.deleteNotificationCategoryAsync(identifier).catch((cause: unknown) =>
        console.warn(`Removing ${identifier} failed`, cause),
      );
      continue;
    }
    void Notifications.setNotificationCategoryAsync(
      identifier,
      actions.map((action) => ({ ...action, options: { ...action.options } })),
    ).catch((cause: unknown) => console.warn(`Registering ${identifier} failed`, cause));
  }
}

// The usual host while another stands in, so a tap on its push waits for it instead of dropping.
const kinHostEnvironment = () => {
  const host = appAtomRegistry.get(kinHostAtom);
  return host._tag === "host" ? (host.standInFor ?? host.environmentId) : null;
};

const isConnected = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId)?.connection
    .phase === "connected";

/** Button taps post once the host is connected, which on a cold start is after launch. */
function createActionDelivery() {
  const pending = new Map<string, { environmentId: EnvironmentId; input: KinWidgetsActInput }>();
  const inFlight = new Set<string>();
  const flush = () => {
    for (const [key, target] of pending) {
      const delivery = kinActionDelivery({
        hostEnvironmentId: kinHostEnvironment(),
        targetEnvironmentId: target.environmentId,
        connected: isConnected(target.environmentId),
        inFlight: inFlight.has(key),
      });
      if (delivery === "drop") {
        pending.delete(key);
        console.warn("Dropped a Kin notification action for another host");
      }
      if (delivery !== "post") continue;
      inFlight.add(key);
      void runAtomCommand(appAtomRegistry, kinClient.widgetAction, target, {
        reportFailure: false,
      }).then((result) => {
        inFlight.delete(key);
        if (result._tag === "Success") {
          pending.delete(key);
          return;
        }
        const failure = squashAtomCommandFailure(result);
        if (isFinalRefusal(failure)) {
          // The chat is open by now, and its card shows the current state.
          pending.delete(key);
          console.warn("A Kin notification action was refused", failure.message);
          const alert = kinRefusedActionAlert(target.input.actionId, failure);
          Dialog.alert(alert.title, alert.message);
        }
      });
    }
  };
  const unsubscribePresentations = appAtomRegistry.subscribe(
    environmentPresentations.presentationsAtom,
    flush,
  );
  const unsubscribeHost = appAtomRegistry.subscribe(kinHostAtom, flush);
  return {
    post: (environmentId: EnvironmentId, input: KinWidgetsActInput) => {
      pending.set(input.clientActionId, { environmentId, input });
      flush();
    },
    dispose: () => {
      unsubscribePresentations();
      unsubscribeHost();
    },
  };
}

// A connect only registers a phone that already allows notifications; asking is `ask: true`.
let syncRegistration: ((ask: boolean) => void) | null = null;

const askPermission = () =>
  Effect.runPromise(
    requestAgentNotificationPermission.pipe(
      Effect.orElseSucceed(() => ({ type: "unsupported" }) as const),
    ),
  );

/**
 * A Kin chat is on screen with its host connected: the moment to ask for Kin's notifications, if
 * the phone hasn't said. Nothing is remembered, so an ask that can't run now never fires later.
 */
export function askForKinNotifications(): void {
  syncRegistration?.(true);
}

/** The Kin notifications row: asks when the phone hasn't decided, otherwise opens the OS settings. */
export async function openKinNotificationSettings(): Promise<void> {
  const existing = await Notifications.getPermissionsAsync().catch(() => null);
  if (existing !== null && !existing.granted && existing.canAskAgain) {
    await askPermission();
    syncRegistration?.(false);
    return;
  }
  await Linking.openSettings();
}

// Leaving never waits longer than this on a host that is slow to answer.
const UNREGISTER_WAIT_MS = 4_000;
const pushFence = createKinPushFence();
// The token this run last registered; the OS's own after a restart.
let registeredToken: string | null = null;

const os = kinPushOs(Platform.OS);

const deviceToken = async () =>
  registeredToken ??
  (os === null
    ? null
    : await Notifications.getDevicePushTokenAsync()
        .then((device) => kinPushToken(os, device.data))
        .catch(() => null));

/** Takes this phone's token back from each org the host names, whatever the OS permission is now. */
async function takeBackPush(environmentId: EnvironmentId) {
  const fenced = pushFence.fence(environmentId);
  const cached = await Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, kinCachedOrgsAtom(environmentId), {
      suspendOnWaiting: true,
    }).pipe(Effect.orElseSucceed(() => null)),
  );
  const host = appAtomRegistry.get(kinHostAtom);
  const orgIds = kinPushLeaveOrgs(host, environmentId, cached);
  const live =
    host._tag === "host" && host.environmentId === environmentId && host.probe._tag === "ready"
      ? host.probe.orgs
      : null;
  const team = (live ?? cached)?.orgs.find((org) => orgIds.includes(org.orgId))?.name ?? null;
  const answer = async () => {
    if (orgIds.length === 0 || !isConnected(environmentId)) return null;
    await fenced;
    const token = await deviceToken();
    if (token === null) return null;
    return Promise.all(
      orgIds.map(async (orgId) => {
        const result = await runAtomCommand(
          appAtomRegistry,
          kinClient.unregisterPush,
          { environmentId, input: { orgId, token } },
          { reportFailure: false },
        );
        return result._tag === "Success";
      }),
    );
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answers = await Promise.race([
    answer().catch((cause: unknown) => {
      console.warn("Kin push unregister failed", cause);
      return null;
    }),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), UNREGISTER_WAIT_MS);
    }),
  ]);
  clearTimeout(timer);
  return { outcome: kinPushLeaveOutcome({ orgs: orgIds.length, answers }), team };
}

/**
 * Forgets a host after taking this phone's Kin alerts back from it. Leaving always completes;
 * when the host didn't confirm, the person is told the alerts may continue, or `tell` is given
 * the outcome to tell it with others.
 */
export async function forgetKinHost<A>(
  environmentId: EnvironmentId,
  remove: () => Promise<A>,
  tell?: (outcome: KinPushLeave) => void,
): Promise<A> {
  if (os === null) return remove();
  const { outcome, team } = await takeBackPush(environmentId);
  try {
    return await remove();
  } finally {
    pushFence.release(environmentId);
    if (tell !== undefined) tell(outcome);
    else if (outcome === "unconfirmed")
      Dialog.alert(
        `${team ?? "This team"} may still notify this phone`,
        "Kin couldn't confirm with that computer. To stop them, remove this phone under Your devices from another device.",
      );
  }
}

/** Registers the APNs or FCM token with the Kin host on every connect, for each org the viewer is in. */
function createTokenRegistration() {
  if (os === null) return () => {};
  const phone = os;
  let registered: string | null = null;
  let token: string | null = null;
  let permissionAsked = false;
  const refusals = createKinPushRefusals();
  const sandbox = resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant) === "sandbox";

  const sync = async (ask: boolean) => {
    const host = kinPushHost(appAtomRegistry.get(kinHostAtom));
    if (host === null) return;
    const { environmentId } = host;
    if (token === null) {
      const existing = await Notifications.getPermissionsAsync();
      const step = kinPushPermissionStep(existing, {
        wanted: ask,
        asked: permissionAsked,
      });
      if (step === "wait") return;
      if (step === "ask") {
        permissionAsked = true;
        // The shared prompt: the OS shows it at most once, and a refusal stays a refusal.
        if ((await askPermission()).type !== "granted") return;
      }
      const device = await Notifications.getDevicePushTokenAsync();
      token = kinPushToken(phone, device.data);
    }
    const generation = appAtomRegistry.get(
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
    );
    const key = `${environmentId}\u0000${generation}\u0000${token}`;
    if (registered === key) return;
    registered = key;
    const current = token;
    const orgs = host.orgs.me
      .map(({ orgId, personId }) => ({ environmentId, orgId, personId, token: current }))
      .filter((target) => !refusals.isRefused(target));
    const results = await Promise.all(
      orgs.map(async (target) => {
        // A host being forgotten gets no new registration; one already sent lands first.
        if (!pushFence.allows(environmentId)) return false;
        const sent = runAtomCommand(appAtomRegistry, kinClient.registerPush, {
          environmentId,
          input: kinPushRegisterInput({
            os: phone,
            orgId: target.orgId,
            token: current,
            sandbox,
          }),
        });
        pushFence.track(environmentId, sent);
        const result = await sent;
        if (result._tag === "Success") {
          registeredToken = current;
          return true;
        }
        const failure = squashAtomCommandFailure(result);
        if (refusals.note(target, failure)) {
          console.warn("Kin push: this device is registered to someone else", target.orgId);
        }
        return refusals.isRefused(target);
      }),
    );
    // A failed org retries on the next host change instead of waiting for a new session.
    if (results.includes(false) && registered === key) {
      registered = null;
    }
  };
  const run = (ask = false) => {
    void sync(ask).catch((cause: unknown) => console.warn("Kin push registration failed", cause));
  };

  syncRegistration = run;
  const unsubscribeHost = appAtomRegistry.subscribe(kinHostAtom, () => run(), { immediate: true });
  const tokenSubscription = Notifications.addPushTokenListener((next) => {
    if (typeof next.data !== "string") return;
    token = kinPushToken(phone, next.data);
    run();
  });
  return () => {
    syncRegistration = null;
    unsubscribeHost();
    tokenSubscription.remove();
  };
}

/** Kin's buttons, channels, taps and push token. Installed before the agent router, which clears the cold-start response. */
export function installKinNotifications(navigate: (href: string) => void): () => void {
  createChannels();
  registerCategories();
  const delivery = createActionDelivery();
  const handled = new Set<string>();
  const handleResponse = (response: Notifications.NotificationResponse) => {
    const route = kinNotificationRoute(response);
    if (route === null || handled.has(route.responseKey)) return;
    handled.add(route.responseKey);
    for (const path of route.paths) navigate(path);
    if (route.act !== null) delivery.post(route.environmentId, route.act);
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
  try {
    const coldStart = Notifications.getLastNotificationResponse();
    if (coldStart !== null) handleResponse(coldStart);
  } catch (cause) {
    // A build without the native module throws here; that must not stop the app's other services.
    console.warn("Reading the Kin cold-start notification failed", cause);
  }
  const disposeRegistration = createTokenRegistration();
  // A replaced approval key whose host didn't answer is asked again when that host connects.
  const disposeKeyCleanup = startApproverKeyCleanup();

  return () => {
    subscription.remove();
    delivery.dispose();
    disposeRegistration();
    disposeKeyCleanup();
  };
}
