import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_KIN_ROUTING_SETTINGS,
  type EnvironmentId,
  type KinRoutingSettings as KinRoutingSettingsValue,
  type KinRoleModels,
} from "@t3tools/contracts";
import { useState } from "react";

import { kinRouting, updateKinRouting } from "../../state/kin";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function browserTimeZone(): string {
  const format = Intl.DateTimeFormat;
  return new format().resolvedOptions().timeZone;
}

const ROLE_LABELS: ReadonlyArray<{ readonly key: keyof KinRoleModels; readonly label: string }> = [
  { key: "main", label: "Main" },
  { key: "implementer", label: "Implementer" },
  { key: "reviewer", label: "Reviewer" },
  { key: "researcher", label: "Researcher" },
  { key: "archivist", label: "Archivist" },
  { key: "triage", label: "Triage" },
  { key: "sweep", label: "Sweep" },
  { key: "summary", label: "Summary" },
];

function percent(value: number | null): string {
  if (value === null) return "unknown";
  return `${Math.round(value <= 1 ? value * 100 : value)}%`;
}

export function KinRoutingSettings() {
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  if (environmentId === null) {
    return (
      <SettingsPageContainer>
        <p className="px-3 text-sm text-muted-foreground sm:px-4">
          Connect an environment to edit Kin routing.
        </p>
      </SettingsPageContainer>
    );
  }
  return <KinRoutingForm key={environmentId} environmentId={environmentId} />;
}

function KinRoutingForm({ environmentId }: { environmentId: EnvironmentId }) {
  const snapshot = useEnvironmentQuery(
    kinRouting({
      environmentId,
      input: { timeZone: browserTimeZone() },
    }),
  );
  const canWrite = useAtomValue(updateKinRouting.permissionAtom(environmentId));
  const save = useAtomCommand(updateKinRouting);
  const [draft, setDraft] = useState<KinRoutingSettingsValue | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const settings = draft ?? snapshot.data?.settings ?? null;

  const update = (patch: Partial<KinRoutingSettingsValue>) => {
    if (settings === null) return;
    setDraft({ ...settings, ...patch });
  };

  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("kin-routing")}>
        <div className="space-y-2 px-3 py-3 text-sm text-muted-foreground sm:px-4">
          <p>
            New launches pause when a plan is near its limit or the main thread is at its agent cap.
            Cross-model review and fresh-author escalation stay off until routing policy is on.
          </p>
          {snapshot.data?.launchesPaused ? (
            <p className="text-foreground">
              Every plan is near its limit. Kin is pausing new launches.
            </p>
          ) : null}
          {snapshot.error ? <p className="text-destructive">{snapshot.error}</p> : null}
        </div>
      </SettingsSection>

      {settings === null ? null : (
        <>
          <SettingsSection {...searchableSetting("kin-plans")}>
            <div className="space-y-4 px-3 py-3 sm:px-4">
              {settings.plans.map((plan, index) => (
                <div key={plan.id} className="grid gap-2 sm:grid-cols-4">
                  <Input
                    value={plan.label}
                    aria-label={`${plan.label} name`}
                    onChange={(event) =>
                      update({
                        plans: settings.plans.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, label: event.target.value } : entry,
                        ),
                      })
                    }
                  />
                  <Input
                    value={plan.provider}
                    aria-label={`${plan.label} provider`}
                    onChange={(event) =>
                      update({
                        plans: settings.plans.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, provider: event.target.value } : entry,
                        ),
                      })
                    }
                  />
                  <Input
                    type="number"
                    value={String(plan.monthlyUsd)}
                    aria-label={`${plan.label} monthly dollars`}
                    onChange={(event) => {
                      const monthlyUsd = Number(event.target.value);
                      if (!Number.isFinite(monthlyUsd)) return;
                      update({
                        plans: settings.plans.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, monthlyUsd } : entry,
                        ),
                      });
                    }}
                  />
                  <Input
                    type="number"
                    value={String(plan.concurrencyCap)}
                    aria-label={`${plan.label} concurrency cap`}
                    onChange={(event) => {
                      const concurrencyCap = Number(event.target.value);
                      if (!Number.isInteger(concurrencyCap) || concurrencyCap < 0) return;
                      update({
                        plans: settings.plans.map((entry, entryIndex) =>
                          entryIndex === index ? { ...entry, concurrencyCap } : entry,
                        ),
                      });
                    }}
                  />
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canWrite}
                  onClick={() =>
                    update({
                      plans: [
                        ...settings.plans,
                        {
                          id: `plan-${settings.plans.length + 1}`,
                          label: "New plan",
                          provider: "openrouter",
                          monthlyUsd: 0,
                          concurrencyCap: 1,
                        },
                      ],
                    })
                  }
                >
                  Add plan
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canWrite}
                  onClick={() => setDraft(DEFAULT_KIN_ROUTING_SETTINGS)}
                >
                  Reset defaults
                </Button>
              </div>
            </div>
          </SettingsSection>

          <SettingsSection {...searchableSetting("kin-concurrency")}>
            <SettingsRow
              {...searchableSetting("kin-main-thread-cap")}
              description="Agents running under one main thread. The default is 20."
              control={
                <div className="w-24">
                  <Input
                    type="number"
                    value={String(settings.mainThreadConcurrency)}
                    aria-label="Main thread concurrency"
                    onChange={(event) => {
                      const mainThreadConcurrency = Number(event.target.value);
                      if (!Number.isInteger(mainThreadConcurrency)) return;
                      update({ mainThreadConcurrency });
                    }}
                  />
                </div>
              }
            />
            <SettingsRow
              {...searchableSetting("kin-near-limit")}
              description="Kin pauses a plan at this percent of its provider window."
              control={
                <div className="w-24">
                  <Input
                    type="number"
                    value={String(settings.nearLimitPercent)}
                    aria-label="Near limit percent"
                    onChange={(event) => {
                      const nearLimitPercent = Number(event.target.value);
                      if (!Number.isFinite(nearLimitPercent)) return;
                      update({ nearLimitPercent });
                    }}
                  />
                </div>
              }
            />
          </SettingsSection>

          <SettingsSection {...searchableSetting("kin-routing-policy")}>
            <SettingsRow
              {...searchableSetting("kin-routing-policy-toggle")}
              description="Section 9. Off leaves cross-model review and fresh-author escalation unused."
              control={
                <Switch
                  checked={settings.routingPolicyEnabled}
                  aria-label="Routing policy"
                  onCheckedChange={(checked) => update({ routingPolicyEnabled: checked })}
                />
              }
            />
            <SettingsRow
              {...searchableSetting("kin-cross-model-review")}
              description="Reviewers run on the other model. Off by default."
              control={
                <Switch
                  checked={settings.crossModelReview}
                  disabled={!settings.routingPolicyEnabled}
                  aria-label="Cross-model review"
                  onCheckedChange={(checked) => update({ crossModelReview: checked })}
                />
              }
            />
            <SettingsRow
              {...searchableSetting("kin-fresh-author")}
              description="A stuck lane moves to a fresh author and is told to fix the class of failure."
              control={
                <Switch
                  checked={settings.freshAuthorEscalation}
                  disabled={!settings.routingPolicyEnabled}
                  aria-label="Fresh-author escalation"
                  onCheckedChange={(checked) => update({ freshAuthorEscalation: checked })}
                />
              }
            />
          </SettingsSection>

          <SettingsSection {...searchableSetting("kin-role-models")}>
            <div className="space-y-3 px-3 py-3 sm:px-4">
              <p className="text-sm text-muted-foreground">
                <span className="font-mono">inherit</span> keeps the profile model.{" "}
                <span className="font-mono">cheap</span> uses {settings.cheapModel} on OpenRouter.
                Anything else is a model id.
              </p>
              <div className="max-w-sm">
                <Input
                  value={settings.cheapModel}
                  aria-label="Cheap model"
                  onChange={(event) => update({ cheapModel: event.target.value })}
                />
              </div>
              {ROLE_LABELS.map((role) => (
                <SettingsRow
                  key={role.key}
                  title={role.label}
                  control={
                    <div className="w-48">
                      <Input
                        value={settings.roleModels[role.key]}
                        aria-label={`${role.label} model`}
                        onChange={(event) =>
                          update({
                            roleModels: { ...settings.roleModels, [role.key]: event.target.value },
                          })
                        }
                      />
                    </div>
                  }
                />
              ))}
            </div>
          </SettingsSection>

          <div className="px-3 sm:px-4">
            <Button
              size="sm"
              disabled={!canWrite || draft === null}
              onClick={() => {
                if (draft === null) return;
                void save({ environmentId, input: draft }).then((result) => {
                  if (result._tag === "Success") {
                    setMessage("Saved routing.");
                    setDraft(null);
                    snapshot.refresh();
                  }
                });
              }}
            >
              Save routing
            </Button>
            {message ? <p className="mt-2 text-sm text-muted-foreground">{message}</p> : null}
          </div>
        </>
      )}

      <SettingsSection {...searchableSetting("kin-usage")}>
        <div className="space-y-3 px-3 py-3 text-sm sm:px-4">
          {(snapshot.data?.plans ?? []).map((plan) => (
            <p key={plan.id}>
              {plan.label}:{" "}
              {plan.usedPercent === null ? "no window yet" : `${Math.round(plan.usedPercent)}%`}
              {plan.paused ? ", paused" : ""}. Cap {plan.concurrencyCap}.
            </p>
          ))}
          {(snapshot.data?.planUsage ?? []).map((usage) => (
            <p key={usage.provider}>
              {usage.provider}: {usage.inputTokens.toLocaleString()} input,{" "}
              {usage.cachedInputTokens.toLocaleString()} cached,{" "}
              {usage.outputTokens.toLocaleString()} output, cache hit {percent(usage.cacheHitRate)}.
            </p>
          ))}
          {(snapshot.data?.lanes ?? []).slice(0, 12).map((lane) => (
            <p key={lane.id} className="text-muted-foreground">
              {lane.profile} on {lane.planId}
              {lane.model ? ` · ${lane.model}` : ""} · {lane.at}
            </p>
          ))}
          {(snapshot.data?.lanes.length ?? 0) === 0 ? (
            <p className="text-muted-foreground">No Kin lanes recorded yet.</p>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
