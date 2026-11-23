import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  KIN_RECOMMENDATIONS_COPY,
  kinRecommendationProblem,
} from "@t3tools/client-runtime/kin/kinRecommendations";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { KinRecommendationAction, KinRecommendationRow } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Button } from "../components/ui/button";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { withKinAgentPage } from "./kinPlaces";
import { openKinSettings } from "./kinSettingsAddress";
import {
  KinSettingsEmpty,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsPage,
  KinSettingsRow,
  KinSettingsSection,
} from "./settings/KinSettingsLayout";
import type { KinWorkTarget } from "./useKinWork";

/**
 * Settings → Company → Recommendations: what Kin suggested to the owner and what came of each,
 * newest first. A done one opens where its setting lives; a quieted one offers Ask again.
 */
export function KinRecommendationsSettings(props: KinWorkTarget) {
  const query = { environmentId: props.environmentId, input: { orgId: props.orgId } };
  const listAtom = kinClient.recommendations(query);
  const result = useAtomValue(listAtom);
  const refresh = useAtomRefresh(listAtom);
  const askAgain = useAtomCommand(kinClient.recommendationAskAgain, { reportFailure: false });
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const rows = Option.getOrNull(AsyncResult.value(result))?.rows ?? null;
  const ask = (row: KinRecommendationRow) => {
    setBusy(row.recId);
    setProblem(null);
    void askAgain({ ...query, input: { orgId: props.orgId, recId: row.recId } }).then((outcome) => {
      setBusy(null);
      if (!AsyncResult.isSuccess(outcome))
        setProblem(kinRecommendationProblem(squashAtomCommandFailure(outcome)));
      refresh();
    });
  };
  // A done row opens where its setting lives: the agent's page over the Kin page, as Agents does,
  // or another page of Settings (a connection opens at itself).
  const open = (action: KinRecommendationAction) => {
    if (action.kind === "open_daily_limit")
      return openKinSettings(router.history, "company", undefined, "kin-daily-limit");
    if (action.kind === "open_connection")
      return openKinSettings(router.history, "connections", action.connectionId);
    if (action.kind === "open_agent") {
      const { agentId } = action;
      void router.navigate({ to: ".", search: (prev) => withKinAgentPage(prev, agentId) });
    }
  };
  return (
    <KinSettingsPage purpose={KIN_RECOMMENDATIONS_COPY.purpose}>
      <KinSettingsSection problem={problem}>
        {rows === null ? (
          AsyncResult.isFailure(result) ? (
            <KinSettingsLoadFailed onRetry={refresh}>
              {KIN_RECOMMENDATIONS_COPY.loadFailed}
            </KinSettingsLoadFailed>
          ) : (
            <KinSettingsLoading rows={2} />
          )
        ) : rows.length === 0 ? (
          <KinSettingsEmpty>{KIN_RECOMMENDATIONS_COPY.settingsEmpty}</KinSettingsEmpty>
        ) : (
          rows.map((row) => {
            const action = row.action;
            const opens = action !== null && action.kind !== "ask_again";
            return (
              <KinSettingsRow
                key={row.recId}
                wrap
                title={row.noticed}
                detail={row.outcome}
                {...(opens ? { openLabel: action.label, onOpen: () => open(action) } : {})}
                control={
                  action?.kind === "ask_again" ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy !== null}
                      aria-busy={busy === row.recId}
                      onClick={() => ask(row)}
                    >
                      {action.label}
                    </Button>
                  ) : null
                }
              />
            );
          })
        )}
      </KinSettingsSection>
    </KinSettingsPage>
  );
}
