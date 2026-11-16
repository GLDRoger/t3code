import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { KIN_AGENT_PAGE } from "@t3tools/client-runtime/kin/kinAgentPage";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, KinAgentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import { kinClient } from "./state/kinClient";

export type KinAgentCharacterParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly agentId: string;
};

const decode = Schema.decodeUnknownOption(
  Schema.Struct({ environmentId: EnvironmentId, orgId: KinOrgId, agentId: KinAgentId }),
);

/** An agent's character as text to change; saving keeps the old one in its history. */
export function KinAgentCharacterScreen({ route }: StaticScreenProps<KinAgentCharacterParams>) {
  const navigation = useNavigation();
  const target = Option.getOrNull(decode(route.params));
  const pageAtom =
    target === null
      ? null
      : kinClient.agentPage({
          environmentId: target.environmentId,
          input: { orgId: target.orgId, agentId: target.agentId },
        });
  const page = pageAtom === null ? null : <Editor target={target!} pageAtom={pageAtom} />;
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      {page ?? <AppBar title={KIN_AGENT_PAGE.character} onClose={() => navigation.goBack()} />}
    </View>
  );
}

function Editor(props: {
  readonly target: { environmentId: EnvironmentId; orgId: KinOrgId; agentId: KinAgentId };
  readonly pageAtom: ReturnType<typeof kinClient.agentPage>;
}) {
  const navigation = useNavigation();
  const page = Option.getOrNull(AsyncResult.value(useAtomValue(props.pageAtom)));
  const save = useAtomCommand(kinClient.characterSet, { reportFailure: false });
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const body = draft ?? page?.character?.body ?? "";
  const submit = async () => {
    if (body.trim() === "") return;
    setBusy(true);
    const outcome = await save({
      environmentId: props.target.environmentId,
      input: { orgId: props.target.orgId, agentId: props.target.agentId, body },
    });
    setBusy(false);
    if (AsyncResult.isFailure(outcome)) {
      setProblem(kinFailureText(squashAtomCommandFailure(outcome), "Couldn't save the character."));
      return;
    }
    appAtomRegistry.refresh(props.pageAtom);
    navigation.goBack();
  };
  return (
    <>
      <AppBar
        title={page === null ? KIN_AGENT_PAGE.character : `${page.profile.name}'s character`}
        onClose={() => navigation.goBack()}
        confirm={{
          label: "Save",
          disabled: busy || draft === null || body.trim() === "",
          loading: busy,
          onPress: () => void submit(),
        }}
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 12 }}
        >
          {page === null ? (
            <View className="items-center py-12">
              <AppActivityIndicator />
            </View>
          ) : (
            <>
              <ListSection>
                <TextInput
                  multiline
                  accessibilityLabel={`${page.profile.name}'s character`}
                  value={body}
                  editable={!busy}
                  onChangeText={setDraft}
                  textAlignVertical="top"
                  className="min-h-80 px-4 py-3 font-sans text-base leading-normal text-foreground"
                />
              </ListSection>
              <Text
                textRole="footnote"
                accessibilityLiveRegion={problem === null ? "none" : "polite"}
                className={
                  problem === null ? "px-4 text-foreground-muted" : "px-4 text-danger-foreground"
                }
              >
                {problem ?? KIN_AGENT_PAGE.characterRule}
              </Text>
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </>
  );
}
