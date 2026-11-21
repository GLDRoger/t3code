import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import { View } from "react-native";

import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import {
  kinIntroSendsTo,
  KIN_INTRO_COUNTRY,
  KIN_INTRO_PROMPTS,
  KIN_INTRO_START_HINT,
} from "@t3tools/client-runtime/kin/kinIntro";
import { kinLeadIntroDetail } from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { useKinIsOwnerLevel } from "../state/kinChatOnly";
import { useKinCountryNeeded } from "../state/useKinMoney";

/**
 * First run in the owner's chat with their lead: what the lead is for and a few asks to start with.
 * Gone once the owner has sent anything (`kinIntroVisible`).
 */
export function KinIntro(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly agentName: string;
  /** What the owner made the lead for; null until it loads, or when it has none. */
  readonly charter: string | null;
  readonly onSend: (text: string) => void;
  readonly onStart: (text: string) => void;
}) {
  const navigation = useNavigation();
  const countryNeeded = useKinCountryNeeded(props);
  const ownerLevel = useKinIsOwnerLevel(props.environmentId);
  return (
    <View className="w-full max-w-[520px] self-center">
      <EmptyState
        variant="plain"
        title={
          (props.charter ?? "").trim() === "" ? `What ${props.agentName} does` : props.agentName
        }
        detail={kinLeadIntroDetail(props.charter)}
        action={
          <View className="flex-row flex-wrap justify-center gap-2">
            {countryNeeded && ownerLevel ? (
              <Button
                tone="primary"
                size="compact"
                label={KIN_INTRO_COUNTRY}
                onPress={() =>
                  navigation.navigate("KinCompany", {
                    environmentId: String(props.environmentId),
                    orgId: String(props.orgId),
                  })
                }
              />
            ) : null}
            {KIN_INTRO_PROMPTS.map((prompt) =>
              prompt.send ? (
                <Button
                  key={prompt.text}
                  tone="secondary"
                  size="compact"
                  label={prompt.label}
                  accessibilityHint={kinIntroSendsTo(props.agentName)}
                  onPress={() => props.onSend(prompt.text)}
                />
              ) : (
                <Button
                  key={prompt.text}
                  tone="secondary"
                  size="compact"
                  label={prompt.label}
                  accessibilityHint={KIN_INTRO_START_HINT}
                  onPress={() => props.onStart(prompt.text)}
                />
              ),
            )}
          </View>
        }
      />
    </View>
  );
}
