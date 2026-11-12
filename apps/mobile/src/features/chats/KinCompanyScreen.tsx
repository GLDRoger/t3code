import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_COMPANY,
  KIN_COMPANY_SECTIONS,
  kinCompanyDraftOf,
  kinCompanyEmpty,
  kinCompanyInput,
  kinCompanyRead,
  type KinCompanyDraft,
  type KinCompanyFieldId,
} from "@t3tools/client-runtime/kin/kinCompanyProfile";
import { KIN_BRAND } from "@t3tools/client-runtime/kin/kinBrand";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import { EnvironmentId, KinOrgId, type KinCompanyProfile } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  KinWorkFrame,
  KinWorkLoading,
  KinWorkPrivateMark,
  KinWorkTextField,
} from "./components/KinWorkPieces";
import { KinBrandForm, KinBrandRows } from "./KinBrand";
import { KinTemplateRows } from "./KinTemplates";
import { kinClient } from "./state/kinClient";
import { kinHostConnected } from "./state/useKinHost";
import { useKinCompanyProfile } from "./state/useKinMoney";
import type { KinWorkTarget } from "./state/useKinWork";

export type KinCompanyParams = { readonly environmentId: string; readonly orgId: string };

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

/** The company's legal, tax and bank details, for whoever runs this Kin and nobody else. */
export function KinCompanyScreen({ route }: StaticScreenProps<KinCompanyParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  if (environmentId === null || orgId === null) {
    return (
      <KinWorkFrame title={KIN_COMPANY.title} onBack={() => navigation.goBack()}>
        <EmptyState variant="plain" {...KIN_COMPANY.noKin} />
      </KinWorkFrame>
    );
  }
  return <Permitted environmentId={environmentId} orgId={orgId} />;
}

function Permitted(props: KinWorkTarget) {
  const navigation = useNavigation();
  const allowed = useAtomValue(kinClient.companyRead.permissionAtom(props.environmentId));
  const { state, refresh } = useKinCompanyProfile(props, allowed);
  const back = () => navigation.goBack();
  if (!allowed || state._tag === "refused") {
    return (
      <KinWorkFrame title={KIN_COMPANY.title} onBack={back}>
        <EmptyState variant="plain" {...KIN_COMPANY.onlyOwner} />
      </KinWorkFrame>
    );
  }
  if (state._tag !== "ready") {
    return (
      <KinWorkFrame title={KIN_COMPANY.title} onBack={back}>
        {state._tag === "loading" ? (
          <KinWorkLoading label="Loading company details" />
        ) : (
          <EmptyState
            variant="plain"
            title={KIN_COMPANY.loadFailed}
            detail="Check your connection to the server and try again."
            action={<Button tone="secondary" label="Try again" onPress={refresh} />}
          />
        )}
      </KinWorkFrame>
    );
  }
  return <Profile {...props} profile={state.value} onRefresh={refresh} />;
}

function Profile(
  props: KinWorkTarget & { readonly profile: KinCompanyProfile; readonly onRefresh: () => void },
) {
  const navigation = useNavigation();
  const { environmentId, orgId, profile } = props;
  const canEdit = useAtomValue(kinClient.companyProfileSet.permissionAtom(environmentId));
  const set = useAtomCommand(kinClient.companyProfileSet, { reportFailure: false });
  const [draft, setDraft] = useState<KinCompanyDraft | null>(null);
  const [problems, setProblems] = useState<Readonly<Partial<Record<KinCompanyFieldId, string>>>>(
    {},
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [brandSaved, setBrandSaved] = useState(false);
  const [editingBrand, setEditingBrand] = useState(false);
  const save = async (typed: KinCompanyDraft) => {
    const checked = kinCompanyInput(orgId, profile, typed);
    setProblem(null);
    if (!checked.ok) return setProblems(checked.problems);
    setProblems({});
    const { input } = checked;
    if (input === null) return setDraft(null);
    setSaving(true);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => set({ environmentId, input }),
    });
    setSaving(false);
    props.onRefresh();
    if (!outcome.ok) return setProblem(outcome.changed ? KIN_COMPANY.changed : outcome.problem);
    setDraft(null);
    setSaved(true);
  };
  const lock = (
    <View className="flex-row items-start gap-2 px-2">
      <View className="pt-0.5">
        <KinWorkPrivateMark label="" />
      </View>
      <Text textRole="footnote" className="min-w-0 flex-1 text-foreground-muted">
        {KIN_COMPANY.private}
      </Text>
    </View>
  );
  if (editingBrand) {
    return (
      <KinBrandForm
        environmentId={environmentId}
        orgId={orgId}
        profile={profile}
        onRefresh={props.onRefresh}
        onDone={(done) => {
          setEditingBrand(false);
          setBrandSaved(done);
        }}
      />
    );
  }
  if (draft === null) {
    const sections = kinCompanyRead(profile).filter((section) => section.rows.length > 0);
    return (
      <KinWorkFrame
        title={KIN_COMPANY.title}
        onBack={() => navigation.goBack()}
        refresh={{ accessibilityLabel: "Refresh", onPress: props.onRefresh }}
        {...(canEdit
          ? {
              actions: [
                {
                  accessibilityLabel: KIN_COMPANY.edit,
                  icon: "pencil" as const,
                  onPress: () => {
                    setSaved(false);
                    setDraft(kinCompanyDraftOf(profile));
                  },
                },
              ],
            }
          : {})}
      >
        {lock}
        {saved ? <Notice message={KIN_COMPANY.saved} icon="checkmark.circle" /> : null}
        {kinCompanyEmpty(profile) ? (
          <EmptyState
            variant="plain"
            title={KIN_COMPANY.title}
            detail={KIN_COMPANY.empty}
            {...(canEdit
              ? {
                  action: (
                    <Button
                      tone="primary"
                      label={KIN_COMPANY.edit}
                      onPress={() => setDraft(kinCompanyDraftOf(profile))}
                    />
                  ),
                }
              : {})}
          />
        ) : (
          sections.map((section) => (
            <ListSection key={section.title} title={section.title}>
              {section.rows.map((row) => (
                <View key={row.id} className="min-h-14 justify-center gap-1 px-4 py-3">
                  <Text className="text-sm text-foreground-muted">{row.label}</Text>
                  <Text textRole="body" selectable className="text-foreground">
                    {row.value}
                  </Text>
                </View>
              ))}
            </ListSection>
          ))
        )}
        {brandSaved ? <Notice message={KIN_BRAND.saved} icon="checkmark.circle" /> : null}
        <KinBrandRows
          environmentId={environmentId}
          orgId={orgId}
          profile={profile}
          onRefresh={props.onRefresh}
          onEdit={
            canEdit
              ? () => {
                  setBrandSaved(false);
                  setEditingBrand(true);
                }
              : null
          }
        />
        <KinTemplateRows environmentId={environmentId} orgId={orgId} />
      </KinWorkFrame>
    );
  }
  return (
    <KinWorkFrame
      title={KIN_COMPANY.title}
      form
      onClose={() => {
        setProblems({});
        setProblem(null);
        setDraft(null);
      }}
      confirm={{
        label: KIN_COMPANY.save,
        onPress: () => void save(draft),
        loading: saving,
        disabled: saving,
      }}
    >
      {lock}
      {problem === null ? null : <Notice message={problem} tone="danger" />}
      {KIN_COMPANY_SECTIONS.map((section) => (
        <ListSection key={section.title} title={section.title}>
          {section.fields.map((field) => (
            <KinWorkTextField
              key={field.id}
              label={field.label}
              value={draft[field.id]}
              placeholder={field.placeholder}
              disabled={saving}
              {...(field.code ? { keyboard: "plain" as const } : {})}
              {...(field.multiline ? { multiline: true } : {})}
              {...(problems[field.id] === undefined ? {} : { hint: problems[field.id] })}
              onChangeText={(text) => setDraft({ ...draft, [field.id]: text })}
            />
          ))}
        </ListSection>
      ))}
    </KinWorkFrame>
  );
}
