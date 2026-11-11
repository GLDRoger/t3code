import type { EnvironmentId } from "@t3tools/contracts";

import * as Dialog from "../../../components/ui/Dialog";
import { KIN_ONLY } from "../../../lib/kinOnly";
import { kinThreadWebUrl } from "../../../lib/kinOnlyRoutes";
import { tryOpenExternalUrl } from "../../../lib/openExternalUrl";
import { appAtomRegistry } from "../../../state/atom-registry";
import { projectEnvironmentPresentation } from "../../../state/environments";
import { environmentPresentations } from "../../../state/presentation";
import { useOpenWorkspaceDetail } from "../../layout/useOpenWorkspaceDetail";
import { KIN_THREAD_ELSEWHERE } from "../kinOnlyCopy";

type KinThread = { readonly environmentId: string; readonly threadId: string };

const elsewhere = () => Dialog.alert(KIN_THREAD_ELSEWHERE.title, KIN_THREAD_ELSEWHERE.detail);

/**
 * Opens the coding thread behind a task. A Kin-only app has no thread screen, so it opens the
 * thread in the browser, on the web app of the computer this phone is paired with; a connection
 * with no address a browser can open says where the thread lives instead.
 */
export function useOpenKinThread(): (thread: KinThread) => void {
  const openDetail = useOpenWorkspaceDetail();
  return (thread) => {
    if (!KIN_ONLY) return openDetail({ name: "Thread", params: thread });
    const presentation = appAtomRegistry
      .get(environmentPresentations.presentationsAtom)
      .get(thread.environmentId as EnvironmentId);
    const url = kinThreadWebUrl(
      presentation === undefined
        ? null
        : projectEnvironmentPresentation(thread.environmentId as EnvironmentId, presentation)
            .displayUrl,
      thread,
    );
    if (url === null) return elsewhere();
    void tryOpenExternalUrl(url, "kin-thread").then((opened) => {
      if (!opened) elsewhere();
    });
  };
}
