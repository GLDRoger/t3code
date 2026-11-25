import { CommonActions } from "@react-navigation/native";
import * as Linking from "expo-linking";
import { Alert, Platform } from "react-native";

import { rootNavigationRef, whenRootNavigationReady } from "../../lib/rootNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { kinSharedFileLanding, type KinSharedFileLanding } from "./state/kinSharedFile";
import { kinHostAtom } from "./state/useKinHost";

const KIN_SHARED_FILE_NO_KIN =
  "Connect this phone to your company's Kin, then share the file again.";

/** iOS copies a file opened in Kin into Documents/Inbox; that copy is Kin's to remove. */
const isSystemCopy = (uri: string) => uri.startsWith("file:") && uri.includes("/Documents/Inbox/");

/** Removes the system's copy of a shared file once its import finishes or is left. */
export async function forgetKinSharedFile(uri: string): Promise<void> {
  if (!isSystemCopy(uri)) return;
  try {
    const { File } = await import("expo-file-system");
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (cause) {
    console.warn("Removing a file shared into Kin failed", cause);
  }
}

/** Copies left by an app closed mid-import, all but the one this launch opens. */
async function clearSystemCopies(keep: string | null) {
  if (Platform.OS !== "ios") return;
  try {
    const { Directory, Paths } = await import("expo-file-system");
    const inbox = new Directory(Paths.document, "Inbox");
    if (!inbox.exists) return;
    for (const entry of inbox.list()) if (entry.uri !== keep) entry.delete();
  } catch (cause) {
    console.warn("Clearing files shared into Kin failed", cause);
  }
}

async function stillThere(uri: string) {
  if (!uri.startsWith("file:")) return true;
  const { File } = await import("expo-file-system");
  return new File(uri).exists;
}

/**
 * Opens a shared file on its import screen once Kin knows its host. With no Kin or no company
 * here, says so and keeps nothing.
 */
function land(landing: KinSharedFileLanding): () => void {
  let settled = false;
  const unsubscribe = appAtomRegistry.subscribe(
    kinHostAtom,
    (host) => {
      if (settled || host._tag === "searching") return;
      if (host._tag === "host" && host.probe._tag === "pending") return;
      settled = true;
      // The first answer can come before `subscribe` returns.
      void Promise.resolve().then(() => unsubscribe());
      const org =
        host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs.orgs[0] : undefined;
      if (host._tag !== "host" || org === undefined) {
        Alert.alert(KIN_SHARED_FILE_NO_KIN);
        void forgetKinSharedFile(landing.file.uri);
        return;
      }
      whenRootNavigationReady(() =>
        rootNavigationRef.dispatch(
          CommonActions.navigate(landing.screen, {
            environmentId: String(host.environmentId),
            orgId: String(org.orgId),
            file: landing.file.uri,
            fileName: landing.file.name,
            fileType: landing.file.mimeType,
          }),
        ),
      );
    },
    { immediate: true },
  );
  return unsubscribe;
}

/** Android's SEND arrives as `<scheme>://expo-sharing` with the file in expo-sharing's payloads. */
async function sharedOnAndroid() {
  const { clearSharedPayloads, getSharedPayloads } = await import("expo-sharing");
  const payload = getSharedPayloads().find(
    (one) => one.shareType !== "text" && one.shareType !== "url",
  );
  clearSharedPayloads();
  return payload === undefined
    ? null
    : kinSharedFileLanding({
        uri: payload.value,
        name: payload.originalName,
        mimeType: payload.mimeType,
      });
}

/** Files shared into Kin from another app: iOS's "Open in Kin", Android's Share and Open with. */
export function startKinSharedFileInbox(): () => void {
  const waits = new Set<() => void>();
  let stopped = false;
  const take = async (url: string | null) => {
    if (url === null) return;
    const landing = url.includes("://expo-sharing")
      ? await sharedOnAndroid()
      : kinSharedFileLanding({ uri: url });
    // A reload reads the launch link again; its file is gone once its import ended.
    if (landing === null || stopped || !(await stillThere(landing.file.uri))) return;
    waits.add(land(landing));
  };
  void Linking.getInitialURL().then(async (url) => {
    await clearSystemCopies(url);
    await take(url);
  });
  const subscription = Linking.addEventListener("url", (event) => void take(event.url));
  return () => {
    stopped = true;
    subscription.remove();
    for (const stop of waits) stop();
  };
}
