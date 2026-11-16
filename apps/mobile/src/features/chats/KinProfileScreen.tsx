import { useNavigation, usePreventRemove, type StaticScreenProps } from "@react-navigation/native";
import { kinFeedViewer } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  KIN_DAY_LABELS,
  KIN_PROFILE_COPY,
  KIN_PROFILE_NAME_MAX,
  KIN_PROFILE_SKILLS_MAX,
  kinHoursLine,
  kinMayEditProfile,
  kinPersonSeed,
  kinProfileChanges,
  kinProfileDraft,
  type KinProfileDraft,
} from "@t3tools/client-runtime/kin/kinProfiles";
import {
  EnvironmentId,
  KinOrgId,
  KinPersonId,
  type KinPeopleUpdateProfileInput,
  type KinPersonProfile,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState, type ComponentProps, type ReactNode } from "react";
import { TextInput, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinAvatar } from "./components/KinAvatar";
import { kinClient } from "./state/kinClient";
import { pickKinPicture } from "./state/kinPicture";
import { useKinHostAt } from "./state/useKinHost";
import { useKinProfiles } from "./state/useKinProfiles";

export type KinProfileParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly personId: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const decodePersonId = Schema.decodeUnknownOption(KinPersonId);

function useTarget(params: KinProfileParams) {
  const environmentId = Option.getOrNull(decodeEnvironmentId(params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(params.orgId));
  const personId = Option.getOrNull(decodePersonId(params.personId));
  const { held, failed } = useKinProfiles(environmentId, orgId);
  const host = useKinHostAt(environmentId ?? EnvironmentId.make("none"));
  const viewer = kinFeedViewer(
    host._tag === "host" && host.probe._tag === "ready" ? host.probe.orgs : null,
    orgId,
  ).personId;
  const profile = held?.profiles.find((entry) => entry.personId === personId) ?? null;
  return {
    environmentId,
    orgId,
    profile,
    failed,
    loading: held === null && !failed,
    mine: viewer !== null && viewer === personId,
    mayEdit:
      personId !== null &&
      kinMayEditProfile({
        viewerPersonId: viewer,
        ownerPersonId: held?.ownerPersonId ?? null,
        personId,
        canEdit: profile?.canEdit,
      }),
    runsWorkspace: held !== null && held.ownerPersonId === personId,
  };
}

function Frame(props: {
  readonly title: string;
  readonly onClose: () => void;
  readonly confirm?: ComponentProps<typeof AppBar>["confirm"];
  readonly children: ReactNode;
}) {
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={props.title} onClose={props.onClose} confirm={props.confirm} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {props.children}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function Missing(props: { readonly loading: boolean; readonly failed: boolean }) {
  return props.loading ? (
    <View className="items-center py-12">
      <AppActivityIndicator />
    </View>
  ) : (
    <EmptyState
      variant="plain"
      title={props.failed ? KIN_PROFILE_COPY.loadFailed : "This person isn't here"}
      detail="Close this and open them again from the Team list or a chat."
    />
  );
}

/** Someone's profile: their face, roles, skills and hours. Theirs, or the owner's, to edit. */
export function KinProfileScreen({ route }: StaticScreenProps<KinProfileParams>) {
  const navigation = useNavigation();
  const target = useTarget(route.params);
  const { profile } = target;
  const close = () => navigation.goBack();
  const title = target.mine ? KIN_PROFILE_COPY.mine : KIN_PROFILE_COPY.title;
  if (profile === null || target.environmentId === null || target.orgId === null)
    return (
      <Frame title={title} onClose={close}>
        <Missing loading={target.loading} failed={target.failed} />
      </Frame>
    );
  const hours = kinHoursLine(profile.workHours);
  return (
    <Frame title={title} onClose={close}>
      <View className="items-center gap-3 pt-2">
        <KinAvatar
          avatar={{ kind: "person", seed: kinPersonSeed(profile.personId) }}
          size="profile"
        />
        <View className="items-center gap-1">
          <Text textRole="title" className="text-center font-t3-bold text-foreground">
            {profile.displayName}
          </Text>
          {target.runsWorkspace ? (
            <Text textRole="footnote" className="text-center text-foreground-muted">
              Runs this workspace
            </Text>
          ) : null}
        </View>
        {profile.roleTags.length === 0 ? null : (
          <View className="flex-row flex-wrap justify-center gap-1.5">
            {profile.roleTags.map((tag) => (
              <Chip key={tag} label={tag} size="small" />
            ))}
          </View>
        )}
      </View>
      <ListSection title={KIN_PROFILE_COPY.skillsLabel}>
        <View className="px-4 py-3">
          <Text
            textRole="body"
            className={profile.skills === "" ? "text-foreground-muted" : "text-foreground"}
          >
            {profile.skills === "" ? KIN_PROFILE_COPY.noSkills : profile.skills}
          </Text>
        </View>
      </ListSection>
      <ListSection title={KIN_PROFILE_COPY.hoursLabel}>
        <View className="gap-0.5 px-4 py-3">
          <Text
            textRole="body"
            className={hours === null ? "text-foreground-muted" : "text-foreground"}
          >
            {hours ?? KIN_PROFILE_COPY.noHours}
          </Text>
          {profile.timeZone === null ? null : (
            <Text textRole="footnote" className="text-foreground-muted">
              {profile.timeZone}
            </Text>
          )}
        </View>
      </ListSection>
      {target.mayEdit ? (
        <Button
          tone="secondary"
          fullWidth
          label={KIN_PROFILE_COPY.edit}
          onPress={() => navigation.navigate("KinProfileEdit", route.params)}
        />
      ) : null}
    </Frame>
  );
}

/** The profile form: a full sheet, saved with the bar's Save. Pictures save as soon as picked. */
export function KinProfileEditScreen({ route }: StaticScreenProps<KinProfileParams>) {
  const navigation = useNavigation();
  const target = useTarget(route.params);
  const { profile, environmentId, orgId } = target;
  if (profile === null || environmentId === null || orgId === null || !target.mayEdit)
    return (
      <Frame title={KIN_PROFILE_COPY.edit} onClose={() => navigation.goBack()}>
        <Missing loading={target.loading} failed={target.failed} />
      </Frame>
    );
  return <ProfileForm environmentId={environmentId} orgId={orgId} profile={profile} />;
}

function ProfileForm(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
  readonly profile: KinPersonProfile;
}) {
  const navigation = useNavigation();
  const { environmentId, orgId, profile } = props;
  const update = useAtomCommand(kinClient.profileUpdate, { reportFailure: false });
  const [initial] = useState(() => kinProfileDraft(profile));
  const [draft, setDraft] = useState<KinProfileDraft>(initial);
  const [busy, setBusy] = useState<"saving" | "picture" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const saved = useRef(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const set = (change: Partial<KinProfileDraft>) => {
    setDraft((current) => ({ ...current, ...change }));
    setProblem(null);
  };

  usePreventRemove(dirty && busy === null, ({ data }) => {
    if (saved.current) return navigation.dispatch(data.action);
    Dialog.alert("Discard changes?", "What you typed will be lost.", [
      { text: "Keep editing", style: "cancel" },
      { text: "Discard", style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });

  const send = (changes: Omit<KinPeopleUpdateProfileInput, "orgId" | "personId">) =>
    update({ environmentId, input: { orgId, personId: profile.personId, ...changes } });

  const save = async () => {
    const checked = kinProfileChanges(profile, draft);
    if (!checked.ok) return setProblem(checked.problem);
    if (Object.keys(checked.changes).length === 0) {
      saved.current = true;
      return navigation.goBack();
    }
    setBusy("saving");
    const outcome = await send(checked.changes);
    setBusy(null);
    if (!AsyncResult.isSuccess(outcome)) return setProblem(KIN_PROFILE_COPY.failed);
    saved.current = true;
    navigation.goBack();
  };

  const changePicture = async () => {
    setBusy("picture");
    setProblem(null);
    try {
      const picture = await pickKinPicture(environmentId);
      if (picture !== null) {
        const outcome = await send({ picture });
        if (!AsyncResult.isSuccess(outcome)) setProblem(KIN_PROFILE_COPY.pictureFailed);
      }
    } catch {
      setProblem(KIN_PROFILE_COPY.pictureFailed);
    }
    setBusy(null);
  };

  return (
    <Frame
      title={KIN_PROFILE_COPY.edit}
      onClose={() => navigation.goBack()}
      confirm={{
        label: KIN_PROFILE_COPY.save,
        onPress: () => void save(),
        loading: busy === "saving",
        disabled: busy !== null || !dirty,
      }}
    >
      {problem === null ? null : <ErrorBanner message={problem} />}
      <View className="items-center gap-2">
        <KinAvatar
          avatar={{ kind: "person", seed: kinPersonSeed(profile.personId) }}
          size="profile"
        />
      </View>
      <ListSection>
        <ListActionRow
          label={
            profile.pictureId === null
              ? KIN_PROFILE_COPY.pictureAdd
              : KIN_PROFILE_COPY.pictureChange
          }
          icon="photo"
          loading={busy === "picture"}
          disabled={busy !== null}
          onPress={() => void changePicture()}
        />
        {profile.pictureId === null ? null : (
          <View className="border-t border-border-subtle">
            <ListActionRow
              label={KIN_PROFILE_COPY.pictureRemove}
              icon="trash"
              disabled={busy !== null}
              onPress={() => void send({ picture: null })}
            />
          </View>
        )}
      </ListSection>
      <ListSection>
        <Field
          label={KIN_PROFILE_COPY.nameLabel}
          value={draft.displayName}
          maxLength={KIN_PROFILE_NAME_MAX}
          autoCapitalize="words"
          onChange={(displayName) => set({ displayName })}
        />
        <Field
          label={KIN_PROFILE_COPY.tagsLabel}
          value={draft.tags}
          placeholder="tech, ios"
          maxLength={200}
          autoCapitalize="none"
          borderTop
          onChange={(tags) => set({ tags })}
        />
      </ListSection>
      <Text textRole="footnote" className="-mt-3 px-4 text-foreground-muted">
        {KIN_PROFILE_COPY.tagsHint}
      </Text>
      <ListSection title={KIN_PROFILE_COPY.skillsLabel} footer={KIN_PROFILE_COPY.skillsHint}>
        <TextInput
          multiline
          accessibilityLabel={KIN_PROFILE_COPY.skillsLabel}
          value={draft.skills}
          maxLength={KIN_PROFILE_SKILLS_MAX}
          onChangeText={(skills) => set({ skills })}
          placeholder="SwiftUI, App Store releases"
          placeholderTextColorClassName="accent-placeholder"
          textAlignVertical="top"
          className="min-h-24 px-4 py-3 font-sans text-base leading-normal text-foreground"
        />
      </ListSection>
      <ListSection title={KIN_PROFILE_COPY.hoursLabel}>
        <View className="flex-row flex-wrap gap-1.5 px-4 py-3">
          {KIN_DAY_LABELS.map((label, day) => (
            <Chip
              key={label}
              label={label}
              selected={draft.days.includes(day)}
              onPress={() =>
                set({
                  days: draft.days.includes(day)
                    ? draft.days.filter((held) => held !== day)
                    : [...draft.days, day],
                })
              }
            />
          ))}
        </View>
        <Field
          label="Starts"
          value={draft.start}
          placeholder="09:00"
          maxLength={5}
          autoCapitalize="none"
          borderTop
          onChange={(start) => set({ start })}
        />
        <Field
          label="Ends"
          value={draft.end}
          placeholder="18:00"
          maxLength={5}
          autoCapitalize="none"
          borderTop
          onChange={(end) => set({ end })}
        />
        <Field
          label={KIN_PROFILE_COPY.timeZoneLabel}
          value={draft.timeZone}
          placeholder="Asia/Kolkata"
          maxLength={64}
          autoCapitalize="none"
          borderTop
          onChange={(timeZone) => set({ timeZone })}
        />
      </ListSection>
    </Frame>
  );
}

function Field(props: {
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly maxLength: number;
  readonly autoCapitalize: "words" | "sentences" | "none";
  readonly borderTop?: boolean;
  readonly onChange: (value: string) => void;
}) {
  return (
    <View
      className={
        props.borderTop ? "gap-2 border-t border-border-subtle px-4 py-3" : "gap-2 px-4 py-3"
      }
    >
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        value={props.value}
        autoCapitalize={props.autoCapitalize}
        autoCorrect={false}
        maxLength={props.maxLength}
        onChangeText={props.onChange}
        placeholder={props.placeholder}
        placeholderTextColorClassName="accent-placeholder"
        className="min-h-8 font-sans text-base text-foreground"
      />
    </View>
  );
}
