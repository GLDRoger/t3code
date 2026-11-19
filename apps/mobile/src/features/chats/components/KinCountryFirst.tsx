import { useNavigation } from "@react-navigation/native";
import { KIN_MONEY } from "@t3tools/client-runtime/kin/kinMoney";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { useKinIsOwnerLevel } from "../state/kinChatOnly";
import { useKinCountryNeeded } from "../state/useKinMoney";
import type { KinWorkTarget } from "../state/useKinWork";

/** Opens Company details; Back returns here with the form as it was. */
export function KinChooseCountry(props: {
  readonly target: KinWorkTarget;
  readonly inForm?: boolean;
}) {
  const navigation = useNavigation();
  return (
    <Button
      tone={props.inForm === true ? "outline" : "primary"}
      {...(props.inForm === true ? { size: "compact" as const } : {})}
      label={KIN_MONEY.chooseCountry}
      onPress={() =>
        navigation.navigate("KinCompany", {
          environmentId: String(props.target.environmentId),
          orgId: String(props.target.orgId),
        })
      }
    />
  );
}

/** An amount's field in a form, or Money's step in its place while the country isn't chosen. */
export function KinCountryFirstField(props: {
  readonly target: KinWorkTarget;
  readonly label: string;
  /** False while the field takes no amount, such as a count goal's target. */
  readonly money?: boolean;
  readonly children: React.ReactNode;
}) {
  const needed = useKinCountryNeeded(props.target);
  const ownerLevel = useKinIsOwnerLevel(props.target.environmentId);
  if (!needed || props.money === false) return props.children;
  return (
    <View className="items-start gap-2 px-4 py-3">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text className="text-sm text-foreground">
        {ownerLevel ? KIN_MONEY.countryFirst.detail : KIN_MONEY.countryFirstMember.detail}
      </Text>
      {ownerLevel ? <KinChooseCountry target={props.target} inForm /> : null}
    </View>
  );
}
