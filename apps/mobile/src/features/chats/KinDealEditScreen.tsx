import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_DEALS,
  kinDealEditDraft,
  kinDealEditRequest,
  kinDealQuoteChoices,
  type KinDealEditDraft,
} from "@t3tools/client-runtime/kin/kinDeals";
import { KinRecordKey, type KinDealPage } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { useNowMinuteMs } from "../../lib/clock";
import { KinDayField } from "./components/KinDayField";
import { KinDealQuoteRow } from "./components/KinDealPicks";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { KinWorkFrame, KinWorkLoading, KinWorkTextField } from "./components/KinWorkPieces";
import { FormMessage, FormShell, NO_LINK, targetOf } from "./KinWorkFormScreens";
import { useKinDealPage, useKinDealSend } from "./state/useKinDeals";
import { useKinHomeCurrency } from "./state/useKinMoney";
import { useKinWorkDirectory, type KinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";

export type KinDealEditParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly deal: string;
};

const decodeKey = Schema.decodeUnknownOption(KinRecordKey);

/** Edit a deal: what, how much, when, where it came from and its quote, as the web's Edit. */
export function KinDealEditScreen({ route }: StaticScreenProps<KinDealEditParams>) {
  const target = targetOf(route.params);
  const key = Option.getOrNull(decodeKey(route.params.deal));
  if (target === null || key === null)
    return <FormMessage title={KIN_DEALS.edit}>{NO_LINK}</FormMessage>;
  return <KinDealEditLoad {...target} dealKey={key} />;
}

function KinDealEditLoad(props: KinWorkTarget & { readonly dealKey: KinRecordKey }) {
  const navigation = useNavigation();
  const target = { environmentId: props.environmentId, orgId: props.orgId };
  const { state, refresh } = useKinDealPage(target, props.dealKey);
  const directory = useKinWorkDirectory(target, true);
  if (state._tag === "ready")
    return <KinDealEditForm {...target} page={state.value} directory={directory} />;
  return (
    <KinWorkFrame title={KIN_DEALS.editTitle(props.dealKey)} onClose={() => navigation.goBack()}>
      {state._tag === "loading" ? (
        <KinWorkLoading label="Loading deal" />
      ) : state._tag === "failed" ? (
        <KinLoadFailed title={KIN_DEALS.loadFailed} cause={state.cause} onRetry={refresh} />
      ) : (
        <EmptyState variant="plain" title={KIN_DEALS.title} detail={KIN_DEALS.gone} />
      )}
    </KinWorkFrame>
  );
}

function KinDealEditForm(
  props: KinWorkTarget & { readonly page: KinDealPage; readonly directory: KinWorkDirectory },
) {
  const navigation = useNavigation();
  const { page } = props;
  const { deal } = page;
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const send = useKinDealSend(props);
  const home = useKinHomeCurrency(props) ?? null;
  const [draft, setDraft] = useState(() => kinDealEditDraft(deal, names));
  const quotes = kinDealQuoteChoices(page, draft.quote);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const request = kinDealEditRequest(deal, draft, names, home);
  const moneyBad = !request.ok && request.problem !== null;
  const set = (change: Partial<KinDealEditDraft>) => setDraft((held) => ({ ...held, ...change }));

  const save = async () => {
    if (!request.ok || saving) return;
    setSaving(true);
    setProblem(null);
    const outcome = await send.update(request.input);
    setSaving(false);
    if (!outcome.ok) return setProblem(outcome.problem);
    navigation.goBack();
  };

  return (
    <FormShell
      title={KIN_DEALS.editTitle(deal.key)}
      submit={KIN_DEALS.save}
      saving={saving}
      canSave={request.ok}
      problem={problem === null ? null : { kind: "invalid", text: problem }}
      onSave={() => void save()}
    >
      <ListSection footer={KIN_DEALS.clientStays}>
        <ListRowLayout label={KIN_DEALS.clientField} detail={deal.party.title} />
      </ListSection>
      <ListSection>
        <KinWorkTextField
          label={KIN_DEALS.what}
          value={draft.title}
          maxLength={280}
          disabled={saving}
          onChangeText={(title) => set({ title })}
        />
        <KinWorkTextField
          label={KIN_DEALS.value}
          value={draft.value}
          keyboard="numbers"
          disabled={saving}
          hint={moneyBad ? KIN_DEALS.notAmount : KIN_DEALS.valueHint}
          onChangeText={(value) => set({ value })}
        />
        <KinDayField
          label={KIN_DEALS.expected}
          day={draft.expected}
          zone={names.zone}
          now={now}
          disabled={saving}
          onPick={(expected) => set({ expected })}
        />
      </ListSection>
      <ListSection>
        <KinWorkTextField
          label={KIN_DEALS.cameFrom}
          value={draft.source}
          maxLength={120}
          disabled={saving}
          onChangeText={(source) => set({ source })}
        />
        {quotes === null ? null : (
          <KinDealQuoteRow quotes={quotes} disabled={saving} onPick={(quote) => set({ quote })} />
        )}
      </ListSection>
    </FormShell>
  );
}
