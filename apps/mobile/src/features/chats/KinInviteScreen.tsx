import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_TEAMMATE_NAME_MAX,
  KIN_TEAM_ADD_COPY,
  KIN_TEAM_ONLY_OWNER,
  kinTeammateNameCheck,
  type KinMadeInvite,
} from "@t3tools/client-runtime/kin/kinTeam";
import { EnvironmentId, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { KinInviteLink } from "./components/KinInviteLink";
import { useKinTeam, type KinTeamTarget } from "./state/useKinTeam";

export type KinInviteParams = { readonly environmentId: string; readonly orgId: string };

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

/** Adds a teammate by name, then shows the link to send them. */
export function KinInviteScreen({ route }: StaticScreenProps<KinInviteParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <View collapsable={false} className="flex-1 bg-screen">
        <AppBar title={KIN_TEAM_ADD_COPY.title} onClose={() => navigation.goBack()} />
        <ScreenContent surface="screen">
          <EmptyState
            variant="plain"
            title="This link doesn't open anything"
            detail="Add a teammate from Team in your Kin chats."
          />
        </ScreenContent>
      </View>
    );
  }
  return <KinInviteForm environmentId={environmentId} orgId={orgId} />;
}

function KinInviteForm(target: KinTeamTarget) {
  const navigation = useNavigation();
  const { allowed, actions } = useKinTeam(target);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Held here and nowhere else; closing the sheet drops it.
  const [made, setMade] = useState<KinMadeInvite | null>(null);
  const checked = kinTeammateNameCheck(name);

  const save = async () => {
    if (saving || !allowed) return;
    if (!checked.ok) return setProblem(checked.problem);
    setSaving(true);
    setProblem(null);
    const result = await actions.makeLink({
      displayName: checked.name,
      personId: null,
      replaces: null,
    });
    setSaving(false);
    if (result.ok) setMade(result.invite);
    else setProblem(result.problem);
  };

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title={made === null ? KIN_TEAM_ADD_COPY.title : "Invite link"}
        onClose={() => navigation.goBack()}
        confirm={
          made === null
            ? {
                label: KIN_TEAM_ADD_COPY.submit,
                onPress: () => void save(),
                loading: saving,
                disabled: !allowed || saving || name.trim() === "",
              }
            : { label: "Done", onPress: () => navigation.goBack() }
        }
      />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {!allowed ? (
            <EmptyState variant="plain" {...KIN_TEAM_ONLY_OWNER} />
          ) : made !== null ? (
            <KinInviteLink invite={made} environmentId={target.environmentId} />
          ) : (
            <>
              <Text textRole="body" className="px-2 text-foreground-muted">
                {KIN_TEAM_ADD_COPY.detail}
              </Text>
              {problem === null ? null : <ErrorBanner message={problem} />}
              <View className="gap-2">
                <ListSection>
                  <View className="gap-2 px-4 py-3">
                    <Text className="text-sm text-foreground-muted">
                      {KIN_TEAM_ADD_COPY.nameLabel}
                    </Text>
                    <TextInput
                      accessibilityLabel={KIN_TEAM_ADD_COPY.nameLabel}
                      value={name}
                      editable={!saving}
                      autoFocus
                      autoCapitalize="words"
                      autoCorrect={false}
                      returnKeyType="done"
                      maxLength={KIN_TEAMMATE_NAME_MAX}
                      onChangeText={setName}
                      onSubmitEditing={() => void save()}
                      textAlignVertical="center"
                      placeholder={KIN_TEAM_ADD_COPY.namePlaceholder}
                      placeholderTextColorClassName="accent-placeholder"
                      className="min-h-8 font-sans text-base text-foreground"
                    />
                  </View>
                </ListSection>
                <Text textRole="footnote" className="px-4 text-foreground-muted">
                  {KIN_TEAM_ADD_COPY.nameHint}
                </Text>
              </View>
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
