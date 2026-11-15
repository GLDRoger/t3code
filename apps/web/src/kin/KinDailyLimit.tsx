import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { KIN_DAILY_LIMIT, kinDailyLimitChoices } from "@t3tools/client-runtime/kin/kinBudget";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useAtomCommand } from "../state/use-atom-command";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { kinClient } from "./kinClient";
import { useKinHost } from "./useKinHost";
import type { KinWorkTarget } from "./useKinWork";

/** The owner's daily limit, one choice in Settings; nothing shows where there is no Kin to set. */
export function KinDailyLimitSetting() {
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? null : (
    <SettingsSection {...searchableSetting("kin-daily-limit")} hideTitle>
      <DailyLimit {...target} />
    </SettingsSection>
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
  const budget = Option.getOrNull(AsyncResult.value(result));
  const { choices, current } = kinDailyLimitChoices(budget);
  return (
    <SettingsRow
      title={KIN_DAILY_LIMIT.title}
      description={failed ? KIN_DAILY_LIMIT.failed : KIN_DAILY_LIMIT.detail}
      control={
        <Select
          items={choices.map(({ value, label }) => ({ value, label }))}
          value={current}
          disabled={!canSet || budget === null}
          onValueChange={(value) => {
            const picked = choices.find((choice) => choice.value === value);
            if (picked === undefined || picked.value === current) return;
            setFailed(false);
            void set({ ...query, input: { orgId: props.orgId, limits: picked.limits } }).then(
              (outcome) => {
                setFailed(AsyncResult.isFailure(outcome));
                refresh();
              },
            );
          }}
        >
          <SelectTrigger size="xs" className="w-48" aria-label={KIN_DAILY_LIMIT.title}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {choices.map(({ value, label }) => (
              <SelectItem key={value} value={value}>
                {label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
