import { KIN_RETRY, KIN_CHECK_CONNECTION } from "@t3tools/client-runtime/kin/kinAnswers";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_CURRENCY,
  kinInvoiceCurrency,
  kinRateInput,
  kinRateLine,
  kinSettled,
  type KinRateDraft,
  type KinRates,
} from "@t3tools/client-runtime/kin/kinCurrency";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import {
  EnvironmentId,
  KinOrgId,
  type KinCompanyProfile,
  type KinRecordDetail,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { cn } from "../../lib/cn";
import { useAtomCommand } from "../../state/use-atom-command";
import { KinWorkTextField } from "./components/KinWorkPieces";
import { kinClient } from "./state/kinClient";
import { useKinCompanyProfile } from "./state/useKinMoney";
import { kinHostConnected } from "./state/useKinHost";
import type { KinWorkTarget } from "./state/useKinWork";

/** "about ₹x" in a quieter style; a tap says what rate and day it is from. */
export function KinEstimateText(props: {
  readonly text: string;
  readonly basis: string | ReadonlyArray<string>;
  readonly align?: "start" | "end";
}) {
  const basis = typeof props.basis === "string" ? props.basis : props.basis.join("\n");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.text}, ${KIN_CURRENCY.estimate.toLowerCase()}`}
      accessibilityHint="Says which rate it uses"
      hitSlop={6}
      onPress={() => Alert.alert(KIN_CURRENCY.estimate, `${basis}\n\n${KIN_CURRENCY.exactStays}`)}
      className={cn("active:opacity-60", props.align === "end" && "items-end")}
    >
      <Text textRole="footnote" className="tabular-nums text-foreground-muted">
        {props.text}
      </Text>
    </Pressable>
  );
}

/** "Set a rate for USD": no estimate is shown without one, so this is the way to get it. */
export function KinSetRateLink(
  props: KinWorkTarget & { readonly currencies: ReadonlyArray<string> },
) {
  const navigation = useNavigation();
  const allowed = useAtomValue(kinClient.companyProfileSet.permissionAtom(props.environmentId));
  const first = props.currencies[0];
  if (!allowed || first === undefined) return null;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() =>
        navigation.navigate("KinRates", {
          environmentId: String(props.environmentId),
          orgId: String(props.orgId),
          currency: first,
        })
      }
      className="min-h-8 justify-center active:opacity-60"
    >
      <Text textRole="footnote" className="font-t3-medium text-accent-foreground">
        {`${KIN_CURRENCY.setRate} for ${props.currencies.join(" and ")}`}
      </Text>
    </Pressable>
  );
}

export type KinRatesParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly currency?: string;
  readonly rate?: string;
  readonly asOf?: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);
const pad = (value: number) => String(value).padStart(2, "0");
const todayDay = () => {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
};

function Frame(props: { readonly onClose: () => void; readonly children: React.ReactNode }) {
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={KIN_CURRENCY.rates} onClose={props.onClose} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {props.children}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

/** The owner's rates for estimates: one per currency, each with the day it was true. */
export function KinRatesScreen({ route }: StaticScreenProps<KinRatesParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  const close = () => navigation.goBack();
  const profile = useKinCompanyProfile(
    { environmentId: environmentId ?? ("" as EnvironmentId), orgId: orgId ?? ("" as KinOrgId) },
    environmentId !== null && orgId !== null,
  );
  if (environmentId === null || orgId === null)
    return (
      <Frame onClose={close}>
        <EmptyState
          variant="plain"
          title="This link doesn't name a company"
          detail="Open Money from Kin."
        />
      </Frame>
    );
  const { state } = profile;
  if (state._tag !== "ready")
    return (
      <Frame onClose={close}>
        {state._tag === "loading" ? (
          <View className="items-center py-12">
            <AppActivityIndicator />
          </View>
        ) : (
          <EmptyState
            variant="plain"
            title="Couldn't load the rates"
            detail={KIN_CHECK_CONNECTION}
            action={<Button tone="secondary" label={KIN_RETRY} onPress={profile.refresh} />}
          />
        )}
      </Frame>
    );
  return (
    <Frame onClose={close}>
      <KinRatesForm
        environmentId={environmentId}
        orgId={orgId}
        profile={state.value}
        start={{
          currency: route.params.currency ?? "USD",
          rate: route.params.rate ?? "",
          asOf: route.params.asOf ?? todayDay(),
        }}
      />
    </Frame>
  );
}

function KinRatesForm(
  props: KinWorkTarget & { readonly profile: KinCompanyProfile; readonly start: KinRateDraft },
) {
  const { environmentId, orgId, profile } = props;
  const set = useAtomCommand(kinClient.companyProfileSet, { reportFailure: false });
  const canEdit = useAtomValue(kinClient.companyProfileSet.permissionAtom(environmentId));
  const [draft, setDraft] = useState<KinRateDraft>(() => {
    const held = profile.rates.find((one) => one.currency === props.start.currency);
    return props.start.rate === "" && held !== undefined ? { ...held } : props.start;
  });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const send = async (next: KinRateDraft, remove: boolean) => {
    const made = kinRateInput(orgId, profile, next, remove);
    if ("problem" in made) return setProblem(made.problem);
    setSaving(true);
    setProblem(null);
    setSaved(null);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => set({ environmentId, input: made.input }),
    });
    setSaving(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    setSaved(
      remove
        ? `Removed the ${next.currency} rate.`
        : `Saved the ${next.currency.toUpperCase()} rate.`,
    );
  };
  return (
    <>
      <Text textRole="footnote" className="px-2 text-foreground-muted">
        {KIN_CURRENCY.ratesDetail}
      </Text>
      {problem === null ? null : <ErrorBanner message={problem} />}
      {saved === null ? null : (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {saved}
        </Text>
      )}
      <ListSection title={`${KIN_CURRENCY.homeCurrency}: ${profile.homeCurrency}`}>
        {profile.rates.length === 0 ? (
          <Text textRole="body" className="px-4 py-3 text-foreground-muted">
            {KIN_CURRENCY.noRates}
          </Text>
        ) : (
          profile.rates.map((rate) => (
            <View
              key={rate.currency}
              className="min-h-12 flex-row items-center gap-3 bg-grouped-card px-4 py-2"
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Change the ${rate.currency} rate`}
                onPress={() => setDraft({ ...rate })}
                className="min-w-0 flex-1 gap-0.5 active:opacity-60"
              >
                <Text textRole="body" className="text-foreground">
                  {rate.currency}
                </Text>
                <Text textRole="footnote" className="text-foreground-muted">
                  {kinRateLine(rate, profile.homeCurrency)}
                </Text>
              </Pressable>
              {canEdit ? (
                <Button
                  tone="secondary"
                  size="compact"
                  label="Remove"
                  disabled={saving}
                  onPress={() => void send(rate, true)}
                />
              ) : null}
            </View>
          ))
        )}
      </ListSection>
      {canEdit ? (
        <ListSection title={KIN_CURRENCY.setRate}>
          <KinWorkTextField
            label="Currency"
            value={draft.currency}
            maxLength={3}
            keyboard="plain"
            disabled={saving}
            onChangeText={(currency) => setDraft({ ...draft, currency: currency.toUpperCase() })}
          />
          <KinWorkTextField
            label={`${profile.homeCurrency} for 1 ${draft.currency || "unit"}`}
            value={draft.rate}
            keyboard="numbers"
            disabled={saving}
            onChangeText={(rate) => setDraft({ ...draft, rate })}
          />
          <KinWorkTextField
            label={KIN_CURRENCY.asOf}
            value={draft.asOf}
            placeholder="YYYY-MM-DD"
            keyboard="plain"
            disabled={saving}
            onChangeText={(asOf) => setDraft({ ...draft, asOf })}
          />
        </ListSection>
      ) : null}
      {canEdit ? (
        <Button
          tone="primary"
          label={KIN_CURRENCY.save}
          loading={saving}
          disabled={saving}
          onPress={() => void send(draft, false)}
        />
      ) : null}
    </>
  );
}

const noBankAtom: ReturnType<typeof kinClient.workItem> = Atom.make(AsyncResult.initial());

/**
 * A foreign-currency invoice's currency, said at the top, with what it is about worth at home and,
 * once a bank row settled it, the rupees that actually came in and how far they were from the estimate.
 */
export function KinInvoiceCurrency(
  props: KinWorkTarget & {
    readonly item: Pick<KinRecordDetail, "amount" | "links" | "balance">;
    readonly rates: KinRates | null;
    readonly settled: boolean;
  },
) {
  const navigation = useNavigation();
  const { environmentId, orgId, rates } = props;
  const view = kinInvoiceCurrency(props.item, rates);
  const bankAtom =
    view?.bank == null
      ? noBankAtom
      : kinClient.workItem({ environmentId, input: { orgId, key: view.bank } });
  const bank = Option.getOrNull(AsyncResult.value(useAtomValue(bankAtom)));
  const canSet = useAtomValue(kinClient.companyProfileSet.permissionAtom(environmentId));
  if (view === null || props.item.amount === undefined) return null;
  const bankDay = bank?.dateAt?.slice(0, 10) ?? null;
  const settled =
    bank?.amount === undefined || bankDay === null
      ? null
      : kinSettled(props.item.amount, bank.amount, bankDay, rates);
  return (
    <View className="gap-1 rounded-2xl bg-grouped-card px-4 py-3">
      <Text textRole="body" className="font-t3-medium text-foreground">
        {view.label}
      </Text>
      {view.estimate === null ? (
        <View className="flex-row flex-wrap items-center gap-x-2">
          <Text textRole="footnote" className="text-foreground-muted">
            {KIN_CURRENCY.noRate(view.currency)}
          </Text>
          <KinSetRateLink
            environmentId={environmentId}
            orgId={orgId}
            currencies={[view.currency]}
          />
        </View>
      ) : (
        <KinEstimateText text={`Total ${view.estimate.text}`} basis={view.estimate.basis} />
      )}
      {settled === null ? (
        props.settled ? (
          <Text textRole="footnote" className="text-foreground-muted">
            {KIN_CURRENCY.paidUnlinked(view.currency, view.home)}
          </Text>
        ) : null
      ) : (
        <View className="gap-1 pt-1">
          <Text textRole="footnote" className="text-foreground">
            {`Received ${settled.received}, ${settled.implied}.`}
          </Text>
          {settled.difference === null ? null : (
            <Text textRole="footnote" className="text-foreground-muted">
              {settled.difference}
            </Text>
          )}
          {canSet ? (
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                navigation.navigate("KinRates", {
                  environmentId: String(environmentId),
                  orgId: String(orgId),
                  ...settled.impliedRate,
                })
              }
              className="min-h-8 justify-center self-start active:opacity-60"
            >
              <Text textRole="footnote" className="font-t3-medium text-accent-foreground">
                {KIN_CURRENCY.rateForEstimates}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
    </View>
  );
}
