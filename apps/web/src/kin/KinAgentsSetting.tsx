import { useAtomValue } from "@effect/atom-react";
import { KIN_AGENT_PAGE, kinAgentModelLine } from "@t3tools/client-runtime/kin/kinAgentPage";
import { kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import {
  KIN_AGENTS_COPY,
  KIN_AGENTS_PAGE,
  KIN_BACKGROUND_MODEL,
  KIN_CLEAR_UPDATES,
  KIN_OTHER_PROVIDER_AGENTS,
  kinBackgroundModel,
  kinLeadModelName,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { applyKinClearUpdatesSave } from "@t3tools/client-runtime/kin/kinStreams";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { DEFAULT_KIN_BACKGROUND_MODEL_SELECTION, type ModelSelection } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";

import { useSearchableSetting } from "../components/settings/settingsSearch";
import { Radio, RadioGroup } from "../components/ui/radio-group";
import { Switch } from "../components/ui/switch";
import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { KinAgentModelPicker, useKinAgentModels } from "./KinAgentModelPicker";
import { kinClient } from "./kinClient";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { KinSettingsField, KinSettingsFormDialog } from "./settings/KinSettingsControls";
import {
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsStatus,
} from "./settings/KinSettingsLayout";
import { useKinHost } from "./useKinHost";
import { useKinOwnerLevel } from "./useKinOwnerLevel";
import type { KinWorkTarget } from "./useKinWork";

/** The old Company settings address's agents block, before Kin's Settings take it over. */
export function KinAgentsSetting() {
  const target = kinNewLeadTarget(useKinHost());
  return target === null ? null : <KinAgentDefaultsSections {...target} />;
}

/**
 * Settings → Agents, below the list: what new agents start on, how their chats read, then the
 * experiment that lets agents run on other providers. The owner and co-owners only.
 */
export function KinAgentDefaultsSections(props: KinWorkTarget) {
  if (!useKinOwnerLevel(props.environmentId)) return null;
  return (
    <>
      <CompanyDefault {...props} />
      <ClearUpdates {...props} />
      <OpenAiAgents {...props} />
    </>
  );
}

/** The host's switch that clears a turn's progress updates once its reply is posted; it saves on flip. */
function ClearUpdates(props: KinWorkTarget) {
  const settings = useEnvironmentSettings(props.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const searchableSetting = useSearchableSetting();
  return (
    <KinSettingsSection
      title={KIN_CLEAR_UPDATES.section}
      searchId={searchableSetting("kin-clear-updates").id}
    >
      <KinSettingsRow
        title={KIN_CLEAR_UPDATES.row}
        wrap
        detail={KIN_CLEAR_UPDATES.rowDetail}
        control={
          <Switch
            checked={settings.kinClearUpdatesAfterReply}
            onCheckedChange={(checked) => {
              const next = Boolean(checked);
              void applyKinClearUpdatesSave(
                props.environmentId,
                next,
                () =>
                  new Promise<boolean>((resolve) => {
                    updateSettings(
                      { kinClearUpdatesAfterReply: next },
                      {
                        onSaved: () => resolve(true),
                        onFailed: () => resolve(false),
                      },
                    );
                  }),
              );
            }}
            aria-label={KIN_CLEAR_UPDATES.row}
          />
        }
      />
    </KinSettingsSection>
  );
}

/** The host's experimental switch that lets agents run on Codex models too; it saves on flip. */
function OpenAiAgents(props: KinWorkTarget) {
  const settings = useEnvironmentSettings(props.environmentId);
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  return (
    <KinSettingsSection title={KIN_OTHER_PROVIDER_AGENTS.section}>
      <BackgroundModel {...props} />
      <KinSettingsRow
        title={KIN_OTHER_PROVIDER_AGENTS.row}
        wrap
        detail={KIN_OTHER_PROVIDER_AGENTS.rowDetail}
        control={
          <Switch
            checked={settings.kinNonClaudeAgents}
            onCheckedChange={(checked) =>
              void updateSettings({ kinNonClaudeAgents: Boolean(checked) })
            }
            aria-label={KIN_OTHER_PROVIDER_AGENTS.row}
          />
        }
      />
    </KinSettingsSection>
  );
}

/** The host's model for background checks, in its three states; a form changes it and takes it back. */
function BackgroundModel(props: KinWorkTarget) {
  const { environmentId } = props;
  const settings = useEnvironmentSettings(environmentId);
  const { providers, offered } = useKinAgentModels(environmentId);
  const loaded = useAtomValue(serverEnvironment.providersValueAtom(environmentId)) != null;
  const [editing, setEditing] = useState(false);
  const state = kinBackgroundModel(settings.kinBackgroundModelSelection, loaded ? offered : null);
  const lineOf = (selection: ModelSelection) =>
    kinAgentModelLine(kinLeadModelName(selection.model, providers), selection);
  const detail =
    state.kind === "each"
      ? KIN_BACKGROUND_MODEL.each
      : state.runs
        ? KIN_BACKGROUND_MODEL.detail(lineOf(state.selection), state.kind)
        : KIN_BACKGROUND_MODEL.cantRun(lineOf(state.selection));
  return (
    <>
      <KinSettingsRow
        title={KIN_BACKGROUND_MODEL.row}
        wrap
        detail={detail}
        status={
          state.kind !== "each" && !state.runs ? (
            <KinSettingsStatus tone="attention">
              {KIN_BACKGROUND_MODEL.cantRunStatus}
            </KinSettingsStatus>
          ) : null
        }
        openLabel={KIN_BACKGROUND_MODEL.title}
        onOpen={() => setEditing(true)}
      />
      {editing ? (
        <BackgroundModelDialog
          environmentId={environmentId}
          state={state}
          lineOf={lineOf}
          offered={loaded ? offered : null}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </>
  );
}

function BackgroundModelDialog(props: {
  readonly environmentId: KinWorkTarget["environmentId"];
  readonly state: ReturnType<typeof kinBackgroundModel>;
  readonly lineOf: (selection: ModelSelection) => string;
  readonly offered: ReadonlyArray<ModelSelection> | null;
  readonly onClose: () => void;
}) {
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const [choice, setChoice] = useState<"default" | "chosen" | "each">(props.state.kind);
  const [model, setModel] = useState(
    props.state.kind === "chosen" ? props.state.selection : DEFAULT_KIN_BACKGROUND_MODEL_SELECTION,
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const defaultLine = props.lineOf(DEFAULT_KIN_BACKGROUND_MODEL_SELECTION);
  const picked = kinBackgroundModel(
    choice === "default" ? undefined : choice === "each" ? null : model,
    props.offered,
  );
  const submit = () => {
    setBusy(true);
    setProblem(null);
    updateSettings(
      {
        kinBackgroundModelSelection:
          choice === "default" ? "default" : choice === "each" ? null : model,
      },
      {
        onSaved: props.onClose,
        onFailed: () => {
          setBusy(false);
          setProblem(KIN_AGENTS_COPY.saveFailed);
        },
      },
    );
  };
  const choices = [
    { value: "default", label: KIN_BACKGROUND_MODEL.useDefault(defaultLine) },
    { value: "chosen", label: KIN_BACKGROUND_MODEL.another },
    { value: "each", label: KIN_BACKGROUND_MODEL.eachChoice },
  ] as const;
  return (
    <KinSettingsFormDialog
      title={KIN_BACKGROUND_MODEL.title}
      description={KIN_BACKGROUND_MODEL.description}
      submitLabel={KIN_BACKGROUND_MODEL.save}
      busy={busy}
      problem={problem}
      onSubmit={submit}
      onClose={props.onClose}
    >
      <KinSettingsField
        label={KIN_BACKGROUND_MODEL.choices}
        {...(picked.kind !== "each" && !picked.runs
          ? { help: KIN_BACKGROUND_MODEL.cantRun(props.lineOf(picked.selection)) }
          : {})}
      >
        {(ids) => (
          <RadioGroup
            aria-labelledby={ids.label}
            value={choice}
            disabled={busy}
            onValueChange={(value) => {
              const next = choices.find((one) => one.value === value)?.value;
              if (next !== undefined) setChoice(next);
            }}
          >
            {choices.map((one) => (
              <div key={one.value} className="flex flex-col gap-2">
                <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-accent">
                  <Radio value={one.value} />
                  <span className="text-pretty text-sm text-foreground">{one.label}</span>
                </label>
                {one.value === "chosen" && choice === "chosen" ? (
                  <div className="ps-9">
                    <KinAgentModelPicker
                      environmentId={props.environmentId}
                      label={KIN_BACKGROUND_MODEL.model}
                      selection={model}
                      disabled={busy}
                      onChange={setModel}
                    />
                  </div>
                ) : null}
              </div>
            ))}
          </RadioGroup>
        )}
      </KinSettingsField>
    </KinSettingsFormDialog>
  );
}

/** The model and effort new agents start on: a row saying it, opening a form to change both. */
function CompanyDefault(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const searchableSetting = useSearchableSetting();
  const defaultsAtom = kinClient.agentDefaults({ environmentId, input: { orgId } });
  const defaults = Option.getOrNull(AsyncResult.value(useAtomValue(defaultsAtom)));
  const { providers } = useKinAgentModels(environmentId);
  const [editing, setEditing] = useState(false);
  const base = defaults?.model ?? null;
  const line =
    base === null ? null : kinAgentModelLine(kinLeadModelName(base.model, providers), base);
  return (
    <KinSettingsSection
      title={KIN_AGENTS_PAGE.forNew}
      searchId={searchableSetting("kin-agents").id}
    >
      <KinSettingsRow
        title={KIN_AGENTS_PAGE.model}
        detail={
          line === null
            ? undefined
            : defaults?.chosen === false
              ? KIN_AGENTS_PAGE.unchosen(line)
              : line
        }
        openLabel={KIN_AGENTS_PAGE.defaultsTitle}
        {...(base === null ? {} : { onOpen: () => setEditing(true) })}
      />
      {editing && base !== null ? (
        <DefaultsDialog
          {...props}
          base={base}
          unchosen={defaults?.chosen === false}
          onSaved={() => appAtomRegistry.refresh(defaultsAtom)}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </KinSettingsSection>
  );
}

function DefaultsDialog(
  props: KinWorkTarget & {
    readonly base: ModelSelection;
    readonly unchosen: boolean;
    readonly onSaved: () => void;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId } = props;
  const save = useAtomCommand(kinClient.agentDefaultsSet, { reportFailure: false });
  const [model, setModel] = useState(props.base);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async () => {
    setBusy(true);
    setProblem(null);
    const outcome = await save({ environmentId, input: { orgId, model } });
    setBusy(false);
    props.onSaved();
    if (AsyncResult.isSuccess(outcome)) props.onClose();
    else setProblem(kinFailureText(squashAtomCommandFailure(outcome), KIN_AGENTS_COPY.saveFailed));
  };
  return (
    <KinSettingsFormDialog
      title={KIN_AGENTS_PAGE.defaultsTitle}
      description={
        props.unchosen
          ? `${KIN_AGENT_PAGE.defaultsDetail} ${KIN_AGENT_PAGE.defaultsUnchosen}`
          : KIN_AGENT_PAGE.defaultsDetail
      }
      submitLabel={KIN_AGENTS_PAGE.save}
      busy={busy}
      problem={problem}
      onSubmit={() => void submit()}
      onClose={props.onClose}
    >
      <KinSettingsField label={KIN_AGENTS_PAGE.defaultsLabel}>
        {() => (
          <KinAgentModelPicker
            environmentId={environmentId}
            label={KIN_AGENTS_PAGE.defaultsLabel}
            selection={model}
            disabled={busy}
            onChange={setModel}
          />
        )}
      </KinSettingsField>
    </KinSettingsFormDialog>
  );
}
