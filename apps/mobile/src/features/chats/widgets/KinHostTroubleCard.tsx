import { useAtomValue } from "@effect/atom-react";
import {
  KIN_HOST_COPY,
  kinBackUpLine,
  kinFreeSpaceLine,
  kinHostFailed,
  kinHostTroubleCardView,
  kinHostWhen,
  kinRetryLine,
} from "@t3tools/client-runtime/kin/kinHostCare";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, KinTroubleAction, KinWidget } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { AsyncResult } from "effect/reactivity";
import { memo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { useNowMinuteMs } from "../../../lib/clock";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient, refreshKinHost } from "../state/kinClient";

// The phone runs Kin's fixed operations; signing in, limits and connections are set up on the computer.
const ON_PHONE: ReadonlySet<KinTroubleAction> = new Set([
  "free_space",
  "retry",
  "back_up",
  "copy_details",
]);

/** One cause's notice in the owner's chat, on the phone: the same words and taps as on web. */
export const KinHostTroubleCard = memo(function KinHostTroubleCard(props: {
  readonly widget: KinWidget;
  readonly environmentId: EnvironmentId;
}) {
  const { widget, environmentId } = props;
  const now = useNowMinuteMs();
  const view = kinHostTroubleCardView(widget, kinHostWhen(now));
  const canAct = useAtomValue(kinClient.hostFreeSpace.permissionAtom(environmentId));
  const freeSpace = useAtomCommand(kinClient.hostFreeSpace, { reportFailure: false });
  const backUp = useAtomCommand(kinClient.hostBackUpNow, { reportFailure: false });
  const retry = useAtomCommand(kinClient.hostRetry, { reportFailure: false });
  const [busy, setBusy] = useState<KinTroubleAction | null>(null);
  const [done, setDone] = useState<{ readonly line: string; readonly failed: boolean } | null>(
    null,
  );
  if (view === null) return null;

  const query = { environmentId, input: { orgId: widget.orgId } };
  const run = async <A,>(
    action: KinTroubleAction,
    command: () => Promise<AsyncResult.AsyncResult<A, unknown>>,
    line: (value: A) => string,
  ) => {
    if (busy !== null) return;
    setBusy(action);
    setDone(null);
    const result = await command();
    setBusy(null);
    refreshKinHost(environmentId, widget.orgId);
    setDone(
      AsyncResult.isSuccess(result)
        ? { line: line(result.value), failed: false }
        : {
            line: kinHostFailed(
              AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
            ),
            failed: true,
          },
    );
  };
  const tap = (action: KinTroubleAction) => {
    if (action === "free_space") void run(action, () => freeSpace(query), kinFreeSpaceLine);
    else if (action === "retry") void run(action, () => retry(query), kinRetryLine);
    else if (action === "back_up") void run(action, () => backUp(query), kinBackUpLine);
    else if (action === "copy_details" && view.detail !== null) {
      void Clipboard.setStringAsync(view.detail);
      setDone({ line: KIN_HOST_COPY.copied, failed: false });
    }
  };
  const actions = canAct ? view.actions.filter((action) => ON_PHONE.has(action.action)) : [];

  return (
    <View
      accessibilityLabel={view.accessibilityLabel}
      className="gap-2 rounded-[20px] border border-border bg-card-alt px-4 py-3"
    >
      <Text textRole="caption" className="font-t3-medium text-foreground-muted">
        {view.title}
      </Text>
      <Text
        textRole="footnote"
        className={view.closed ? "text-foreground-muted" : "text-foreground"}
      >
        {view.what}
      </Text>
      {view.line === null ? null : (
        <Text
          textRole="footnote"
          className={view.closed ? "font-t3-medium text-foreground" : "text-foreground-muted"}
        >
          {view.line}
        </Text>
      )}
      {view.detail === null ? null : (
        <Text textRole="caption" selectable className="text-foreground-muted">
          {`${KIN_HOST_COPY.details}: ${view.detail}`}
        </Text>
      )}
      {done === null ? null : (
        <Text
          textRole="caption"
          accessibilityRole={done.failed ? "alert" : undefined}
          accessibilityLiveRegion="polite"
          className={
            done.failed ? "font-t3-medium text-danger-foreground" : "text-foreground-muted"
          }
        >
          {done.line}
        </Text>
      )}
      {actions.length === 0 ? null : (
        <View className="flex-row flex-wrap gap-2 pt-1">
          {actions.map((action, index) => (
            <Button
              key={action.action}
              size="compact"
              tone={index === 0 ? "primary" : "outline"}
              label={action.label}
              loading={busy === action.action}
              disabled={busy !== null}
              onPress={() => tap(action.action)}
            />
          ))}
        </View>
      )}
    </View>
  );
});
