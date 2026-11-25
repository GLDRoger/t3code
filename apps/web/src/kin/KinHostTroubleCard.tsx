import { useAtomValue } from "@effect/atom-react";
import {
  KIN_HOST_COPY,
  kinBackUpLine,
  kinFreeSpaceLine,
  kinHostFailed,
  kinHostTroubleCardView,
  kinHostWhen,
  kinRetryLine,
  type KinTroubleActionView,
} from "@t3tools/client-runtime/kin/kinHostCare";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ProviderInstanceId,
  type EnvironmentId,
  type KinOrgId,
  type KinTroubleAction,
  type KinWidget,
} from "@t3tools/contracts";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { memo, useState } from "react";

import { Button } from "../components/ui/button";
import { isChatOnlySession } from "../environments/primary";
import { namedClipboardTarget, useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { useAtomCommand } from "../state/use-atom-command";
import { CardFrame } from "./KinCards";
import { kinClient, refreshKinHost } from "./kinClient";
import { withKinAgentPage } from "./kinPlaces";
import { openKinSettings } from "./kinSettingsAddress";
import { useNowMinuteMs } from "./useKinClock";

export type KinHostTapDone = { readonly line: string; readonly failed: boolean } | null;
type Done = KinHostTapDone;

/**
 * One cause's notice in the owner's chat: what Kin is doing, the count, and the taps that fix it.
 * The message above says what is wrong. Every tap is a fixed operation or a place to open.
 */
export const KinHostTroubleCard = memo(function KinHostTroubleCard(props: {
  readonly widget: Pick<KinWidget, "type" | "state" | "orgId">;
  readonly environmentId: EnvironmentId;
  /** Settings keeps a tap's result line itself: the card goes away when its trouble closes. */
  readonly onDone?: (done: KinHostTapDone) => void;
}) {
  const { widget, environmentId, onDone } = props;
  const now = useNowMinuteMs();
  const view = kinHostTroubleCardView(widget, kinHostWhen(now));
  const router = useRouter();
  const navigate = useNavigate();
  const canAct = useAtomValue(kinClient.hostFreeSpace.permissionAtom(environmentId));
  const freeSpace = useAtomCommand(kinClient.hostFreeSpace, { reportFailure: false });
  const backUp = useAtomCommand(kinClient.hostBackUpNow, { reportFailure: false });
  const retry = useAtomCommand(kinClient.hostRetry, { reportFailure: false });
  const { copyToClipboard, isCopied } = useCopyToClipboard({
    target: namedClipboardTarget(KIN_HOST_COPY.details),
  });
  const [busy, setBusy] = useState<KinTroubleAction | null>(null);
  const [done, setDone] = useState<Done>(null);
  if (view === null) return null;

  const orgId: KinOrgId = widget.orgId;
  const query = { environmentId, input: { orgId } };
  const run = async <A,>(
    action: KinTroubleAction,
    command: () => Promise<AsyncResult.AsyncResult<A, unknown>>,
    line: (value: A) => string,
  ) => {
    if (busy !== null) return;
    setBusy(action);
    setDone(null);
    onDone?.(null);
    const result = await command();
    setBusy(null);
    refreshKinHost(environmentId, orgId);
    const next = AsyncResult.isSuccess(result)
      ? { line: line(result.value), failed: false }
      : {
          line: kinHostFailed(
            AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
          ),
          failed: true,
        };
    if (onDone === undefined) setDone(next);
    else onDone(next);
  };
  const tap = (action: KinTroubleAction) => {
    switch (action) {
      case "free_space":
        return void run(action, () => freeSpace(query), kinFreeSpaceLine);
      case "retry":
        return void run(action, () => retry(query), kinRetryLine);
      case "back_up":
        return void run(action, () => backUp(query), kinBackUpLine);
      case "sign_in":
        return void navigate({
          to: "/settings/providers",
          search: {
            environmentId,
            ...(view.instanceId === null
              ? {}
              : { instanceId: ProviderInstanceId.make(view.instanceId) }),
          },
        });
      case "open_agent":
        return view.agentId === null
          ? undefined
          : void navigate({
              to: ".",
              search: (prev) => withKinAgentPage(prev, view.agentId!),
            });
      case "open_daily_limit":
        return openKinSettings(router.history, "company", undefined, "kin-daily-limit");
      case "open_connection":
        return openKinSettings(router.history, "connections");
      case "copy_details":
        return view.detail === null ? undefined : copyToClipboard(view.detail, undefined);
    }
  };
  // Signing in an AI account is the app's own settings, on a session that can open them;
  // elsewhere the card says where it is done instead.
  const chatOnly = isChatOnlySession();
  const shown = (action: KinTroubleActionView) => action.action !== "sign_in" || !chatOnly;
  const actions = canAct ? view.actions.filter(shown) : [];
  const elsewhere = chatOnly ? view.signInElsewhere : null;
  const busyLabel: Partial<Record<KinTroubleAction, string>> = {
    free_space: KIN_HOST_COPY.freeing,
    retry: KIN_HOST_COPY.retrying,
    back_up: KIN_HOST_COPY.backingUp,
  };

  return (
    <CardFrame eyebrow={view.title} label={view.accessibilityLabel}>
      <p className={view.closed ? "text-muted-foreground" : "text-foreground"}>{view.what}</p>
      {view.line === null ? null : (
        <p className={view.closed ? "font-medium text-foreground" : "text-muted-foreground"}>
          {view.line}
        </p>
      )}
      {elsewhere === null ? null : <p className="text-foreground">{elsewhere}</p>}
      {view.detail === null ? null : (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">{KIN_HOST_COPY.details}</summary>
          <p className="mt-1 break-words font-mono">{view.detail}</p>
        </details>
      )}
      {/* Once the trouble closes, the card's own line says how it ended. */}
      {done === null || view.closed ? null : (
        <p
          role={done.failed ? "alert" : "status"}
          className={
            done.failed
              ? "text-xs font-medium text-destructive-foreground"
              : "text-xs text-muted-foreground"
          }
        >
          {done.line}
        </p>
      )}
      {actions.length === 0 ? null : (
        <div className="flex flex-wrap gap-2">
          {actions.map((action, index) => (
            <Button
              key={action.action}
              size="sm"
              variant={index === 0 ? "default" : "outline"}
              disabled={busy !== null}
              onClick={() => tap(action.action)}
            >
              {busy === action.action
                ? (busyLabel[action.action] ?? action.label)
                : action.action === "copy_details" && isCopied
                  ? KIN_HOST_COPY.copied
                  : action.label}
            </Button>
          ))}
        </div>
      )}
    </CardFrame>
  );
});
