import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_COMPANY,
  kinCompanyCountrySuggestion,
  kinCompanyEditSections,
  kinCompanyDraftOf,
  kinDeviceRegion,
  kinCompanyEmpty,
  kinCompanyInput,
  kinCompanyRead,
  type KinCompanyDraft,
  type KinCompanyFieldId,
} from "@t3tools/client-runtime/kin/kinCompanyProfile";
import { KIN_BRAND } from "@t3tools/client-runtime/kin/kinBrand";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import { kinZoneLabel } from "@t3tools/client-runtime/kin/kinTimeZone";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, KinOrgId, type KinCompanyProfile } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { Fragment, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { usePreparedConnection } from "../../state/session";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  KinWorkFrame,
  KinWorkLoading,
  KinWorkPrivateMark,
  KinWorkTextField,
} from "./components/KinWorkPieces";
import { KinBrandForm, KinBrandRows } from "./KinBrand";
import { KinStopRows } from "./KinStopRows";
import { KinTemplateRows } from "./KinTemplates";
import { kinClient } from "./state/kinClient";
import { kinHostConnected } from "./state/useKinHost";
import { useKinCompanyProfile, useKinCountryNeeded } from "./state/useKinMoney";
import { useKinWorkZone, type KinWorkTarget } from "./state/useKinWork";
import { KinDayField } from "./components/KinDayField";
import { KinLoadFailed, KinLoadFailedRow } from "./components/KinLoadFailed";
import { useKinGate } from "./state/useKinHost";
import { KinGateView } from "./components/KinWorkPieces";

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
  const gate = useKinGate(
    kinClient.companyRead.permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  const allowed = gate === null;
  const { state, refresh } = useKinCompanyProfile(props, allowed);
  const back = () => navigation.goBack();
  if (!allowed || state._tag === "refused") {
    return (
      <KinWorkFrame title={KIN_COMPANY.title} onBack={back}>
        <KinGateView
          gate={gate ?? "refused"}
          refused={KIN_COMPANY.onlyOwner}
          label={KIN_COMPANY.title}
        />
      </KinWorkFrame>
    );
  }
  if (state._tag !== "ready") {
    return (
      <KinWorkFrame title={KIN_COMPANY.title} onBack={back}>
        {state._tag === "loading" ? (
          <KinWorkLoading label={KIN_COMPANY.loading} />
        ) : (
          <KinLoadFailed
            title={KIN_COMPANY.loadFailed}
            cause={state._tag === "failed" ? state.cause : null}
            onRetry={refresh}
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
  const waiting = useKinCountryNeeded(props);
  const region = kinDeviceRegion();
  const { zone } = useKinWorkZone(props);
  const [opened] = useState(() => new Date());
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
                    setDraft(kinCompanyDraftOf(profile, region, waiting));
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
                      onPress={() => setDraft(kinCompanyDraftOf(profile, region, waiting))}
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
        <CompanyTimeZone environmentId={environmentId} orgId={orgId} />
        <KinStopRows environmentId={environmentId} orgId={orgId} />
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
        <KinExportRows environmentId={environmentId} orgId={orgId} />
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
      {kinCompanyEditSections(profile, draft).map((section) => (
        <ListSection key={section.title} title={section.title}>
          {section.fields.map((field) => {
            const offer =
              field.id === "country" ? kinCompanyCountrySuggestion(draft, region, waiting) : null;
            return (
              <Fragment key={field.id}>
                {field.day ? (
                  <KinDayField
                    label={field.label}
                    day={draft[field.id] === "" ? null : draft[field.id]}
                    zone={zone}
                    now={opened}
                    hint={problems[field.id] ?? null}
                    disabled={saving}
                    onPick={(day) => setDraft({ ...draft, [field.id]: day ?? "" })}
                  />
                ) : (
                  <KinWorkTextField
                    label={field.label}
                    value={draft[field.id]}
                    placeholder={field.placeholder}
                    disabled={saving}
                    {...(field.code ? { keyboard: "plain" as const } : {})}
                    {...(field.multiline ? { multiline: true } : {})}
                    {...(problems[field.id] === undefined ? {} : { hint: problems[field.id] })}
                    onChangeText={(text) => setDraft({ ...draft, [field.id]: text })}
                  />
                )}
                {offer === null ? null : (
                  <ListActionRow
                    icon="globe"
                    label={offer.label}
                    disabled={saving}
                    onPress={() => setDraft(offer.accept())}
                  />
                )}
              </Fragment>
            );
          })}
        </ListSection>
      ))}
    </KinWorkFrame>
  );
}

/** What check-ins, due days and the agents' times follow; the owner's phone keeps it set. */
function CompanyTimeZone(props: KinWorkTarget) {
  const atom = kinClient.workZone({
    environmentId: props.environmentId,
    input: { orgId: props.orgId },
  });
  const result = useAtomValue(atom);
  const zone = Option.getOrNull(AsyncResult.value(result));
  if (zone === null)
    return AsyncResult.isFailure(result) ? (
      <ListSection title={KIN_COMPANY.timeZone}>
        <KinLoadFailedRow
          title="Couldn't load the company's time zone"
          cause={result}
          onRetry={() => appAtomRegistry.refresh(atom)}
        />
      </ListSection>
    ) : null;
  return (
    <ListSection title={KIN_COMPANY.timeZone}>
      <ListRowLayout
        icon="clock"
        label={kinZoneLabel(zone.timeZone)}
        description={
          zone.fromHost === true
            ? KIN_COMPANY.timeZoneFromHost
            : `${KIN_COMPANY.timeZoneUse} ${KIN_COMPANY.timeZoneFollows}`
        }
      />
    </ListSection>
  );
}

/** Download everything, the owner's alone: the zip downloads to the phone, then the share sheet takes it. */
function KinExportRows(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const allowed = useAtomValue(kinClient.exportLink.permissionAtom(environmentId));
  const link = useAtomCommand(kinClient.exportLink, { reportFailure: false });
  const connection = usePreparedConnection(environmentId);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!allowed) return null;
  const share = async () => {
    if (Option.isNone(connection)) return kinFailureText(null, KIN_COMPANY.export.failed);
    const result = await link({ environmentId, input: { orgId } });
    if (result._tag === "Failure")
      return kinFailureText(squashAtomCommandFailure(result), KIN_COMPANY.export.failed);
    const url = resolveAssetUrl(connection.value.httpBaseUrl, result.value.url);
    if (url === null) return kinFailureText(null, KIN_COMPANY.export.failed);
    await downloadAndShareAttachment({
      url,
      attachment: { name: result.value.fileName, mimeType: "application/zip" },
      signal: new AbortController().signal,
    });
    return null;
  };
  const download = () => {
    setBusy(true);
    setProblem(null);
    void share()
      .catch((cause: unknown) => kinFailureText(cause, KIN_COMPANY.export.failed))
      .then((failed) => {
        setProblem(failed);
        setBusy(false);
      });
  };
  return (
    <ListSection title={KIN_COMPANY.export.title}>
      <View className="gap-1 px-4 py-3">
        <Text className="text-sm text-foreground-muted">{KIN_COMPANY.export.detail}</Text>
        <Text className="text-sm text-foreground-muted">{KIN_COMPANY.export.leaves}</Text>
      </View>
      <ListActionRow
        icon="square.and.arrow.up"
        label={busy ? KIN_COMPANY.export.preparing : KIN_COMPANY.export.share}
        disabled={busy}
        loading={busy}
        onPress={download}
      />
      {problem === null ? null : <Notice message={problem} tone="danger" />}
    </ListSection>
  );
}
