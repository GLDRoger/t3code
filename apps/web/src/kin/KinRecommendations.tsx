import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  KIN_RECOMMENDATIONS_COPY,
  kinRecommendationProblem,
} from "@t3tools/client-runtime/kin/kinRecommendations";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { KinRecommendationRow } from "@t3tools/contracts";
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
import type { KinWorkTarget } from "./useKinWork";

/**
 * Settings → Company → Recommendations: what Kin suggested to the owner and what came of each,
 * newest first, with Undo on a change still in effect and Ask again on a quieted one.
 */
export function KinRecommendationsSettings(props: KinWorkTarget) {
  const query = { environmentId: props.environmentId, input: { orgId: props.orgId } };
  const listAtom = kinClient.recommendations(query);
  const result = useAtomValue(listAtom);
  const refresh = useAtomRefresh(listAtom);
  const undo = useAtomCommand(kinClient.recommendationUndo, { reportFailure: false });
  const askAgain = useAtomCommand(kinClient.recommendationAskAgain, { reportFailure: false });
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const rows = Option.getOrNull(AsyncResult.value(result))?.rows ?? null;
  const act = (row: KinRecommendationRow, action: NonNullable<KinRecommendationRow["action"]>) => {
    setBusy(row.recId);
    setProblem(null);
    const run = action.kind === "undo" ? undo : askAgain;
    void run({ ...query, input: { orgId: props.orgId, recId: row.recId } }).then((outcome) => {
      setBusy(null);
      if (!AsyncResult.isSuccess(outcome))
        setProblem(kinRecommendationProblem(squashAtomCommandFailure(outcome), action.kind));
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
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy !== null}
                    onClick={() => row.action !== null && act(row, row.action)}
                  >
                    {row.action.label}
                  </Button>
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
