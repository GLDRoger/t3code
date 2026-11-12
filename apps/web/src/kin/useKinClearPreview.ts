import type { EnvironmentId, KinChatId } from "@t3tools/contracts";
import { KIN_CLEAR_CHAT_DONE, kinClearChatKept } from "@t3tools/client-runtime/kin/kinClearChat";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { toastManager } from "../components/ui/toast";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";

/** What clearing this chat would leave, asked as its confirm opens. */
export function useKinClearPreview(environmentId: EnvironmentId, chatId: KinChatId) {
  const preview = useAtomCommand(kinClient.clearPreview, { reportFailure: false });
  const [kept, setKept] = useState<number | undefined>(undefined);
  const ask = () => {
    setKept(undefined);
    void preview({ environmentId, input: { chatId, preview: true } }).then((result) => {
      if (AsyncResult.isSuccess(result)) setKept(result.value.keptFiles);
    });
  };
  return { kept, ask };
}

/** After a clear: the files a doc kept, if any. The emptied chat says the rest. */
export function announceKinClearKept(keptFiles: number | undefined) {
  const kept = kinClearChatKept(keptFiles);
  if (kept !== null)
    toastManager.add({ type: "success", title: KIN_CLEAR_CHAT_DONE, description: kept });
}
