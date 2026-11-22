import { KIN_DOCS } from "@t3tools/client-runtime/kin/kinDocs";

import { toastManager } from "../components/ui/toast";

/** Says a restore went through, or why not. */
export const toastDocRestored = (title: string, why: string | null) =>
  toastManager.add(
    why === null
      ? { type: "success", title: KIN_DOCS.restoredDoc(title) }
      : { type: "error", title: why },
  );

/** "Deleted <title>" with Undo, which brings it back. */
export const toastDocDeleted = (title: string, undo: () => Promise<string | null>) => {
  const toast = toastManager.add({
    type: "success",
    timeout: 10_000,
    title: KIN_DOCS.deletedNotice(title),
    actionProps: {
      children: KIN_DOCS.undo,
      onClick: () => {
        toastManager.close(toast);
        void undo().then((why) => toastDocRestored(title, why));
      },
    },
  });
};
