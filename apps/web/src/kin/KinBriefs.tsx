import { useAtomValue } from "@effect/atom-react";
import {
  KIN_BRIEFS,
  KIN_CHECK_INS,
  KIN_WEEKDAYS,
  kinBriefHasDays,
  kinBriefLine,
  kinBriefTitle,
  kinBriefTurnsOff,
  kinCoveredLine,
  kinBriefProblem,
  kinBriefSave,
} from "@t3tools/client-runtime/kin/kinCheckIns";
import type { EnvironmentId, KinBrief, KinOrgId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { Toggle, ToggleGroup } from "../components/ui/toggle-group";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient, refreshKinBriefs } from "./kinClient";
import {
  KinSettingsField,
  KinSettingsFormDialog,
  useKinSettingsSave,
} from "./settings/KinSettingsControls";
import {
  KinSettingsLoading,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsStatus,
} from "./settings/KinSettingsLayout";

/**
 * The briefs this person receives, their own to set: when the morning brief comes, and whether
 * and when the afternoon check-in and evening summary do, or a teammate's own morning page.
 * Nothing shows for who receives none.
 */
export function KinBriefsSetting(props: {
  readonly environmentId: EnvironmentId;
  readonly orgId: KinOrgId;
}) {
  const query = { environmentId: props.environmentId, input: { orgId: props.orgId } };
  const atom = kinClient.briefs(query);
  const result = useAtomValue(atom);
  const save = useAtomCommand(kinClient.briefSave, { reportFailure: false });
  const saving = useKinSettingsSave();
  const [editing, setEditing] = useState<KinBrief | null>(null);
  const value = Option.getOrNull(AsyncResult.value(result));
  if (value === null ? AsyncResult.isFailure(result) : value.briefs.length === 0) return null;

  const change = async (opened: KinBrief, next: KinBrief) => {
    const ok = await saving.run(next.kind, KIN_BRIEFS.failed, () =>
      save({ ...query, input: { orgId: props.orgId, ...kinBriefSave(opened, next) } }),
    );
    refreshKinBriefs(props.environmentId, props.orgId);
    return ok;
  };

  return (
    <KinSettingsSection
      title={KIN_BRIEFS.title}
      description={
        value === null
          ? KIN_BRIEFS.detail
          : `${KIN_BRIEFS.detail} ${KIN_CHECK_INS.zone(value.zone)}`
      }
      problem={editing === null ? saving.problem : null}
    >
      {value === null ? (
        <KinSettingsLoading rows={2} />
      ) : (
        value.briefs.map((brief) => (
          <KinSettingsRow
            key={brief.kind}
            title={kinBriefTitle(brief)}
            // The switch says on or off; the line says when.
            detail={kinBriefLine({ ...brief, on: true })}
            status={
              brief.on && kinCoveredLine(brief) !== null ? (
                <KinSettingsStatus tone="quiet">{KIN_CHECK_INS.coveredToday}</KinSettingsStatus>
              ) : null
            }
            openLabel={`${KIN_BRIEFS.edit}: ${kinBriefTitle(brief)}`}
            onOpen={() => setEditing(brief)}
            control={
              kinBriefTurnsOff(brief) ? (
                <Switch
                  aria-label={`${kinBriefTitle(brief)}: ${brief.on ? KIN_BRIEFS.on : KIN_BRIEFS.off}`}
                  checked={brief.on}
                  disabled={saving.busy !== null}
                  onCheckedChange={(on) => void change(brief, { ...brief, on })}
                />
              ) : null
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
    </KinSettingsSection>
  );
}

/** A brief's time, and the morning brief's days; it saves on Save. */
function BriefDialog(props: {
  readonly brief: KinBrief;
  readonly zone: string;
  readonly onSave: (brief: KinBrief) => Promise<boolean>;
  readonly onClose: () => void;
}) {
  const [draft, setDraft] = useState(props.brief);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <KinSettingsFormDialog
      title={kinBriefTitle(draft)}
      description={[KIN_CHECK_INS.zone(props.zone), kinCoveredLine(draft)]
        .filter((line) => line !== null)
        .join(" ")}
      submitLabel={KIN_BRIEFS.saveBrief}
      busy={busy}
      notReady={kinBriefProblem(draft)}
      problem={failed ? KIN_BRIEFS.failed : null}
      onSubmit={() => {
        setBusy(true);
        setFailed(false);
        void props.onSave(draft).then((ok) => {
          setBusy(false);
          if (ok) props.onClose();
          else setFailed(true);
        });
      }}
      onClose={props.onClose}
    >
      <KinSettingsField label={KIN_BRIEFS.time}>
        {(ids) => (
          <Input
            type="time"
            id={ids.control}
            nativeInput
            className="w-32"
            value={draft.at}
            onChange={(event) => setDraft({ ...draft, at: event.target.value })}
          />
        )}
      </KinSettingsField>
      {kinBriefHasDays(draft.kind) ? (
        <KinSettingsField label={KIN_BRIEFS.days}>
          {(ids) => (
            <ToggleGroup
              multiple
              variant="outline"
              size="sm"
              aria-labelledby={ids.label}
              value={draft.days.map(String)}
              onValueChange={(values) => setDraft({ ...draft, days: values.map(Number) })}
            >
              {KIN_WEEKDAYS.map(({ day, short }) => (
                <Toggle key={day} value={String(day)}>
                  {short}
                </Toggle>
              ))}
            </ToggleGroup>
          )}
        </KinSettingsField>
      ) : null}
    </KinSettingsFormDialog>
  );
}
