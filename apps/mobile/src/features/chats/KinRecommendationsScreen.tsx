import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  KIN_RECOMMENDATIONS_COPY,
  kinRecommendationProblem,
} from "@t3tools/client-runtime/kin/kinRecommendations";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { EnvironmentId, KinOrgId, type KinRecommendationRow } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { appAtomRegistry } from "../../state/atom-registry";
import { KinLoadFailedRow } from "./components/KinLoadFailed";
import { kinClient } from "./state/kinClient";

export type KinRecommendationsParams = {
  readonly environmentId: string;
  readonly orgId: string;
};

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeOrgId = Schema.decodeUnknownOption(KinOrgId);

/** Settings → Recommendations: what Kin suggested to the owner and what came of each. */
export function KinRecommendationsScreen({ route }: StaticScreenProps<KinRecommendationsParams>) {
  const navigation = useNavigation();
  const environmentId = Option.getOrNull(decodeEnvironmentId(route.params.environmentId));
  const orgId = Option.getOrNull(decodeOrgId(route.params.orgId));
  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar title={KIN_RECOMMENDATIONS_COPY.title} onBack={() => navigation.goBack()} />
      <ScreenContent surface="screen">
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{ padding: 16, paddingBottom: 32, gap: 20 }}
        >
          {environmentId === null || orgId === null ? (
            <EmptyState
              variant="plain"
              title="This link doesn't open anything"
              detail="Open Recommendations from Settings."
            />
          ) : (
            <KinRecommendationList environmentId={environmentId} orgId={orgId} />
          )}
        </ScreenScrollView>
      </ScreenContent>
    </View>
  );
}

function KinRecommendationList(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const query = { environmentId: props.environmentId, input: { orgId: props.orgId } };
  const atom = kinClient.recommendations(query);
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const rows = Option.getOrNull(AsyncResult.value(result))?.rows ?? null;
  const act = (row: KinRecommendationRow, action: NonNullable<KinRecommendationRow["action"]>) => {
    setBusy(row.recId);
    setProblem(null);
    void runAtomCommand(
      appAtomRegistry,
      action.kind === "undo" ? kinClient.recommendationUndo : kinClient.recommendationAskAgain,
      { ...query, input: { orgId: props.orgId, recId: row.recId } },
      { reportFailure: false, reportDefect: true },
    ).then((outcome) => {
      setBusy(null);
      if (AsyncResult.isFailure(outcome))
        setProblem(kinRecommendationProblem(squashAtomCommandFailure(outcome), action.kind));
      refresh();
    });
  };
  return (
    <>
      {problem === null ? null : <ErrorBanner message={problem} />}
      <ListSection footer={KIN_RECOMMENDATIONS_COPY.footer}>
        {rows === null ? (
          AsyncResult.isFailure(result) ? (
            <KinLoadFailedRow
              title={KIN_RECOMMENDATIONS_COPY.loadFailed}
              cause={result}
              onRetry={refresh}
            />
          ) : (
            <View className="items-center py-6">
              <AppActivityIndicator />
            </View>
          )
        ) : rows.length === 0 ? (
          <View className="px-4 py-3">
            <Text textRole="body" className="text-foreground-muted">
              {KIN_RECOMMENDATIONS_COPY.empty}
            </Text>
          </View>
        ) : (
          rows.map((row, index) => (
            <View
              key={row.recId}
              className={
                index === 0 ? "gap-1 px-4 py-3" : "gap-1 border-t border-border-subtle px-4 py-3"
              }
            >
              <Text textRole="body">{row.noticed}</Text>
              <Text textRole="footnote" className="text-foreground-muted">
                {row.outcome}
              </Text>
              {row.action === null ? null : (
                <View className="flex-row pt-1">
                  <Button
                    tone="outline"
                    size="compact"
                    label={row.action.label}
                    loading={busy === row.recId}
                    disabled={busy !== null}
                    onPress={() => row.action !== null && act(row, row.action)}
                  />
                </View>
              )}
            </View>
          ))
        )}
      </ListSection>
    </>
  );
}
