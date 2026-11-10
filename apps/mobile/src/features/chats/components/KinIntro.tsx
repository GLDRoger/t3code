import { View } from "react-native";

import { Button } from "../../../components/ui/Button";
import { EmptyState } from "../../../components/ui/EmptyState";
import { KIN_INTRO_PROMPTS } from "@t3tools/client-runtime/kin/kinIntro";
import { kinLeadIntroDetail } from "@t3tools/client-runtime/kin/kinLeadPresentation";

/**
 * First run in the owner's chat with their lead: what the lead is for and a few asks to start with.
 * Gone once the owner has sent anything (`kinIntroVisible`).
 */
export function KinIntro(props: {
  readonly agentName: string;
  /** What the owner made the lead for; null until it loads, or when it has none. */
  readonly charter: string | null;
  readonly onSend: (text: string) => void;
  readonly onStart: (text: string) => void;
}) {
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
            {KIN_INTRO_PROMPTS.map((prompt) =>
              prompt.send ? (
                <Button
                  key={prompt.text}
                  tone="secondary"
                  size="compact"
                  label={prompt.text}
                  accessibilityHint={`Sends this to ${props.agentName}`}
                  onPress={() => props.onSend(prompt.text)}
                />
              ) : (
                <Button
                  key={prompt.text}
                  tone="secondary"
                  size="compact"
                  label={`${prompt.text.trimEnd()}…`}
                  accessibilityLabel={prompt.text.trimEnd()}
                  accessibilityHint="Starts the message for you to finish"
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
