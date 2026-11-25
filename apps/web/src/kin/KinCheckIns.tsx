import { useAtomValue } from "@effect/atom-react";
import {
  KIN_CHECK_INS,
  KIN_WEEKDAYS,
  kinCheckInDraft,
  kinCheckInPipeline,
  kinCheckInLine,
  kinCoveredLine,
  kinCheckInProblem,
  type KinCheckInDraft,
} from "@t3tools/client-runtime/kin/kinCheckIns";
import { kinFormTyped } from "@t3tools/client-runtime/kin/kinWorkForms";
import type { KinCheckIn, KinCheckInActInput, KinCheckInsResult } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { useSearchableSetting } from "../components/settings/settingsSearch";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { kinClient, refreshKinBriefs } from "./kinClient";
import {
  KinSettingsField,
  KinSettingsFormDialog,
  useKinSettingsSave,
} from "./settings/KinSettingsControls";
import {
  KinSettingsEmpty,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsPage,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsStatus,
} from "./settings/KinSettingsLayout";
import { useKinHost } from "./useKinHost";
import type { KinWorkTarget } from "./useKinWork";

/** Settings → Check-ins, for the owner or a co-owner; nothing shows where there is no Kin. */
export function KinCheckInsPage() {
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? null : <CheckIns {...target} />;
}

function CheckIns(props: KinWorkTarget) {
  const searchableSetting = useSearchableSetting();
  const query = { environmentId: props.environmentId, input: { orgId: props.orgId } };
  const result = useAtomValue(kinClient.checkIns(query));
  const refresh = () => refreshKinBriefs(props.environmentId, props.orgId);
  const canRead = useAtomValue(kinClient.checkInSave.permissionAtom(props.environmentId));
  const act = useAtomCommand(kinClient.checkInAct, { reportFailure: false });
  const save = useAtomCommand(kinClient.checkInSave, { reportFailure: false });
  const saving = useKinSettingsSave();
  const [editing, setEditing] = useState<KinCheckIn | "new" | null>(null);
  const value = Option.getOrNull(AsyncResult.value(result));
  // A teammate's read is refused, so there is nothing to show them.
  if (!canRead) return null;

  const run = async (
    scheduleId: KinCheckIn["scheduleId"],
    action: KinCheckInActInput["action"],
  ) => {
    const ok = await saving.run(scheduleId, KIN_CHECK_INS.failed, () =>
      act({ ...query, input: { orgId: props.orgId, scheduleId, action } }),
    );
    refresh();
    return ok;
  };
  const canAdd = value !== null && value.agents.length > 0;

  return (
    <KinSettingsPage
      purpose={
        value === null
          ? KIN_CHECK_INS.detail
          : `${KIN_CHECK_INS.detail} ${KIN_CHECK_INS.zone(value.zone)}`
      }
      action={
        canAdd ? (
          <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
            <PlusIcon />
            {KIN_CHECK_INS.add}
          </Button>
        ) : undefined
      }
    >
      <KinSettingsSection
        searchId={searchableSetting("kin-check-ins").id}
        problem={editing === null ? saving.problem : null}
      >
        {value === null ? (
          AsyncResult.isFailure(result) ? (
            <KinSettingsLoadFailed onRetry={refresh}>
              {KIN_CHECK_INS.unreadable}
            </KinSettingsLoadFailed>
          ) : (
            <KinSettingsLoading rows={4} />
          )
        ) : value.checkIns.length === 0 ? (
          <KinSettingsEmpty>{KIN_CHECK_INS.empty}</KinSettingsEmpty>
        ) : (
          value.checkIns.map((checkIn) => (
            <KinSettingsRow
              key={checkIn.scheduleId}
              title={checkIn.title}
              detail={kinCheckInLine(checkIn)}
              openLabel={`${KIN_CHECK_INS.edit}: ${checkIn.title}`}
              onOpen={() => setEditing(checkIn)}
              status={
                checkIn.runNowPending ? (
                  <KinSettingsStatus tone="quiet">{KIN_CHECK_INS.runNowPending}</KinSettingsStatus>
                ) : checkIn.on && kinCoveredLine(checkIn) !== null ? (
                  <KinSettingsStatus tone="quiet">{KIN_CHECK_INS.coveredToday}</KinSettingsStatus>
                ) : null
              }
              control={
                <Switch
                  aria-label={`${checkIn.on ? KIN_CHECK_INS.turnOff : KIN_CHECK_INS.turnOn}: ${checkIn.title}`}
                  checked={checkIn.on}
                  disabled={saving.busy !== null}
                  onCheckedChange={(on) =>
                    void run(checkIn.scheduleId, on ? "turn_on" : "turn_off")
                  }
                />
              }
            />
          ))
        )}
      </KinSettingsSection>
      {editing === null || value === null ? null : (
        <CheckInDialog
          checkIn={editing === "new" ? null : editing}
          result={value}
          onSave={async (draft) => {
            if (draft.agentId === null) return false;
            const outcome = await save({
              ...query,
              input: {
                orgId: props.orgId,
                ...(draft.scheduleId === undefined ? {} : { scheduleId: draft.scheduleId }),
                agentId: draft.agentId,
                title: draft.title.trim(),
                what: draft.what.trim(),
                at: draft.at,
                days: draft.days,
              },
            });
            refresh();
            return AsyncResult.isSuccess(outcome);
          }}
          onRunNow={(scheduleId) => run(scheduleId, "run_now")}
          onRemove={(scheduleId) => run(scheduleId, "remove")}
          onPipeline={(scheduleId, on) => run(scheduleId, on ? "numbers_on" : "numbers_off")}
          onClose={() => setEditing(null)}
        />
      )}
    </KinSettingsPage>
  );
}

/**
 * Add a check-in, or change one's name, words, time and days; its agent stays. Everything in it,
 * the weekly brief's pipeline switch too, saves on Save.
 */
export function CheckInDialog(props: {
  readonly checkIn: KinCheckIn | null;
  readonly result: KinCheckInsResult;
  readonly onSave: (draft: KinCheckInDraft) => Promise<boolean>;
  readonly onRunNow: (scheduleId: KinCheckIn["scheduleId"]) => Promise<boolean>;
  readonly onRemove: (scheduleId: KinCheckIn["scheduleId"]) => Promise<boolean>;
  readonly onPipeline: (scheduleId: KinCheckIn["scheduleId"], on: boolean) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const { checkIn, result } = props;
  const [opened] = useState(() => kinCheckInDraft(checkIn, result.agents[0]?.agentId ?? null));
  const [draft, setDraft] = useState(opened);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [failed, setFailed] = useState(false);
  const [ran, setRan] = useState(false);
  const shownPipeline = kinCheckInPipeline(checkIn);
  const [pipeline, setPipeline] = useState(shownPipeline);
  const pipelineId = useId();
  const edit = (patch: Partial<KinCheckInDraft>) => setDraft({ ...draft, ...patch });
  const agentName = (agentId: string | null) =>
    result.agents.find((agent) => agent.agentId === agentId)?.name ?? checkIn?.agentName ?? "";
  const finish = async (work: () => Promise<boolean>) => {
    setBusy(true);
    setFailed(false);
    const ok = await work();
    setBusy(false);
    if (ok) props.onClose();
    else setFailed(true);
  };
  const submit = () =>
    finish(async () => {
      if (!(await props.onSave(draft))) return false;
      if (checkIn === null || pipeline === null || pipeline === shownPipeline) return true;
      return props.onPipeline(checkIn.scheduleId, pipeline);
    });
  return (
    <>
      <KinSettingsFormDialog
        title={checkIn === null ? KIN_CHECK_INS.add : KIN_CHECK_INS.edit}
        description={[
          KIN_CHECK_INS.zone(result.zone),
          checkIn === null ? null : kinCoveredLine(checkIn),
        ]
          .filter((line) => line !== null)
          .join(" ")}
        submitLabel={KIN_CHECK_INS.save}
        busy={busy}
        notReady={kinCheckInProblem(draft)}
        problem={failed ? KIN_CHECK_INS.failed : null}
        remove={
          checkIn === null ? undefined : (
            <Button
              type="button"
              variant="ghost-destructive"
              disabled={busy}
              onClick={() => setConfirmRemove(true)}
            >
              {KIN_CHECK_INS.remove}
            </Button>
          )
        }
        secondary={
          checkIn === null ? undefined : (
            <Button
              type="button"
              variant="outline"
              disabled={busy || ran || checkIn.runNowPending}
              onClick={async () => {
                setFailed(false);
                if (await props.onRunNow(checkIn.scheduleId)) setRan(true);
                else setFailed(true);
              }}
            >
              {ran || checkIn.runNowPending ? KIN_CHECK_INS.runNowPending : KIN_CHECK_INS.runNow}
            </Button>
          )
        }
        typed={kinFormTyped(opened, draft) || pipeline !== shownPipeline}
        onSubmit={() => void submit()}
        onClose={props.onClose}
      >
        <KinSettingsField label={KIN_CHECK_INS.name}>
          {(ids) => (
            <Input
              id={ids.control}
              value={draft.title}
              maxLength={200}
              autoComplete="off"
              onChange={(event) => edit({ title: event.target.value })}
            />
          )}
        </KinSettingsField>
        <KinSettingsField
          label={KIN_CHECK_INS.agent}
          help={checkIn === null ? undefined : KIN_CHECK_INS.agentStays}
        >
          {(ids) => (
            <Select
              value={draft.agentId ?? ""}
              disabled={checkIn !== null}
              onValueChange={(value) => {
                const agent = result.agents.find((each) => each.agentId === value);
                if (agent !== undefined) edit({ agentId: agent.agentId });
              }}
            >
              <SelectTrigger id={ids.control} className="w-full min-w-0">
                <SelectValue>{agentName(draft.agentId)}</SelectValue>
              </SelectTrigger>
              <SelectPopup alignItemWithTrigger={false}>
                {result.agents.map((agent) => (
                  <SelectItem key={agent.agentId} value={agent.agentId}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
        </KinSettingsField>
        <div className="flex flex-wrap items-start gap-4">
          <KinSettingsField label={KIN_CHECK_INS.time}>
            {(ids) => (
              <Input
                type="time"
                id={ids.control}
                nativeInput
                className="w-32"
                value={draft.at}
                onChange={(event) => edit({ at: event.target.value })}
              />
            )}
          </KinSettingsField>
          <KinSettingsField label={KIN_CHECK_INS.days}>
            {(ids) => (
              <ToggleGroup
                multiple
                variant="outline"
                size="sm"
                aria-labelledby={ids.label}
                value={draft.days.map(String)}
                onValueChange={(values) => edit({ days: values.map(Number) })}
              >
                {KIN_WEEKDAYS.map(({ day, short }) => (
                  <Toggle key={day} value={String(day)}>
                    {short}
                  </Toggle>
                ))}
              </ToggleGroup>
            )}
          </KinSettingsField>
        </div>
        {pipeline === null ? null : (
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor={pipelineId}>{KIN_CHECK_INS.pipeline}</Label>
              <p className="text-xs text-muted-foreground">{KIN_CHECK_INS.pipelineDetail}</p>
            </div>
            <Switch
              id={pipelineId}
              checked={pipeline}
              disabled={busy}
              onCheckedChange={setPipeline}
            />
          </div>
        )}
        <KinSettingsField label={KIN_CHECK_INS.what} help={KIN_CHECK_INS.whatHelp}>
          {(ids) => (
            <Textarea
              id={ids.control}
              value={draft.what}
              maxLength={2000}
              rows={4}
              onChange={(event) => edit({ what: event.target.value })}
            />
          )}
        </KinSettingsField>
      </KinSettingsFormDialog>
      <KinConfirm
        ask={
          confirmRemove && checkIn !== null
            ? {
                title: KIN_CHECK_INS.removeTitle(checkIn.title),
                detail: KIN_CHECK_INS.removeDetail,
                action: KIN_CHECK_INS.remove,
                destructive: true,
              }
            : null
        }
        onConfirm={() => {
          if (checkIn !== null) void finish(() => props.onRemove(checkIn.scheduleId));
        }}
        onClose={() => setConfirmRemove(false)}
      />
    </>
  );
}
