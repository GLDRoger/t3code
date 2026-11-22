import { useAtomValue } from "@effect/atom-react";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_WATCH_COPY,
  KIN_WATCH_LOG_TITLE,
  kinWatchLine,
  type KinWatchAction,
} from "@t3tools/client-runtime/kin/kinWatches";
import type { KinRecordKey } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { EyeIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { openKinSettings } from "./kinSettingsAddress";
import { useNowMinuteMs } from "./useKinClock";
import type { KinWorkTarget } from "./useKinWork";

/** Settings' page for What Kin checked. */
export const KIN_WATCH_LOG_PAGE = "watches";

/**
 * The one quiet line on a record Kin watches, in `kinWatchLine`'s words, with the buttons this
 * person may use and a way into What Kin checked. A record with no watch shows nothing.
 */
export function KinWatchLine(
  props: KinWorkTarget & {
    readonly recordKey: KinRecordKey;
    /** Layout only: where the line sits among its page's header lines. */
    readonly className?: string;
  },
) {
  const { environmentId, orgId, recordKey } = props;
  const router = useRouter();
  const query = { environmentId, input: { orgId, recordKey } };
  const watchesAtom = kinClient.watches(query);
  const watch = Option.getOrNull(AsyncResult.value(useAtomValue(watchesAtom)))?.watches[0];
  const now = useNowMinuteMs();
  const may: Record<KinWatchAction, boolean> = {
    look: useAtomValue(kinClient.watchLook.permissionAtom(environmentId)),
    stop: useAtomValue(kinClient.watchStop.permissionAtom(environmentId)),
    again: useAtomValue(kinClient.watchAgain.permissionAtom(environmentId)),
  };
  const commands = {
    look: useAtomCommand(kinClient.watchLook, { reportFailure: false }),
    stop: useAtomCommand(kinClient.watchStop, { reportFailure: false }),
    again: useAtomCommand(kinClient.watchAgain, { reportFailure: false }),
  };
  const [busy, setBusy] = useState<KinWatchAction | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const view = watch === undefined ? null : kinWatchLine(watch, now);
  if (watch === undefined || view === null) return null;

  const act = async (action: KinWatchAction) => {
    if (busy !== null) return;
    setBusy(action);
    setProblem(null);
    const result = await commands[action]({
      environmentId,
      input: { orgId, watchId: watch.watchId },
    });
    setBusy(null);
    if (!AsyncResult.isSuccess(result))
      setProblem(kinFailureText(squashAtomCommandFailure(result), KIN_WATCH_COPY.failed[action]));
    appAtomRegistry.refresh(watchesAtom);
  };
  const actions = view.actions.filter((action) => may[action]);

  return (
    <div
      data-slot="kin-watch-line"
      className={`flex items-start gap-1.5 text-xs text-muted-foreground ${props.className ?? ""}`}
    >
      <EyeIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      <div className="flex min-w-0 flex-col items-start gap-0.5">
        <p className="text-pretty wrap-break-word">{view.text}</p>
        <div className="-ms-2 flex flex-wrap items-center">
          {actions.map((action) => (
            <Button
              key={action}
              size="xs"
              variant="ghost"
              disabled={busy !== null}
              aria-busy={busy === action || undefined}
              onClick={() => void act(action)}
            >
              {KIN_WATCH_COPY[action]}
            </Button>
          ))}
          <Button
            size="xs"
            variant="ghost-muted"
            onClick={() => openKinSettings(router.history, KIN_WATCH_LOG_PAGE)}
          >
            {KIN_WATCH_LOG_TITLE}
          </Button>
        </div>
        {problem === null ? null : (
          <p role="alert" className="text-destructive-foreground">
            {problem}
          </p>
        )}
      </div>
    </div>
  );
}
