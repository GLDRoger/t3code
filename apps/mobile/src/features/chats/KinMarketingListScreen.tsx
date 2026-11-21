import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_DEALS, kinDealRow, kinDealsNotRead } from "@t3tools/client-runtime/kin/kinDeals";
import {
  KIN_MARKETING,
  kinContactListOfClients,
  kinContactListView,
} from "@t3tools/client-runtime/kin/kinMarketing";
import {
  KIN_CLIENTS_DEFAULT_FILTER,
  kinClientRow,
  kinClientsQuery,
  type KinClientsFilter,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import {
  EnvironmentId,
  KinOrgId,
  type KinContactListInput,
  type KinDealsInput,
  type KinRecordKey,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { NavigationRow } from "../../components/ui/NavigationRow";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useNowMinuteMs } from "../../lib/clock";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { KinDealRowButton } from "./KinDealsList";
import { KinExportListRow } from "./KinMarketing";
import { kinClient } from "./state/kinClient";
import { useKinDeals } from "./state/useKinDeals";
import { useKinWorkLink } from "./state/kinWorkLink";
import {
  useKinClientsList,
  useKinWork,
  useKinWorkDirectory,
  type KinWorkTarget,
} from "./state/useKinWork";

/**
 * A list: a tag's contacts, a campaign's audience, the clients that came from a campaign, or with
 * `deals` the open or won deals at them.
 */
export type KinMarketingListParams = {
  readonly environmentId: string;
  readonly orgId: string;
  readonly title: string;
  readonly tag?: string;
  readonly campaign?: string;
  readonly deals?: "open" | "won";
  /** With `cameFrom`, the clients and prospects that came from there. */
  readonly cameFrom?: string;
  readonly show?: "prospects" | "clients" | "open";
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

export function KinMarketingListScreen({ route }: StaticScreenProps<KinMarketingListParams>) {
  const navigation = useNavigation();
  const { params } = route;
  const environmentId = Option.getOrNull(decodeEnvironmentId(params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(params.orgId));
  const target = environmentId === null || orgId === null ? null : { environmentId, orgId };
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={params.title} onClose={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {target === null ? (
            <EmptyState
              variant="plain"
              title={KIN_MARKETING.listFailed}
              detail="This link doesn't name a list."
            />
          ) : params.deals !== undefined && params.campaign !== undefined ? (
            <CampaignDeals
              {...target}
              input={{
                orgId: target.orgId,
                campaign: params.campaign as KinRecordKey,
                state: params.deals,
              }}
            />
          ) : params.cameFrom !== undefined ? (
            <CameFromList
              {...target}
              filter={{
                ...KIN_CLIENTS_DEFAULT_FILTER,
                show: params.show ?? "open",
                cameFrom: params.cameFrom,
              }}
            />
          ) : (
            <ContactList
              {...target}
              input={
                params.campaign !== undefined
                  ? { orgId: target.orgId, campaign: params.campaign }
                  : { orgId: target.orgId, tag: params.tag ?? "" }
              }
            />
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function ContactList(props: KinWorkTarget & { readonly input: KinContactListInput }) {
  const navigation = useNavigation();
  const result = useAtomValue(
    kinClient.workContactList({ environmentId: props.environmentId, input: props.input }),
  );
  const list = Option.getOrNull(AsyncResult.value(result));
  if (list === null)
    return AsyncResult.isFailure(result) ? (
      <EmptyState
        variant="plain"
        title={KIN_MARKETING.listFailed}
        detail={kinFailureText(Cause.squash(result.cause), "").trim()}
      />
    ) : (
      <View className="items-center py-12">
        <AppActivityIndicator />
      </View>
    );
  const view = kinContactListView(list);
  return (
    <>
      <ListSection>
        <KinExportListRow {...props} />
      </ListSection>
      <ListSection
        title={view.count}
        footer={[view.note, view.more].filter((line) => line !== null).join(" ") || undefined}
      >
        {view.rows.length === 0 ? (
          <EmptyState
            variant="plain"
            title={KIN_MARKETING.listEmpty}
            detail={KIN_MARKETING.listEmptyDetail}
          />
        ) : (
          view.rows.map((row) => (
            <NavigationRow
              key={row.key}
              title={row.name}
              subtitle={[row.line, row.reach]
                .filter((part) => part !== null && part !== "")
                .join("\n")}
              onPress={() =>
                navigation.navigate("KinClient", {
                  environmentId: props.environmentId,
                  orgId: props.orgId,
                  party: row.party,
                })
              }
            />
          ))
        )}
      </ListSection>
    </>
  );
}

function CampaignDeals(props: KinWorkTarget & { readonly input: KinDealsInput }) {
  const openRecord = useKinWorkLink();
  const directory = useKinWorkDirectory(props, true);
  const now = new Date(useNowMinuteMs());
  const { state, refresh } = useKinDeals(props, props.input);
  if (state._tag === "loading")
    return (
      <View className="items-center py-12">
        <AppActivityIndicator />
      </View>
    );
  if (state._tag !== "ready") {
    const notRead = kinDealsNotRead(state);
    return notRead !== null || state._tag !== "failed" ? (
      <EmptyState variant="plain" {...(notRead ?? KIN_DEALS.refused)} />
    ) : (
      <KinLoadFailed title={KIN_DEALS.loadFailed} cause={state.cause} onRetry={refresh} />
    );
  }
  const { deals, more } = state.value;
  return (
    <ListSection>
      {deals.length === 0 ? (
        <ListRowLayout label={KIN_MARKETING.dealsEmpty} disabled />
      ) : (
        deals.map((deal) => (
          <KinDealRowButton
            key={deal.key}
            inset
            row={kinDealRow(deal, directory.names, now)}
            onPress={() =>
              openRecord("KinDeal", {
                environmentId: props.environmentId,
                orgId: props.orgId,
                deal: deal.key,
              })
            }
          />
        ))
      )}
      {more === 0 ? null : <ListRowLayout label={`${more} more`} disabled />}
    </ListSection>
  );
}

function CameFromList(props: KinWorkTarget & { readonly filter: KinClientsFilter }) {
  const navigation = useNavigation();
  const work = useKinWork(props);
  const directory = useKinWorkDirectory(props, true);
  const now = new Date(useNowMinuteMs());
  const { state } = useKinClientsList(
    props,
    work._tag === "ready" && !work.stale ? work.live.seq : null,
    props.filter,
  );
  if (state.loading)
    return (
      <View className="items-center py-12">
        <AppActivityIndicator />
      </View>
    );
  return (
    <>
      <ListSection>
        <KinExportListRow
          {...props}
          input={kinContactListOfClients(kinClientsQuery(props.orgId, props.filter))}
        />
      </ListSection>
      <ListSection>
        {state.records.length === 0 ? (
          <EmptyState
            variant="plain"
            title={KIN_MARKETING.cameFromEmpty}
            detail={KIN_MARKETING.cameFromEmptyDetail}
          />
        ) : (
          state.records.map((record) => {
            const row = kinClientRow(record, directory.names, now);
            return (
              <NavigationRow
                key={row.key}
                title={row.name}
                subtitle={[
                  [row.mark, row.line].filter((part) => part !== null).join(" · "),
                  row.next,
                ]
                  .filter((part) => part !== null && part !== "")
                  .join("\n")}
                onPress={() =>
                  navigation.navigate("KinClient", {
                    environmentId: props.environmentId,
                    orgId: props.orgId,
                    party: row.key,
                  })
                }
              />
            );
          })
        )}
      </ListSection>
    </>
  );
}
