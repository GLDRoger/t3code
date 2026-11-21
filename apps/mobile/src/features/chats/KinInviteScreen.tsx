import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_NEW_TEAMMATE_SEES,
  KIN_PLACE_SWITCHES,
  KIN_TEAMMATE_NAME_MAX,
  KIN_TEAM_ADD_COPY,
  KIN_TEAM_COPY,
  KIN_TEAM_ONLY_OWNER,
  kinRemovedNamesake,
  kinTeammateNameCheck,
  kinTeammateNameMatch,
  type KinMadeInvite,
} from "@t3tools/client-runtime/kin/kinTeam";
import { EnvironmentId, KinOrgId, type KinPersonPlaceSwitches } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { KIN_ONLY } from "../../lib/kinOnly";
import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { KinInviteLink } from "./components/KinInviteLink";
import { useKinTeam, type KinTeamTarget } from "./state/useKinTeam";
import { KinGateView } from "./components/KinWorkPieces";

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
          <ScreenScrollView
            className="flex-1"
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ padding: 16 }}
          >
            <EmptyState
              variant="plain"
              title="This link doesn't open anything"
              detail="Add a teammate from Team in your Kin chats."
            />
          </ScreenScrollView>
        </ScreenContent>
      </View>
    );
  }
  return <KinInviteForm environmentId={environmentId} orgId={orgId} />;
}

function KinInviteForm(target: KinTeamTarget) {
  const navigation = useNavigation();
  const { allowed, gate, actions, list } = useKinTeam(target);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // Held here and nowhere else; closing the sheet drops it.
  const [made, setMade] = useState<KinMadeInvite | null>(null);
  const [sees, setSees] = useState<KinPersonPlaceSwitches>(KIN_NEW_TEAMMATE_SEES);
  const checked = kinTeammateNameCheck(name);
  const match = kinTeammateNameMatch(list, name);

  const save = async (person: ReturnType<typeof kinRemovedNamesake> = null, newPerson?: true) => {
    if (saving || !allowed) return;
    if (!checked.ok) return setProblem(checked.problem);
    setSaving(true);
    setProblem(null);
    const result = await actions.makeLink({
      displayName: person?.displayName ?? checked.name,
      personId: person?.personId ?? null,
      ...(newPerson === true ? { newPerson } : {}),
      // Someone coming back gets back what they had; only someone new starts with these.
      ...(person === null ? { sees } : {}),
      replaces:
        person === null
          ? null
          : (list?.invites.find((held) => held.personId === person.personId)?.inviteId ?? null),
    });
    setSaving(false);
    if (result.ok) return setMade(result.invite);
    const removed = result.bringBack === true ? kinRemovedNamesake(list, checked.name) : null;
    // The host's offer to bring back a removed person by this name, instead of a second one.
    if (removed === null) return setProblem(result.problem);
    Dialog.alert(KIN_TEAM_ADD_COPY.title, result.problem, [
      { text: "Cancel", style: "cancel" },
      { text: KIN_TEAM_ADD_COPY.someoneElse, onPress: () => void save(null, true) },
      { text: `Bring back ${removed.displayName}`, onPress: () => void save(removed) },
    ]);
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
          {gate !== null ? (
            <KinGateView
              gate={gate}
              refused={KIN_TEAM_ONLY_OWNER}
              label={KIN_TEAM_ADD_COPY.submit}
            />
          ) : made !== null ? (
            <KinInviteLink invite={made} environmentId={target.environmentId} />
          ) : (
            <>
              <Text textRole="body" className="px-2 text-foreground-muted">
                {KIN_TEAM_ADD_COPY.detail(KIN_ONLY)}
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
                      placeholderTextColorClassName="accent-placeholder"
                      className="min-h-8 font-sans text-base text-foreground"
                    />
                  </View>
                </ListSection>
                <Text textRole="footnote" className="px-4 text-foreground-muted">
                  {KIN_TEAM_ADD_COPY.nameHint}
                </Text>
              </View>
              {match === null ? null : <Notice message={match} />}
              <ListSection title={KIN_TEAM_COPY.canSee} footer={KIN_TEAM_ADD_COPY.seesFooter}>
                {KIN_PLACE_SWITCHES.map((entry, index) => (
                  <View
                    key={entry.place}
                    className={index === 0 ? undefined : "border-t border-border-subtle"}
                  >
                    <ListToggleRow
                      label={entry.label}
                      description={entry.detail}
                      value={sees[entry.place]}
                      disabled={saving}
                      onValueChange={(on) => setSees((held) => ({ ...held, [entry.place]: on }))}
                    />
                  </View>
                ))}
              </ListSection>
            </>
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}
