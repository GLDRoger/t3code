import { StackActions, useNavigation } from "@react-navigation/native";
import {
  KIN_BILLS,
  kinBillCardButtons,
  type KinBillBatchCardView,
} from "@t3tools/client-runtime/kin/kinBills";
import type { EnvironmentId } from "@t3tools/contracts";
import { memo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { useKinBillCardKeep } from "../state/useKinBills";

/**
 * Bills added in chat: the host's sentence, its totals by currency and the bills that need the
 * person by name; Keep keeps exactly the clean set the card shows, and Review opens the batch.
 */
export const KinBillBatchCard = memo(function KinBillBatchCard(props: {
  readonly bills: KinBillBatchCardView;
  readonly environmentId: EnvironmentId;
  /** The owner or a co-owner, who reviews and keeps bills; unknown offers both. */
  readonly ownerLevel: boolean;
}) {
  const navigation = useNavigation();
  const { bills } = props;
  const keep = useKinBillCardKeep(props.environmentId, bills);
  const buttons = kinBillCardButtons(bills, {
    ownerLevel: props.ownerLevel,
    canKeep: keep.allowed,
  });
  const said = [bills.text, ...bills.totals, ...bills.needs, bills.needsMore].filter(
    (line) => line !== null,
  );
  return (
    <View className="gap-3 rounded-[20px] border border-border bg-card-alt p-4">
      {/* Only the words are one element: an accessible card would hide its buttons from VoiceOver. */}
      <View
        accessible
        accessibilityLabel={`${KIN_BILLS.added}: ${said.join(" ")}`}
        className="gap-2"
      >
        <View className="flex-row items-baseline justify-between gap-3">
          <Text textRole="caption" className="font-t3-medium text-foreground-muted">
            {KIN_BILLS.added}
          </Text>
          {bills.progress === null ? null : (
            <Text textRole="caption" className="text-foreground-muted">
              {bills.progress}
            </Text>
          )}
        </View>
        <Text textRole="body" className="text-foreground">
          {bills.text}
        </Text>
        {bills.totals.map((line) => (
          <Text key={line} textRole="footnote" className="text-foreground">
            {line}
          </Text>
        ))}
        {bills.needs.length === 0 && bills.needsMore === null ? null : (
          <View className="gap-0.5">
            {bills.needs.map((line) => (
              <Text key={line} textRole="footnote" className="text-foreground-muted">
                {line}
              </Text>
            ))}
            {bills.needsMore === null ? null : (
              <Text textRole="footnote" className="text-foreground-muted">
                {bills.needsMore}
              </Text>
            )}
          </View>
        )}
      </View>
      {buttons.keep === null && !buttons.review ? null : (
        <View className="gap-2">
          {buttons.keep === null ? null : (
            <Button
              tone="primary"
              label={buttons.keep}
              loading={keep.busy}
              disabled={keep.stale}
              onPress={() => void keep.keep()}
            />
          )}
          {buttons.keep === null || keep.problem === null ? null : (
            <Text
              textRole="footnote"
              accessibilityLiveRegion="polite"
              className="text-danger-foreground"
            >
              {keep.problem}
            </Text>
          )}
          {buttons.review ? (
            <Button
              tone="secondary"
              label={KIN_BILLS.review}
              onPress={() =>
                navigation.dispatch(
                  StackActions.push("KinBills", {
                    environmentId: String(props.environmentId),
                    orgId: String(bills.orgId),
                    batch: bills.batchId,
                  }),
                )
              }
            />
          ) : null}
        </View>
      )}
    </View>
  );
});
