import { StackActions, useNavigation } from "@react-navigation/native";
import { KIN_BILLS, type KinBillBatchCardView } from "@t3tools/client-runtime/kin/kinBills";
import { memo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";

/**
 * Bills added in bulk, in chat: the host's own sentence and, while Kin reads, how far it got;
 * once done, Review opens the batch's list. Nothing is kept from the card itself.
 */
export const KinBillBatchCard = memo(function KinBillBatchCard(props: {
  readonly bills: KinBillBatchCardView;
  readonly environmentId: string;
  /** The owner or a co-owner, who reviews bills; unknown offers Review. */
  readonly ownerLevel: boolean;
}) {
  const navigation = useNavigation();
  const { bills } = props;
  return (
    <View className="gap-2 rounded-[20px] border border-border bg-card-alt p-4">
      {/* Only the words are one element: an accessible card would hide Review from VoiceOver. */}
      <View
        accessible
        accessibilityLabel={`${KIN_BILLS.added}: ${bills.text}`}
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
      </View>
      {bills.reading || !props.ownerLevel ? null : (
        <Button
          size="compact"
          tone="secondary"
          label={KIN_BILLS.review}
          onPress={() =>
            navigation.dispatch(
              StackActions.push("KinBills", {
                environmentId: props.environmentId,
                orgId: String(bills.orgId),
                batch: bills.batchId,
              }),
            )
          }
        />
      )}
    </View>
  );
});
