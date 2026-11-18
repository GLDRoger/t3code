import { useAtomValue } from "@effect/atom-react";
import { KIN_AGENT_CHANGES } from "@t3tools/client-runtime/kin/kinAgentPage";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_TURN_RECEIPT_LABEL,
  kinTurnReceiptRows,
  kinTurnReceiptTarget,
  type KinTurnReceiptRow,
} from "@t3tools/client-runtime/kin/kinTurnReceipt";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { KinOrgId, type EnvironmentId, type KinMessage } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ListSection } from "../../../components/ui/ListSection";
import { RowPressable } from "../../../components/ui/RowPressable";
import { Sheet } from "../../../components/ui/Sheet";
import { useAtomCommand } from "../../../state/use-atom-command";
import { kinClient } from "../state/kinClient";
import { useKinOpenTarget } from "./KinMessagePage";

/** The changes one agent reply's turn made, each opening its entry, with Undo where Kin can. */
export function KinTurnReceiptSheet(props: {
  /** Read from the feed on every render, so a refreshed reply redraws the open sheet. */
  readonly message: KinMessage;
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly onClose: () => void;
}) {
  const { message, environmentId, onClose } = props;
  const orgId = KinOrgId.make(message.orgId);
  const openTarget = useKinOpenTarget(environmentId, message.orgId);
  const undo = useAtomCommand(kinClient.agentUndoChange, { reportFailure: false });
  const canUndo = useAtomValue(kinClient.agentUndoChange.permissionAtom(environmentId));
  const [busy, setBusy] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ readonly id: string; readonly text: string } | null>(
    null,
  );
  const { rows, more } = kinTurnReceiptRows(message.turnChanges);
  const run = async (row: KinTurnReceiptRow) => {
    setBusy(row.id);
    setRefused(null);
    const outcome = await undo({
      environmentId,
      input: { orgId, agentId: row.change.agentId, seq: row.change.seq },
    });
    setBusy(null);
    if (AsyncResult.isFailure(outcome))
      setRefused({
        id: row.id,
        text: kinFailureText(squashAtomCommandFailure(outcome), KIN_AGENT_CHANGES.failed),
      });
  };
  return (
    <Sheet variant="plain" title={KIN_TURN_RECEIPT_LABEL} onClose={onClose}>
      <View className="gap-4 px-4 pt-7 pb-10">
        <ListSection title={KIN_TURN_RECEIPT_LABEL}>
          {rows.map((row, index) => {
            const undone = row.undo === "undone";
            const what = undone ? `${row.what} · ${KIN_AGENT_CHANGES.undone}` : row.what;
            return (
              <View
                key={row.id}
                className={index === 0 ? undefined : "border-t border-border-subtle"}
              >
                <RowPressable
                  accessibilityRole="button"
                  accessibilityLabel={`${row.key}, ${row.title}, ${what}`}
                  onPress={() => {
                    onClose();
                    openTarget(kinTurnReceiptTarget(row, message.links));
                  }}
                  className="bg-grouped-card"
                >
                  <View className="min-w-0 gap-1 px-4 py-3">
                    <View className="min-w-0 flex-row gap-2">
                      <Text textRole="body" className="text-foreground-muted">
                        {row.key}
                      </Text>
                      <Text
                        textRole="body"
                        numberOfLines={1}
                        className="min-w-0 flex-1 text-foreground"
                      >
                        {row.title}
                      </Text>
                    </View>
                    <Text textRole="footnote" className="text-foreground-muted">
                      {what}
                    </Text>
                  </View>
                </RowPressable>
                {row.undo === "undo" && canUndo ? (
                  <View className="flex-row items-center gap-3 px-4 pb-3">
                    <Button
                      tone="outline"
                      size="compact"
                      label={busy === row.id ? KIN_AGENT_CHANGES.undoing : KIN_AGENT_CHANGES.undo}
                      accessibilityLabel={`${KIN_AGENT_CHANGES.undo} ${row.key}: ${row.what}`}
                      loading={busy === row.id}
                      disabled={busy !== null || !props.connected}
                      onPress={() => void run(row)}
                    />
                    {refused?.id === row.id ? (
                      <Text
                        textRole="footnote"
                        accessibilityLiveRegion="polite"
                        className="min-w-0 flex-1 text-foreground-muted"
                      >
                        {refused.text}
                      </Text>
                    ) : null}
                  </View>
                ) : null}
              </View>
            );
          })}
          {more === null ? null : (
            <View className="border-t border-border-subtle px-4 py-3">
              <Text textRole="footnote" className="text-foreground-muted">
                {more}
              </Text>
            </View>
          )}
        </ListSection>
      </View>
    </Sheet>
  );
}
