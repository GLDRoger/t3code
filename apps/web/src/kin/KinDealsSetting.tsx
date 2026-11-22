import { kinFailure } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_DEALS,
  KIN_DEAL_QUIET,
  KIN_DEAL_STAGES,
  KIN_DEAL_STAGES_SETTINGS,
  kinDealQuietChoices,
  kinDealStagesAfter,
  kinDealStagesProblem,
  type KinDealStageChange,
} from "@t3tools/client-runtime/kin/kinDeals";
import type { KinDealStage, KinDealStagesResult } from "@t3tools/contracts";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, TrophyIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { useSearchableSetting } from "../components/settings/settingsSearch";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { KinConfirm } from "./KinConfirm";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import {
  KinSettingsChoice,
  KinSettingsField,
  KinSettingsFormDialog,
} from "./settings/KinSettingsControls";
import {
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsPage,
  KinSettingsRow,
  KinSettingsSection,
} from "./settings/KinSettingsLayout";
import { useKinDealQuietDaysSet, useKinDealStages, useKinDealStagesSet } from "./useKinDeals";
import { useKinHost } from "./useKinHost";
import type { KinWorkTarget } from "./useKinWork";

/** Settings → Deals: the company's stages, with Won and Lost as fixed ends. */
export function KinDealsSetting() {
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? null : <KinDealStagesSettings {...target} />;
}

export function KinDealStagesSettings(props: KinWorkTarget) {
  const { state, refresh } = useKinDealStages(props);
  const searchableSetting = useSearchableSetting();
  const searchId = searchableSetting("kin-deals").id;
  if (state._tag !== "ready")
    return (
      <KinSettingsPage>
        <KinSettingsSection title={KIN_DEAL_STAGES.stages} searchId={searchId}>
          {state._tag === "loading" ? (
            <KinSettingsLoading rows={4} />
          ) : (
            <KinSettingsLoadFailed onRetry={refresh}>
              {
                kinFailure(
                  state._tag === "failed" ? state.cause : null,
                  `${KIN_DEALS.stagesFailed}.`,
                ).text
              }
            </KinSettingsLoadFailed>
          )}
        </KinSettingsSection>
      </KinSettingsPage>
    );
  return <Stages {...props} held={state.value} searchId={searchId} />;
}

type Editing = { readonly _tag: "add" } | { readonly _tag: "edit"; readonly stage: KinDealStage };

function Stages(
  props: KinWorkTarget & { readonly held: KinDealStagesResult; readonly searchId: string },
) {
  const { held } = props;
  const [editing, setEditing] = useState<Editing | null>(null);
  const canAdd = held.can && held.stages.length < 12;
  return (
    <KinSettingsPage
      purpose={held.can ? KIN_DEAL_STAGES.detail : KIN_DEAL_STAGES_SETTINGS.purposeReadOnly}
    >
      <KinSettingsSection
        title={KIN_DEAL_STAGES.stages}
        searchId={props.searchId}
        action={
          canAdd ? (
            <Button size="xs" variant="outline" onClick={() => setEditing({ _tag: "add" })}>
              <PlusIcon />
              {KIN_DEAL_STAGES_SETTINGS.add}
            </Button>
          ) : undefined
        }
      >
        {held.stages.map((stage) => {
          const open = held.open[stage.id] ?? 0;
          return (
            <KinSettingsRow
              key={stage.id}
              title={stage.name}
              detail={open === 0 ? undefined : KIN_DEAL_STAGES.openDeals(open)}
              {...(held.can
                ? {
                    openLabel: `${KIN_DEAL_STAGES_SETTINGS.edit}: ${stage.name}`,
                    onOpen: () => setEditing({ _tag: "edit", stage }),
                  }
                : {})}
            />
          );
        })}
      </KinSettingsSection>
      <KinSettingsSection title={KIN_DEAL_STAGES.ends}>
        <KinSettingsRow
          leading={<TrophyIcon aria-hidden className="size-4 text-success-foreground" />}
          title="Won"
          wrap
          detail={KIN_DEAL_STAGES_SETTINGS.wonDetail}
        />
        <KinSettingsRow
          leading={<XIcon aria-hidden className="size-4 text-destructive-foreground" />}
          title="Lost"
          wrap
          detail={KIN_DEAL_STAGES_SETTINGS.lostDetail}
        />
      </KinSettingsSection>
      <QuietDays {...props} />
      {editing === null ? null : (
        <StageDialog
          {...props}
          stage={editing._tag === "edit" ? editing.stage : null}
          onClose={() => setEditing(null)}
        />
      )}
    </KinSettingsPage>
  );
}

/** Add a stage, or rename, move or remove one; each saves the whole list on its own button. */
function StageDialog(
  props: KinWorkTarget & {
    readonly held: KinDealStagesResult;
    readonly stage: KinDealStage | null;
    readonly onClose: () => void;
  },
) {
  const { held, stage } = props;
  const save = useKinDealStagesSet(props);
  const [name, setName] = useState(stage?.name ?? "");
  const [opened] = useState(() =>
    stage === null ? held.stages.length : held.stages.findIndex((each) => each.id === stage.id),
  );
  const [place, setPlace] = useState(opened);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const open = stage === null ? 0 : (held.open[stage.id] ?? 0);
  const others = held.stages.filter((each) => each.id !== stage?.id);
  // Where a removed stage's open deals go; nothing is stranded.
  const [moveTo, setMoveTo] = useState<string | null>(others[0]?.id ?? null);
  const change: KinDealStageChange =
    stage === null ? { _tag: "add", name } : { _tag: "edit", id: stage.id, name, place };
  const after = kinDealStagesAfter(held, change);
  const unchanged =
    stage !== null &&
    after.stages.every((each, index) => {
      const was = held.stages[index];
      return was !== undefined && each.id === was.id && each.name === was.name;
    });
  const send = async (sent: KinDealStageChange) => {
    setBusy(true);
    setProblem(null);
    const outcome = await save(kinDealStagesAfter(held, sent));
    setBusy(false);
    if (outcome.ok) props.onClose();
    else setProblem(outcome.problem);
  };
  return (
    <>
      <KinSettingsFormDialog
        title={stage === null ? KIN_DEAL_STAGES_SETTINGS.add : KIN_DEAL_STAGES_SETTINGS.edit}
        submitLabel={
          stage === null ? KIN_DEAL_STAGES_SETTINGS.addSubmit : KIN_DEAL_STAGES_SETTINGS.save
        }
        busy={busy}
        notReady={kinDealStagesProblem(after.stages.map((each) => each.name))}
        problem={problem}
        typed={name.trim() !== (stage?.name ?? "").trim() || place !== opened}
        remove={
          stage === null || held.stages.length === 1 ? undefined : (
            <Button
              type="button"
              variant="ghost-destructive"
              disabled={busy}
              onClick={() => setRemoving(true)}
            >
              {KIN_DEAL_STAGES_SETTINGS.remove}
            </Button>
          )
        }
        onSubmit={() => (unchanged ? props.onClose() : void send(change))}
        onClose={props.onClose}
      >
        <KinSettingsField
          label={KIN_DEAL_STAGES_SETTINGS.name}
          help={stage === null ? undefined : KIN_DEAL_STAGES_SETTINGS.nameHelp}
        >
          {(ids) => (
            <Input
              id={ids.control}
              value={name}
              maxLength={40}
              autoComplete="off"
              autoFocus
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </KinSettingsField>
        {stage === null || held.stages.length < 2 ? null : (
          <KinSettingsField label={KIN_DEAL_STAGES_SETTINGS.place}>
            {(ids) => (
              <div id={ids.control} className="flex items-center gap-2">
                <span className="me-auto text-sm text-foreground">
                  {KIN_DEAL_STAGES_SETTINGS.placeOf(place + 1, held.stages.length)}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || place === 0}
                  onClick={() => setPlace(place - 1)}
                >
                  <ArrowUpIcon />
                  {KIN_DEAL_STAGES.up}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy || place === held.stages.length - 1}
                  onClick={() => setPlace(place + 1)}
                >
                  <ArrowDownIcon />
                  {KIN_DEAL_STAGES.down}
                </Button>
              </div>
            )}
          </KinSettingsField>
        )}
      </KinSettingsFormDialog>
      {stage === null || !removing ? null : (
        <KinConfirm
          ask={{
            title: KIN_DEAL_STAGES.removeTitle(stage.name),
            detail:
              open === 0
                ? KIN_DEAL_STAGES_SETTINGS.removeEmptyDetail
                : KIN_DEAL_STAGES.removeDetail(open),
            action: KIN_DEAL_STAGES.removeConfirm(open),
            destructive: true,
          }}
          notReady={open > 0 && moveTo === null}
          onConfirm={() =>
            void send({ _tag: "remove", id: stage.id, moveTo: open === 0 ? null : moveTo })
          }
          onClose={() => setRemoving(false)}
        >
          {open === 0 ? null : (
            <>
              <Select value={moveTo ?? ""} onValueChange={(value) => setMoveTo(String(value))}>
                <SelectTrigger
                  aria-label={KIN_DEAL_STAGES_SETTINGS.moveTo}
                  className="w-full min-w-0"
                >
                  <SelectValue>{others.find((each) => each.id === moveTo)?.name}</SelectValue>
                </SelectTrigger>
                <SelectPopup alignItemWithTrigger={false}>
                  {others.map((each) => (
                    <SelectItem key={each.id} value={each.id}>
                      {each.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <p className="text-xs text-muted-foreground">{KIN_DEAL_STAGES.removeNote}</p>
            </>
          )}
        </KinConfirm>
      )}
    </>
  );
}

/** "A deal goes quiet after N days": the owner level picks it; everyone else reads it. */
function QuietDays(props: KinWorkTarget & { readonly held: KinDealStagesResult }) {
  const days = props.held.quietDays;
  const save = useKinDealQuietDaysSet(props);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (days === undefined) return null;
  return (
    <KinSettingsSection
      title={KIN_DEAL_STAGES_SETTINGS.quietTitle}
      description={KIN_DEAL_QUIET.detail}
      problem={problem}
    >
      <KinSettingsRow
        title={KIN_DEAL_QUIET.title}
        detail={props.held.can ? undefined : KIN_DEAL_QUIET.days(days)}
        control={
          props.held.can ? (
            <KinSettingsChoice
              label={KIN_DEAL_QUIET.label}
              value={String(days)}
              disabled={busy}
              options={kinDealQuietChoices(days).map((each) => ({
                value: String(each),
                label: KIN_DEAL_QUIET.days(each),
              }))}
              onChange={async (picked) => {
                setBusy(true);
                setProblem(null);
                const outcome = await save(Number(picked));
                setBusy(false);
                if (!outcome.ok) setProblem(outcome.problem);
              }}
            />
          ) : undefined
        }
      />
    </KinSettingsSection>
  );
}
