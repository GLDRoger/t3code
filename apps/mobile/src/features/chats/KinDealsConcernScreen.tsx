import { type StaticScreenProps, useNavigation } from "@react-navigation/native";
import { KIN_DEALS, kinDealsNotRead, kinDealsRaised } from "@t3tools/client-runtime/kin/kinDeals";
import { KinPersonId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { useNowMinuteMs } from "../../lib/clock";
import { KinLoadFailed } from "./components/KinLoadFailed";
import { KinWorkFrame, KinWorkLoading } from "./components/KinWorkPieces";
import { KinDealRowButton } from "./KinDealsList";
import { FormMessage, NO_LINK, targetOf } from "./KinWorkFormScreens";
import { useKinWorkLink } from "./state/kinWorkLink";
import { useKinDeals } from "./state/useKinDeals";
import { useKinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";

export type KinDealsConcernParams = {
  readonly environmentId: string;
  readonly orgId: string;
  /** The label as What we hear counts it. */
  readonly concern: string;
  /** Whose deals the count was of, when the Deals tab was narrowed to one person. */
  readonly owner?: string;
};

/** The deals one concern of What we hear was raised on, as the reader sees them. */
export function KinDealsConcernScreen({ route }: StaticScreenProps<KinDealsConcernParams>) {
  const target = targetOf(route.params);
  if (target === null) return <FormMessage title={KIN_DEALS.whatWeHear}>{NO_LINK}</FormMessage>;
  return <KinDealsConcern {...target} concern={route.params.concern} owner={route.params.owner} />;
}

function KinDealsConcern(
  props: KinWorkTarget & { readonly concern: string; readonly owner: string | undefined },
) {
  const navigation = useNavigation();
  const openRecord = useKinWorkLink();
  const { environmentId, orgId, concern } = props;
  const { names } = useKinWorkDirectory({ environmentId, orgId }, true);
  const { state, refresh } = useKinDeals(props, {
    orgId,
    concern,
    ...(props.owner === undefined
      ? {}
      : { owner: { _tag: "person", personId: KinPersonId.make(props.owner) } }),
  });
  const now = new Date(useNowMinuteMs());
  const notRead = kinDealsNotRead(state);
  return (
    <KinWorkFrame title={concern} onClose={() => navigation.goBack()}>
      {state._tag === "ready" ? (
        <View className="gap-2">
          <ListSection>
            {kinDealsRaised(state.value.stages, state.value.deals, names, now).map((row) => (
              <KinDealRowButton
                key={row.key}
                inset
                row={row}
                pill={row.pill}
                onPress={() =>
                  openRecord("KinDeal", {
                    environmentId: String(environmentId),
                    orgId: String(orgId),
                    deal: row.key,
                  })
                }
              />
            ))}
            {state.value.more === 0 ? null : (
              <ListRowLayout label={KIN_DEALS.more(state.value.more)} disabled />
            )}
          </ListSection>
          <Text textRole="footnote" className="px-1 text-foreground-muted">
            {KIN_DEALS.raisedBy}
          </Text>
        </View>
      ) : state._tag === "loading" ? (
        <KinWorkLoading label={KIN_DEALS.openConcern(concern)} />
      ) : notRead !== null || state._tag !== "failed" ? (
        <EmptyState variant="plain" {...(notRead ?? KIN_DEALS.refused)} />
      ) : (
        <KinLoadFailed title={KIN_DEALS.loadFailed} cause={state.cause} onRetry={refresh} />
      )}
    </KinWorkFrame>
  );
}
