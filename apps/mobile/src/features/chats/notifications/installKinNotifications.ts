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
import { Platform } from "react-native";

import { connectionAtomRuntime } from "../../../connection/runtime";
import { appAtomRegistry } from "../../../state/atom-registry";
import { environmentPresentations } from "../../../state/presentation";
import { requestAgentNotificationPermission } from "../../agent-awareness/notificationPermissions";
import { resolveApsEnvironment } from "../../agent-awareness/registrationPayload";
import { kinClient } from "../state/kinClient";
import { kinHostAtom } from "../state/useKinHost";
import { KIN_NOTIFICATION_CATEGORIES } from "./kinCategories";
import { kinNotificationRoute } from "./kinPushPayload";

// A refusal is final for this response; anything else (a dropped socket) waits for a connect.
const isFinalRefusal = Schema.is(Schema.Union([KinChatError, EnvironmentAuthorizationError]));

function registerCategories(): void {
  for (const [identifier, actions] of Object.entries(KIN_NOTIFICATION_CATEGORIES)) {
    if (actions.length === 0) continue;
    void Notifications.setNotificationCategoryAsync(
      identifier,
      actions.map((action) => ({ ...action, options: { ...action.options } })),
    ).catch((cause: unknown) => console.warn(`Registering ${identifier} failed`, cause));
  }
}

const isConnected = (environmentId: EnvironmentId) =>
  appAtomRegistry.get(environmentPresentations.presentationsAtom).get(environmentId)?.connection
    .phase === "connected";

/** Button taps post once the host is connected, which on a cold start is after launch. */
function createActionDelivery() {
  const pending = new Map<string, { environmentId: EnvironmentId; input: KinWidgetsActInput }>();
  const inFlight = new Set<string>();
  const flush = () => {
    for (const [key, target] of pending) {
      if (inFlight.has(key) || !isConnected(target.environmentId)) continue;
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
        }
      });
    }
  };
  const unsubscribe = appAtomRegistry.subscribe(environmentPresentations.presentationsAtom, flush);
  return {
    post: (environmentId: EnvironmentId, input: KinWidgetsActInput) => {
      pending.set(input.clientActionId, { environmentId, input });
      flush();
    },
    dispose: unsubscribe,
  };
}

/** Registers the APNs token with the Kin host on every connect, for each org the viewer is in. */
function createTokenRegistration() {
  if (Platform.OS !== "ios") return () => {};
  let registered: string | null = null;
  let token: string | null = null;
  let permissionAsked = false;
  const apsEnvironment =
    resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant) === "sandbox"
      ? "development"
      : "production";

  const sync = async () => {
    const host = appAtomRegistry.get(kinHostAtom);
    if (host._tag !== "host" || !host.connected || host.probe._tag !== "ready") return;
    const { environmentId } = host;
    if (token === null) {
      if (permissionAsked) return;
      permissionAsked = true;
      // The shared prompt: the OS shows it at most once, and a refusal stays a refusal.
      const permission = await Effect.runPromise(
        requestAgentNotificationPermission.pipe(
          Effect.orElseSucceed(() => ({ type: "unsupported" }) as const),
        ),
      );
      if (permission.type !== "granted") return;
      const device = await Notifications.getDevicePushTokenAsync().catch((cause: unknown) => {
        permissionAsked = false;
        throw cause;
      });
      token = String(device.data).toLowerCase();
    }
    const generation = appAtomRegistry.get(
      environmentSessionGenerationAtom(connectionAtomRuntime, environmentId),
    );
    const key = `${environmentId}\u0000${generation}\u0000${token}`;
    if (registered === key) return;
    registered = key;
    for (const { orgId } of host.probe.orgs.me) {
      void runAtomCommand(appAtomRegistry, kinClient.registerPush, {
        environmentId,
        input: { orgId, token, platform: "ios", apsEnvironment },
      });
    }
  };
  const run = () => {
    void sync().catch((cause: unknown) => console.warn("Kin push registration failed", cause));
  };

  const unsubscribeHost = appAtomRegistry.subscribe(kinHostAtom, run, { immediate: true });
  const tokenSubscription = Notifications.addPushTokenListener((next) => {
    if (typeof next.data !== "string") return;
    token = next.data.toLowerCase();
    run();
  });
  return () => {
    unsubscribeHost();
    tokenSubscription.remove();
  };
}

/**
 * Kin's buttons, taps and APNs token. Install it before the agent notification router: that
 * one clears the cold-start response, and this one reads it synchronously first.
 */
export function installKinNotifications(navigate: (href: string) => void): () => void {
  registerCategories();
  const delivery = createActionDelivery();
  const handled = new Set<string>();
  const handleResponse = (response: Notifications.NotificationResponse) => {
    const route = kinNotificationRoute(response);
    if (route === null || handled.has(route.responseKey)) return;
    handled.add(route.responseKey);
    navigate(route.path);
    if (route.act !== null) delivery.post(route.environmentId, route.act);
  };
  const subscription = Notifications.addNotificationResponseReceivedListener(handleResponse);
  const coldStart = Notifications.getLastNotificationResponse();
  if (coldStart !== null) handleResponse(coldStart);
  const disposeRegistration = createTokenRegistration();

  return () => {
    subscription.remove();
    delivery.dispose();
    disposeRegistration();
  };
}
