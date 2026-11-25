import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_COMPANY,
  kinCompanyCountrySuggestion,
  kinCompanyDraftEdit,
  kinCompanyDraftOf,
  kinCompanyEmpty,
  kinCompanyGlance,
  kinCompanyInput,
  kinDeviceRegion,
} from "@t3tools/client-runtime/kin/kinCompanyProfile";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import { KIN_MONEY } from "@t3tools/client-runtime/kin/kinMoney";
import { kinZoneLabel } from "@t3tools/client-runtime/kin/kinTimeZone";
import { EnvironmentId, KinOrgId, type KinCompanyProfile } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  KinGateView,
  KinWorkFrame,
  KinWorkLoading,
  KinWorkPrivateMark,
} from "./components/KinWorkPieces";
import { KinCountryPicker } from "./components/KinCountryPicker";
import { KinLoadFailed, KinLoadFailedRow } from "./components/KinLoadFailed";
import { kinClient } from "./state/kinClient";
import { kinHostConnected, useKinGate } from "./state/useKinHost";
import { useKinCompanyProfile, useKinCountryNeeded } from "./state/useKinMoney";
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
  const waiting = useKinCountryNeeded(props);
  const set = useAtomCommand(kinClient.companyProfileSet, { reportFailure: false });
  const [savingCountry, setSavingCountry] = useState(false);
  const [countryProblem, setCountryProblem] = useState<string | null>(null);
  const saveCountry = async (code: string) => {
    const checked = kinCompanyInput(
      orgId,
      profile,
      kinCompanyDraftEdit(kinCompanyDraftOf(profile), "country", code),
    );
    if (!checked.ok || checked.input === null) return;
    const { input } = checked;
    setSavingCountry(true);
    setCountryProblem(null);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => set({ environmentId, input }),
    });
    setSavingCountry(false);
    props.onRefresh();
    if (!outcome.ok && !outcome.changed) setCountryProblem(outcome.problem);
  };
  const empty = kinCompanyEmpty(profile);
  const region = kinDeviceRegion();
  const offer =
    canEdit && waiting
      ? kinCompanyCountrySuggestion(kinCompanyDraftOf(profile, region, true), region, true)
      : null;
  return (
    <KinWorkFrame
      title={KIN_COMPANY.title}
      form={canEdit}
      onBack={() => navigation.goBack()}
      refresh={{ accessibilityLabel: "Refresh", onPress: props.onRefresh }}
    >
      <View className="flex-row items-start gap-2 px-2">
        <View className="pt-0.5">
          <KinWorkPrivateMark label="" />
        </View>
        <Text textRole="footnote" className="min-w-0 flex-1 text-foreground-muted">
          {KIN_COMPANY.private}
        </Text>
      </View>
      {canEdit && waiting ? (
        <ListSection title={KIN_MONEY.countryFirst.title}>
          {offer === null || region === null ? null : (
            <ListActionRow
              icon="globe"
              label={offer.label}
              disabled={savingCountry}
              loading={savingCountry}
              onPress={() => void saveCountry(region)}
            />
          )}
          <KinCountryPicker
            label={KIN_COMPANY.country}
            value={profile.country ?? null}
            disabled={savingCountry}
            onPick={(code) => void saveCountry(code)}
          />
          {countryProblem === null ? null : <Notice message={countryProblem} tone="danger" />}
        </ListSection>
      ) : null}
      {empty ? (
        <>
          {canEdit && !waiting ? (
            <ListSection title={KIN_COMPANY.country}>
              <KinCountryPicker
                label={KIN_COMPANY.country}
                value={profile.country ?? null}
                disabled={savingCountry}
                onPick={(code) => void saveCountry(code)}
              />
              {countryProblem === null ? null : <Notice message={countryProblem} tone="danger" />}
            </ListSection>
          ) : null}
          <EmptyState variant="plain" title={KIN_COMPANY.title} detail={KIN_COMPANY.empty} />
        </>
      ) : (
        kinCompanyGlance(profile).map((section) => (
          <ListSection key={section.title} title={section.title}>
            {section.rows.map((row) =>
              row.id === "country" && canEdit && !waiting ? (
                <View key={row.id}>
                  <KinCountryPicker
                    label={row.label}
                    value={profile.country ?? null}
                    disabled={savingCountry}
                    onPick={(code) => void saveCountry(code)}
                  />
                  {countryProblem === null ? null : (
                    <Notice message={countryProblem} tone="danger" />
                  )}
                </View>
              ) : (
                <View key={row.id} className="min-h-14 justify-center gap-1 px-4 py-3">
                  <Text className="text-sm text-foreground-muted">{row.label}</Text>
                  <Text
                    textRole="body"
                    selectable={!row.missing}
                    className={row.missing ? "text-foreground-muted" : "text-foreground"}
                  >
                    {row.value}
                  </Text>
                </View>
              ),
            )}
          </ListSection>
        ))
      )}
      <CompanyTimeZone environmentId={environmentId} orgId={orgId} />
      {canEdit ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {KIN_COMPANY.onComputer}
        </Text>
      ) : null}
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
