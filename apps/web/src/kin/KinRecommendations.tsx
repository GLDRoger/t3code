import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  KIN_RECOMMENDATIONS_COPY,
  kinRecommendationProblem,
} from "@t3tools/client-runtime/kin/kinRecommendations";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { KinRecommendationAction, KinRecommendationRow } from "@t3tools/contracts";
import { Link, useRouter } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader } from "../components/ui/empty";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient } from "./kinClient";
import { withKinAgentPage } from "./kinPlaces";
import { openKinSettings } from "./kinSettingsAddress";
import type { KinWorkTarget } from "./useKinWork";

/**
 * Settings → Company → Recommendations: what Kin suggested to the owner and what came of each,
 * newest first, with the agent's page on a change still in effect and Ask again on a quieted one.
 */
export function KinRecommendationsSettings(props: KinWorkTarget) {
  const query = { environmentId: props.environmentId, input: { orgId: props.orgId } };
  const listAtom = kinClient.recommendations(query);
  const result = useAtomValue(listAtom);
  const refresh = useAtomRefresh(listAtom);
  const askAgain = useAtomCommand(kinClient.recommendationAskAgain, { reportFailure: false });
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
  return (
    <SettingsPageContainer>
      <SettingsSection title={KIN_RECOMMENDATIONS_COPY.title} hideTitle>
        {rows === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {AsyncResult.isFailure(result) ? KIN_RECOMMENDATIONS_COPY.loadFailed : "Loading…"}
          </p>
        ) : rows.length === 0 ? (
          <Empty size="compact">
            <EmptyHeader>
              <EmptyDescription>{KIN_RECOMMENDATIONS_COPY.empty}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          rows.map((row) => (
            <SettingsRow
              key={row.recId}
              title={row.noticed}
              description={row.outcome}
              control={
                row.action === null ? null : (
                  <RowAction
                    action={row.action}
                    disabled={busy !== null}
                    onAskAgain={() => ask(row)}
                  />
                )
              }
            />
          ))
        )}
      </SettingsSection>
      {problem === null ? null : (
        <p role="alert" className="text-xs text-destructive-foreground">
          {problem}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{KIN_RECOMMENDATIONS_COPY.footer}</p>
    </SettingsPageContainer>
  );
}

/**
 * A done row opens where its setting lives: the agent's page, over the Kin page under Settings as
 * Agents does, or another section of Settings (a connection opens at itself).
 */
function RowAction(props: {
  readonly action: KinRecommendationAction;
  readonly disabled: boolean;
  readonly onAskAgain: () => void;
}) {
  const { action } = props;
  const router = useRouter();
  if (action.kind === "open_daily_limit" || action.kind === "open_connection")
    return (
      <Button
        size="xs"
        variant="outline"
        onClick={() =>
          action.kind === "open_daily_limit"
            ? openKinSettings(router.history, "company")
            : openKinSettings(router.history, "connections", action.connectionId)
        }
      >
        {action.label}
      </Button>
    );
  if (action.kind === "open_agent") {
    const { agentId } = action;
    return (
      <Button
        size="xs"
        variant="outline"
        render={<Link to="." search={(prev) => withKinAgentPage(prev, agentId)} />}
      >
        {action.label}
      </Button>
    );
  }
  return (
    <Button size="xs" variant="outline" disabled={props.disabled} onClick={props.onAskAgain}>
      {action.label}
    </Button>
  );
}
