import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { memo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import {
  kinMemoryUndoFailureText,
  type KinMemoryChangeItemView,
  type KinMemoryChangesCardView,
} from "./kinMemoryChangesPresentation";

/** What the lead changed in memory in one wake-up, each line with Undo (`kin.memory.undo`). */
export const KinMemoryChangesCard = memo(function KinMemoryChangesCard(props: {
  readonly changes: KinMemoryChangesCardView;
  readonly environmentId: EnvironmentId;
}) {
  const { changes, environmentId } = props;
  const canUndo = useAtomValue(kinClient.memoryUndo.permissionAtom(environmentId));
  const send = useAtomCommand(kinClient.memoryUndo, { reportFailure: false });
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ readonly itemId: string; readonly text: string } | null>(
    null,
  );

  const undo = async (item: KinMemoryChangeItemView) => {
    if (pending !== null) return;
    setPending(item.itemId);
    setFailed(null);
    const result = await send({
      environmentId,
      input: { orgId: changes.orgId, widgetId: changes.widgetId, itemId: item.itemId },
    });
    setPending(null);
    if (AsyncResult.isFailure(result))
      setFailed({
        itemId: item.itemId,
        text: kinMemoryUndoFailureText(squashAtomCommandFailure(result)),
      });
  };

  return (
    <View className="gap-1 rounded-[20px] border border-border bg-card-alt px-4 py-2">
      {changes.items.map((item) => {
        const failure = failed?.itemId === item.itemId ? failed.text : null;
        return (
          <View key={item.itemId} className="gap-0.5 py-1">
            <View className="flex-row items-center gap-2">
              <View
                accessible
                accessibilityLabel={item.accessibilityLabel}
                className="min-w-0 flex-1"
              >
                <Text
                  textRole="footnote"
                  className={item.undo === "undone" ? "text-foreground-muted" : "text-foreground"}
                >
                  {item.line}
                </Text>
              </View>
              {item.undo === "undone" ? (
                <Text textRole="caption" className="font-t3-medium text-foreground-muted">
                  Undone
                </Text>
              ) : item.undo === "stale" ? (
                <Text textRole="caption" className="font-t3-medium text-warning-foreground">
                  Changed since
                </Text>
              ) : canUndo ? (
                <Button
                  size="compact"
                  tone="text"
                  label={failure === null ? "Undo" : "Try again"}
                  accessibilityLabel={`Undo: ${item.line}`}
                  loading={pending === item.itemId}
                  disabled={pending !== null && pending !== item.itemId}
                  onPress={() => void undo(item)}
                />
              ) : null}
            </View>
            {failure === null ? null : (
              <Text
                accessibilityRole="alert"
                accessibilityLiveRegion="polite"
                textRole="caption"
                className="font-t3-medium text-danger-foreground"
              >
                {failure}
              </Text>
            )}
          </View>
        );
      })}
      {changes.more === null ? null : (
        <Text textRole="caption" className="pb-1 text-foreground-muted">
          {changes.more}
        </Text>
      )}
    </View>
  );
});
