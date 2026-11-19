import { useAtomValue } from "@effect/atom-react";
import {
  KIN_CHECK_INS,
  KIN_WEEKDAYS,
  kinCheckInDraft,
  kinCheckInLine,
  kinCoveredLine,
  kinCheckInProblem,
  type KinCheckInDraft,
} from "@t3tools/client-runtime/kin/kinCheckIns";
import type { KinCheckIn, KinCheckInActInput, KinCheckInsResult } from "@t3tools/contracts";
import { PlusIcon } from "lucide-react";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
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
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { kinClient, refreshKinBriefs } from "./kinClient";
import { KIN_DIALOG_PARTS, KIN_SHEET_PARTS } from "./kinOverlayParts";
import { useKinHost } from "./useKinHost";
import type { KinWorkTarget } from "./useKinWork";

/**
 * The company's check-ins, for the owner or a co-owner; nothing shows where there is no Kin.
 * Inside T3's Settings dialog the form is a dialog too: a sheet stacks under dialogs.
 */
export function KinCheckInsSetting(props: { readonly inDialog?: boolean }) {
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? null : <CheckIns {...target} inDialog={props.inDialog === true} />;
}

function CheckIns(props: KinWorkTarget & { readonly inDialog: boolean }) {
  const searchableSetting = useSearchableSetting();
  const query = { environmentId: props.environmentId, input: { orgId: props.orgId } };
  const atom = kinClient.checkIns(query);
  const result = useAtomValue(atom);
  const refresh = () => refreshKinBriefs(props.environmentId, props.orgId);
  const canRead = useAtomValue(kinClient.checkInSave.permissionAtom(props.environmentId));
  const act = useAtomCommand(kinClient.checkInAct, { reportFailure: false });
  const save = useAtomCommand(kinClient.checkInSave, { reportFailure: false });
  const [editing, setEditing] = useState<KinCheckIn | "new" | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const value = Option.getOrNull(AsyncResult.value(result));
  // A teammate's read is refused, so there is nothing to show them.
  if (!canRead || (AsyncResult.isFailure(result) && value === null)) return null;

  const run = async (
    scheduleId: KinCheckIn["scheduleId"],
    action: KinCheckInActInput["action"],
  ) => {
    setBusy(scheduleId);
    setFailed(false);
    const outcome = await act({ ...query, input: { orgId: props.orgId, scheduleId, action } });
    setBusy(null);
    setFailed(AsyncResult.isFailure(outcome));
    refresh();
    return AsyncResult.isSuccess(outcome);
  };

  return (
    <SettingsSection {...searchableSetting("kin-check-ins")} hideTitle>
      <SettingsRow
        title={KIN_CHECK_INS.title}
        description={
          failed ? (
            <span role="alert">{KIN_CHECK_INS.failed}</span>
          ) : value === null ? (
            KIN_CHECK_INS.detail
          ) : (
            `${KIN_CHECK_INS.detail} ${KIN_CHECK_INS.zone(value.zone)}`
          )
        }
        control={
          value === null || value.agents.length === 0 ? undefined : (
            <Button size="xs" variant="outline" onClick={() => setEditing("new")}>
              <PlusIcon />
              {KIN_CHECK_INS.add}
            </Button>
          )
        }
      />
      {value === null ? null : value.checkIns.length === 0 ? (
        <SettingsRow title={KIN_CHECK_INS.empty} />
      ) : (
        value.checkIns.map((checkIn) => (
          <SettingsRow
            key={checkIn.scheduleId}
            title={
              <button
                type="button"
                className="rounded-sm text-start outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                onClick={() => setEditing(checkIn)}
              >
                {checkIn.title}
              </button>
            }
            description={
              <>
                {checkIn.on
                  ? kinCheckInLine(checkIn)
                  : `${KIN_CHECK_INS.off} · ${kinCheckInLine(checkIn)}`}
                {kinCoveredLine(checkIn) === null ? null : (
                  <span className="block">{kinCoveredLine(checkIn)}</span>
                )}
              </>
            }
            control={
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy === checkIn.scheduleId || checkIn.runNowPending}
                  onClick={() => void run(checkIn.scheduleId, "run_now")}
                >
                  {checkIn.runNowPending ? KIN_CHECK_INS.runNowPending : KIN_CHECK_INS.runNow}
                </Button>
                <Switch
                  aria-label={`${checkIn.on ? KIN_CHECK_INS.turnOff : KIN_CHECK_INS.turnOn}: ${checkIn.title}`}
                  checked={checkIn.on}
                  disabled={busy === checkIn.scheduleId}
                  onCheckedChange={(on) =>
                    void run(checkIn.scheduleId, on ? "turn_on" : "turn_off")
                  }
                />
              </div>
            }
          />
        ))
      )}
      {editing === null || value === null ? null : (
        <CheckInSheet
          inDialog={props.inDialog}
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
          onRemove={(scheduleId) => run(scheduleId, "remove")}
          onClose={() => setEditing(null)}
        />
      )}
    </SettingsSection>
  );
}

/** Add a check-in, or change one's name, words, time and days; its agent stays. */
function CheckInSheet(props: {
  readonly inDialog: boolean;
  readonly checkIn: KinCheckIn | null;
  readonly result: KinCheckInsResult;
  readonly onSave: (draft: KinCheckInDraft) => Promise<boolean>;
  readonly onRemove: (scheduleId: KinCheckIn["scheduleId"]) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const { checkIn, result } = props;
  const [draft, setDraft] = useState(() =>
    kinCheckInDraft(checkIn, result.agents[0]?.agentId ?? null),
  );
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [failed, setFailed] = useState(false);
  const ids = { name: useId(), what: useId(), agent: useId(), time: useId(), days: useId() };
  const edit = (patch: Partial<KinCheckInDraft>) => setDraft({ ...draft, ...patch });
  const problem = kinCheckInProblem(draft);
  const agentName = (agentId: string | null) =>
    result.agents.find((agent) => agent.agentId === agentId)?.name ?? checkIn?.agentName ?? "";
  const finish = async (work: Promise<boolean>) => {
    setSaving(true);
    setFailed(false);
    const ok = await work;
    setSaving(false);
    if (ok) props.onClose();
    else setFailed(true);
  };
  const Parts = props.inDialog ? KIN_DIALOG_PARTS : KIN_SHEET_PARTS;
  return (
    <Parts.Root
      open
      onOpenChange={(open) => {
        if (!open && !saving) props.onClose();
      }}
    >
      <Parts.Popup>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (problem === null && !saving) void finish(props.onSave(draft));
          }}
        >
          <Parts.Header>
            <Parts.Title>{checkIn === null ? KIN_CHECK_INS.add : KIN_CHECK_INS.edit}</Parts.Title>
            <Parts.Description>
              {[KIN_CHECK_INS.zone(result.zone), checkIn === null ? null : kinCoveredLine(checkIn)]
                .filter((line) => line !== null)
                .join(" ")}
            </Parts.Description>
          </Parts.Header>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.name}>{KIN_CHECK_INS.name}</Label>
              <Input
                id={ids.name}
                value={draft.title}
                maxLength={200}
                autoComplete="off"
                onChange={(event) => edit({ title: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.agent}>{KIN_CHECK_INS.agent}</Label>
              <Select
                value={draft.agentId ?? ""}
                disabled={checkIn !== null}
                onValueChange={(value) => {
                  const agent = result.agents.find((each) => each.agentId === value);
                  if (agent !== undefined) edit({ agentId: agent.agentId });
                }}
              >
                <SelectTrigger id={ids.agent} className="w-full min-w-0">
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
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.time}>{KIN_CHECK_INS.time}</Label>
              <Input
                type="time"
                id={ids.time}
                nativeInput
                className="w-32"
                value={draft.at}
                onChange={(event) => edit({ at: event.target.value })}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label id={ids.days}>{KIN_CHECK_INS.days}</Label>
              <ToggleGroup
                multiple
                variant="outline"
                size="sm"
                aria-labelledby={ids.days}
                value={draft.days.map(String)}
                onValueChange={(values) => edit({ days: values.map(Number) })}
              >
                {KIN_WEEKDAYS.map(({ day, short }) => (
                  <Toggle key={day} value={String(day)}>
                    {short}
                  </Toggle>
                ))}
              </ToggleGroup>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.what}>{KIN_CHECK_INS.what}</Label>
              <Textarea
                id={ids.what}
                value={draft.what}
                maxLength={2000}
                rows={4}
                onChange={(event) => edit({ what: event.target.value })}
              />
            </div>
            {failed || problem !== null ? (
              <p
                role={failed ? "alert" : undefined}
                className={
                  failed ? "text-xs text-destructive-foreground" : "text-xs text-muted-foreground"
                }
              >
                {failed ? KIN_CHECK_INS.failed : problem}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2 border-t px-6 py-4">
            {checkIn === null ? null : confirmRemove ? (
              <div className="me-auto flex items-center gap-2">
                <span className="text-xs text-muted-foreground">{KIN_CHECK_INS.removeConfirm}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={saving}
                  onClick={() => void finish(props.onRemove(checkIn.scheduleId))}
                >
                  {KIN_CHECK_INS.remove}
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="destructive-outline"
                className="me-auto"
                disabled={saving}
                onClick={() => setConfirmRemove(true)}
              >
                {KIN_CHECK_INS.remove}
              </Button>
            )}
            <Button type="submit" size="sm" disabled={saving || problem !== null}>
              {KIN_CHECK_INS.save}
            </Button>
          </div>
        </form>
      </Parts.Popup>
    </Parts.Root>
  );
}
