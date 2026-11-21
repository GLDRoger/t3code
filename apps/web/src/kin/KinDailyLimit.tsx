import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  KIN_DAILY_LIMIT,
  type KinDailyLimitChoice,
  kinDailyLimitAsks,
  kinDailyLimitChoices,
  kinDailyLimitUsed,
  kinDailyLimitWaiting,
} from "@t3tools/client-runtime/kin/kinBudget";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { useSearchableSetting } from "../components/settings/settingsSearch";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { kinClient } from "./kinClient";
import { KinSettingsChoice } from "./settings/KinSettingsControls";
import { KinSettingsRow, KinSettingsStatus } from "./settings/KinSettingsLayout";
import { useKinHost } from "./useKinHost";
import type { KinWorkTarget } from "./useKinWork";

/** The owner's daily limit, one row with one choice; nothing shows where there is no Kin to set. */
export function KinDailyLimitSetting() {
  const searchableSetting = useSearchableSetting();
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? null : (
    <div id={searchableSetting("kin-daily-limit").id} tabIndex={-1} className="outline-none">
      <DailyLimit {...target} />
    </div>
  );
}

function DailyLimit(props: KinWorkTarget) {
  const query = { environmentId: props.environmentId, input: { orgId: props.orgId } };
  const budgetAtom = kinClient.budget(query);
  const result = useAtomValue(budgetAtom);
  const refresh = useAtomRefresh(budgetAtom);
  const canSet = useAtomValue(kinClient.budgetSet.permissionAtom(props.environmentId));
  const set = useAtomCommand(kinClient.budgetSet, { reportFailure: false });
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState<KinDailyLimitChoice | null>(null);
  const budget = Option.getOrNull(AsyncResult.value(result));
  // Only the owner reads the limit; a teammate's read is refused, so there is nothing to show.
  if (!canSet || AsyncResult.isFailure(result)) return null;
  const { choices, current } = kinDailyLimitChoices(budget);
  const waiting = kinDailyLimitWaiting(budget);
  const used = kinDailyLimitUsed(budget);
  const choose = (picked: KinDailyLimitChoice) => {
    setFailed(false);
    void set({ ...query, input: { orgId: props.orgId, limits: picked.limits } }).then((outcome) => {
      setFailed(AsyncResult.isFailure(outcome));
      refresh();
    });
  };
  return (
    <>
      <KinSettingsRow
        title={KIN_DAILY_LIMIT.title}
        detail={
          failed ? (
            <span role="alert" className="text-destructive-foreground">
              {KIN_DAILY_LIMIT.failed}
            </span>
          ) : waiting.length > 0 ? (
            `${KIN_DAILY_LIMIT.waiting}: ${waiting.map((agent) => `${agent.name}, ${agent.line}`).join("; ")}`
          ) : used === null ? (
            KIN_DAILY_LIMIT.detail
          ) : (
            `${KIN_DAILY_LIMIT.used}: ${used}`
          )
        }
        status={
          waiting.length === 0 ? null : (
            <KinSettingsStatus tone="attention">{KIN_DAILY_LIMIT.reached}</KinSettingsStatus>
          )
        }
        control={
          budget === null ? null : (
            <KinSettingsChoice
              label={KIN_DAILY_LIMIT.title}
              value={current}
              options={choices.map(({ value, label }) => ({ value, label }))}
              onChange={(value) => {
                const picked = choices.find((choice) => choice.value === value);
                if (picked === undefined) return;
                if (kinDailyLimitAsks(picked)) setAsking(picked);
                else choose(picked);
              }}
            />
          )
        }
      />
      <KinConfirm
        ask={
          asking === null
            ? null
            : {
                title: KIN_DAILY_LIMIT.noneAsk.title,
                detail: KIN_DAILY_LIMIT.noneAsk.detail,
                action: KIN_DAILY_LIMIT.noneAsk.confirm,
              }
        }
        onConfirm={() => {
          const picked = asking;
          setAsking(null);
          if (picked !== null) choose(picked);
        }}
        onClose={() => setAsking(null)}
      />
    </>
  );
}
