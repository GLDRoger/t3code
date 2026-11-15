import { useAtomValue } from "@effect/atom-react";
import {
  KIN_AGENT_DRIVER,
  KIN_LEAD_CHARTER_MAX,
  KIN_LEAD_MODELS,
  KIN_LEAD_INTRO_MAX,
  KIN_LEAD_NAME_MAX,
  kinDomainSlug,
  kinLeadChanges,
  kinLeadDraftCheck,
  kinLeadDraftOf,
  kinLeadSaveProblem,
  kinLeadStartingModels,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import type { ModelSelection } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { ProviderModelPicker } from "../components/chat/ProviderModelPicker";
import { SETTINGS_PICKER_TRIGGER_CLASSNAME } from "../components/settings/settingsLayout";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { useEnvironmentSettings } from "../hooks/useSettings";
import { getCustomModelOptionsByInstance } from "../modelSelection";
import { providerInstanceEntriesFor } from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient, refreshKinAgents } from "./kinClient";
import { kinLeadFormAtom, type KinLeadFormTarget } from "./kinLeadForm";

const closeLeadForm = () => appAtomRegistry.set(kinLeadFormAtom, null);

/** The create-or-edit lead form, wherever it was opened from. Mounted once, on Kin's page. */
export function KinLeadDialogHost() {
  const target = useAtomValue(kinLeadFormAtom);
  if (target === null) return null;
  return <KinLeadDialog key={target.lead?.agentId ?? "new"} target={target} />;
}

function KinLeadDialog(props: { readonly target: KinLeadFormTarget }) {
  const { environmentId, orgId, lead, suggested } = props.target;
  const navigate = useNavigate();
  const create = useAtomCommand(kinClient.leadCreate, { reportFailure: false });
  const update = useAtomCommand(kinClient.leadUpdate, { reportFailure: false });
  const [initial] = useState(() =>
    lead === null
      ? (suggested ?? { name: "", area: "", charter: "", intro: "" })
      : kinLeadDraftOf(lead),
  );
  // The org's first agent picks the models; the host gives every later one the same.
  const leads = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const [noModels, setNoModels] = useState(false);
  const firstAgent =
    lead === null &&
    (noModels ||
      (AsyncResult.isSuccess(leads) &&
        leads.value.leads.every((held) => held.retired !== undefined)));
  const settings = useEnvironmentSettings(environmentId);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const instanceEntries = providerInstanceEntriesFor(providers, settings, null).filter(
    (entry) => entry.driverKind === KIN_AGENT_DRIVER && entry.enabled && entry.isAvailable,
  );
  const modelOptionsByInstance = getCustomModelOptionsByInstance(settings, providers);
  const offered = instanceEntries.flatMap((entry) =>
    (modelOptionsByInstance.get(entry.instanceId) ?? []).map((model): ModelSelection => ({
      instanceId: entry.instanceId,
      model: model.slug,
    })),
  );
  const [pickedModels, setPickedModels] = useState<{
    readonly strong: ModelSelection;
    readonly cheap: ModelSelection;
  } | null>(null);
  const models = pickedModels ?? kinLeadStartingModels(offered);
  const [name, setName] = useState(initial.name);
  const [area, setArea] = useState(initial.area);
  const [charter, setCharter] = useState(initial.charter);
  const [intro, setIntro] = useState(initial.intro);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameId = useId();
  const areaId = useId();
  const charterId = useId();
  const introId = useId();

  const checked = kinLeadDraftCheck({ name, area, charter, intro });
  const areaInvalid = area.trim() !== "" && kinDomainSlug(area) === null;
  const canSave = checked.ok && !busy && !(firstAgent && models === null);

  const save = async () => {
    if (!checked.ok || busy) return;
    const changes = lead === null ? null : kinLeadChanges(lead, checked);
    if (lead !== null && changes === null) return closeLeadForm();
    setBusy(true);
    setError(null);
    const { name: leadName, domain, charter: leadCharter, intro: leadIntro } = checked;
    // Each command settles into its own result type, so both reduce to the chat to open.
    const saved =
      lead === null
        ? await create({
            environmentId,
            input: {
              orgId,
              name: leadName,
              domain,
              charter: leadCharter,
              ...(leadIntro === "" ? undefined : { intro: leadIntro }),
              ...(firstAgent && models !== null ? { models } : undefined),
            },
          }).then((result) =>
            result._tag === "Success"
              ? { chatId: result.value.ownerChatId }
              : { cause: squashAtomCommandFailure(result) },
          )
        : await update({
            environmentId,
            input: { orgId, agentId: lead.agentId, ...changes },
          }).then((result) =>
            result._tag === "Success"
              ? { chatId: result.value.ownerChatId }
              : { cause: squashAtomCommandFailure(result) },
          );
    setBusy(false);
    if ("cause" in saved) {
      const { cause } = saved;
      // Another device retired the last agent meanwhile: the models are this form's to choose.
      if (typeof cause === "object" && cause !== null && "reason" in cause) {
        if (cause.reason === "no_models") setNoModels(true);
      }
      setError(kinLeadSaveProblem(cause, lead === null));
      return;
    }
    // The list names chats from the directory and the profile reads the lead list.
    refreshKinAgents(environmentId, orgId);
    closeLeadForm();
    void navigate({
      to: "/kin/$environmentId/$orgId/$chatId",
      params: { environmentId, orgId, chatId: saved.chatId },
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) closeLeadForm();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          className="contents"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{lead === null ? "New agent" : `Edit ${lead.name}`}</DialogTitle>
            <DialogDescription>
              {lead === null
                ? "An agent owns one area of the company. You chat with it like a colleague."
                : "Changes apply from this agent's next reply."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={nameId}>Name</Label>
                <Input
                  id={nameId}
                  value={name}
                  maxLength={KIN_LEAD_NAME_MAX}
                  placeholder="Growth lead"
                  autoFocus
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={areaId}>Area</Label>
                <Input
                  id={areaId}
                  value={area}
                  placeholder="Growth"
                  aria-invalid={areaInvalid}
                  onChange={(event) => setArea(event.target.value)}
                />
                <p
                  className={
                    areaInvalid
                      ? "text-xs text-destructive-foreground"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {areaInvalid
                    ? "Use a word or two in plain letters, such as Finance."
                    : "A word or two, such as Finance or Customer support."}
                </p>
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={charterId}>What it's responsible for</Label>
                <Textarea
                  id={charterId}
                  rows={5}
                  value={charter}
                  aria-invalid={charter.length > KIN_LEAD_CHARTER_MAX}
                  placeholder="Owns growth: acquisition experiments, funnel numbers and a weekly note on what moved."
                  onChange={(event) => setCharter(event.target.value)}
                />
                <p
                  className={
                    charter.length > KIN_LEAD_CHARTER_MAX
                      ? "text-xs text-destructive-foreground"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {charter.length > KIN_LEAD_CHARTER_MAX
                    ? `${charter.length - KIN_LEAD_CHARTER_MAX} characters too long.`
                    : "The agent reads this before every reply. You can change it later."}
                </p>
              </div>
              {firstAgent ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1.5 text-sm font-medium">{KIN_LEAD_MODELS.title}</legend>
                  {models === null ? (
                    <p className="text-xs text-destructive-foreground">{KIN_LEAD_MODELS.none}</p>
                  ) : (
                    <>
                      {(["strong", "cheap"] as const).map((role) => (
                        <div
                          key={role}
                          className="flex flex-wrap items-center justify-between gap-2"
                        >
                          <Label>{KIN_LEAD_MODELS[role]}</Label>
                          <ProviderModelPicker
                            environmentId={environmentId}
                            disabled={busy}
                            activeInstanceId={models[role].instanceId}
                            model={models[role].model}
                            lockedProvider={null}
                            instanceEntries={instanceEntries}
                            modelOptionsByInstance={modelOptionsByInstance}
                            isComposerOwned={false}
                            triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                            triggerAriaLabel={KIN_LEAD_MODELS[role]}
                            onInstanceModelChange={(instanceId, model) =>
                              setPickedModels({ ...models, [role]: { instanceId, model } })
                            }
                          />
                        </div>
                      ))}
                      <p className="text-xs text-muted-foreground">{KIN_LEAD_MODELS.hint}</p>
                    </>
                  )}
                </fieldset>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={introId}>What teammates see</Label>
                <Textarea
                  id={introId}
                  rows={2}
                  value={intro}
                  aria-invalid={intro.length > KIN_LEAD_INTRO_MAX}
                  placeholder="Handles billing questions and invoices."
                  onChange={(event) => setIntro(event.target.value)}
                />
                <p
                  className={
                    intro.length > KIN_LEAD_INTRO_MAX
                      ? "text-xs text-destructive-foreground"
                      : "text-xs text-muted-foreground"
                  }
                >
                  {intro.length > KIN_LEAD_INTRO_MAX
                    ? `${intro.length - KIN_LEAD_INTRO_MAX} characters too long.`
                    : "Optional. People you let message this agent see this and nothing above."}
                </p>
              </div>
              {error === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={closeLeadForm}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave} aria-busy={busy}>
              {lead === null ? "Create agent" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
