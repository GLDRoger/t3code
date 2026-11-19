import { useAtomValue } from "@effect/atom-react";
import {
  KIN_BRIEFS,
  KIN_CHECK_INS,
  KIN_WEEKDAYS,
  kinBriefHasDays,
  kinBriefLine,
  kinCoveredLine,
  kinBriefProblem,
  kinBriefSave,
} from "@t3tools/client-runtime/kin/kinCheckIns";
import type { EnvironmentId, KinBrief, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient, refreshKinBriefs } from "./kinClient";
import { KIN_DIALOG_PARTS } from "./kinOverlayParts";

/**
 * The briefs this person receives, their own to set: when the morning brief comes, and whether
 * and when the afternoon check-in and evening summary do. Nothing shows for who receives none.
 */
export function KinBriefsSetting(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const query = { environmentId: props.environmentId, input: { orgId: props.orgId } };
  const atom = kinClient.briefs(query);
  const result = useAtomValue(atom);
  const save = useAtomCommand(kinClient.briefSave, { reportFailure: false });
  const [editing, setEditing] = useState<KinBrief | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<KinBrief["kind"] | null>(null);
  const value = Option.getOrNull(AsyncResult.value(result));
  if (value === null ? AsyncResult.isFailure(result) : value.briefs.length === 0) return null;

  const change = async (opened: KinBrief, next: KinBrief) => {
    setBusy(next.kind);
    setFailed(false);
    const outcome = await save({
      ...query,
      input: { orgId: props.orgId, ...kinBriefSave(opened, next) },
    });
    setBusy(null);
    setFailed(AsyncResult.isFailure(outcome));
    refreshKinBriefs(props.environmentId, props.orgId);
    return AsyncResult.isSuccess(outcome);
  };

  return (
    <SettingsSection title={KIN_BRIEFS.title} hideTitle>
      <SettingsRow
        title={KIN_BRIEFS.title}
        description={
          failed ? (
            <span role="alert">{KIN_BRIEFS.failed}</span>
          ) : value === null ? (
            KIN_BRIEFS.detail
          ) : (
            `${KIN_BRIEFS.detail} ${KIN_CHECK_INS.zone(value.zone)}`
          )
        }
      />
      {value === null ? (
        <SettingsRow title={`${KIN_BRIEFS.loading}…`} />
      ) : (
        value.briefs.map((brief) => (
          <SettingsRow
            key={brief.kind}
            title={KIN_BRIEFS.titles[brief.kind]}
            description={
              <>
                {kinBriefLine(brief)}
                {kinCoveredLine(brief) === null ? null : (
                  <span className="block">{kinCoveredLine(brief)}</span>
                )}
              </>
            }
            control={
              <div className="flex items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy === brief.kind}
                  aria-label={`${KIN_BRIEFS.edit}: ${KIN_BRIEFS.titles[brief.kind]}`}
                  onClick={() => setEditing(brief)}
                >
                  {KIN_BRIEFS.edit}
                </Button>
                {kinBriefHasDays(brief.kind) ? null : (
                  <Switch
                    aria-label={`${KIN_BRIEFS.titles[brief.kind]}: ${brief.on ? KIN_BRIEFS.on : KIN_BRIEFS.off}`}
                    checked={brief.on}
                    disabled={busy === brief.kind}
                    onCheckedChange={(on) => void change(brief, { ...brief, on })}
                  />
                )}
              </div>
            }
          />
        ))
      )}
      {editing === null || value === null ? null : (
        <BriefDialog
          brief={editing}
          zone={value.zone}
          onSave={(draft) => change(editing, draft)}
          onClose={() => setEditing(null)}
        />
      )}
    </SettingsSection>
  );
}

function BriefDialog(props: {
  readonly brief: KinBrief;
  readonly zone: string;
  readonly onSave: (brief: KinBrief) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState(props.brief);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const ids = { time: useId(), days: useId() };
  const problem = kinBriefProblem(draft);
  const Parts = KIN_DIALOG_PARTS;
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
            if (problem !== null || saving) return;
            setSaving(true);
            setFailed(false);
            void props.onSave(draft).then((ok) => {
              setSaving(false);
              if (ok) props.onClose();
              else setFailed(true);
            });
          }}
        >
          <Parts.Header>
            <Parts.Title>{KIN_BRIEFS.titles[draft.kind]}</Parts.Title>
            <Parts.Description>
              {[KIN_CHECK_INS.zone(props.zone), kinCoveredLine(draft)]
                .filter((line) => line !== null)
                .join(" ")}
            </Parts.Description>
          </Parts.Header>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={ids.time}>{KIN_BRIEFS.time}</Label>
              <Input
                type="time"
                id={ids.time}
                nativeInput
                className="w-32"
                value={draft.at}
                onChange={(event) => setDraft({ ...draft, at: event.target.value })}
              />
            </div>
            {kinBriefHasDays(draft.kind) ? (
              <div className="flex flex-col gap-1.5">
                <Label id={ids.days}>{KIN_BRIEFS.days}</Label>
                <ToggleGroup
                  multiple
                  variant="outline"
                  size="sm"
                  aria-labelledby={ids.days}
                  value={draft.days.map(String)}
                  onValueChange={(values) => setDraft({ ...draft, days: values.map(Number) })}
                >
                  {KIN_WEEKDAYS.map(({ day, short }) => (
                    <Toggle key={day} value={String(day)}>
                      {short}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </div>
            ) : null}
            {failed || problem !== null ? (
              <p
                role={failed ? "alert" : undefined}
                className={
                  failed ? "text-xs text-destructive-foreground" : "text-xs text-muted-foreground"
                }
              >
                {failed ? KIN_BRIEFS.failed : problem}
              </p>
            ) : null}
          </div>
          <div className="flex items-center justify-end gap-2 border-t px-6 py-4">
            <Button type="submit" size="sm" disabled={saving || problem !== null}>
              {KIN_BRIEFS.save}
            </Button>
          </div>
        </form>
      </Parts.Popup>
    </Parts.Root>
  );
}
