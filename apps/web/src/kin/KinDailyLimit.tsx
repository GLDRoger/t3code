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

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { useSearchableSetting } from "../components/settings/settingsSearch";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
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
  const searchableSetting = useSearchableSetting();
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
    <SettingsRow
      title={KIN_DAILY_LIMIT.title}
      description={failed ? KIN_DAILY_LIMIT.failed : KIN_DAILY_LIMIT.detail}
      control={
        <Select
          items={choices.map(({ value, label }) => ({ value, label }))}
          value={current}
          disabled={budget === null}
          onValueChange={(value) => {
            const picked = choices.find((choice) => choice.value === value);
            if (picked === undefined || picked.value === current) return;
            if (kinDailyLimitAsks(picked)) setAsking(picked);
            else choose(picked);
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
    >
      {used === null ? null : (
        <p className="pt-2 text-xs text-muted-foreground">
          {KIN_DAILY_LIMIT.used}: {used}
        </p>
      )}
      {waiting.length === 0 ? null : (
        <div className="pt-2 text-xs text-muted-foreground">
          <p className="font-medium text-foreground">{KIN_DAILY_LIMIT.waiting}</p>
          <ul className="pt-1">
            {waiting.map((agent) => (
              <li key={agent.agentId}>
                {agent.name}: {agent.line}
              </li>
            ))}
          </ul>
        </div>
      )}
      <AlertDialog
        open={asking !== null}
        onOpenChange={(open) => {
          if (!open) setAsking(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{KIN_DAILY_LIMIT.noneAsk.title}</AlertDialogTitle>
            <AlertDialogDescription>{KIN_DAILY_LIMIT.noneAsk.detail}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              onClick={() => {
                const picked = asking;
                setAsking(null);
                if (picked !== null) choose(picked);
              }}
            >
              {KIN_DAILY_LIMIT.noneAsk.confirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsRow>
  );
}
