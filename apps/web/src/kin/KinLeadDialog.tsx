import { useAtomValue } from "@effect/atom-react";
import {
  KIN_AGENT_PAGE,
  kinAgentWriteCharacterStarter,
} from "@t3tools/client-runtime/kin/kinAgentPage";
import {
  kinDomainLabel,
  KIN_LEAD_CHARTER_MAX,
  KIN_LEAD_MODELS,
  KIN_LEAD_INTRO_MAX,
  KIN_LEAD_NAME_MAX,
  kinDomainSlug,
  kinLeadChanges,
  kinLeadDraftCheck,
  kinLeadDraftOf,
  kinLeadSaveProblem,
  kinLeadStartingModel,
  KIN_AGENTS_COPY,
} from "@t3tools/client-runtime/kin/kinLeadPresentation";
import { kinFormTyped } from "@t3tools/client-runtime/kin/kinWorkForms";
import type { ModelSelection } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

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
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Textarea } from "../components/ui/textarea";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { kinClient, refreshKinAgents } from "./kinClient";
import { useKinFormDiscard } from "./KinFormDiscard";
import { KinAgentModelPicker, useKinAgentModels } from "./KinAgentModelPicker";
import { prefillKinDraft } from "./kinDraft";
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
  // The org's first agent picks the model; the host gives every later one the same.
  const leads = useAtomValue(kinClient.leads({ environmentId, input: { orgId } }));
  const [noModels, setNoModels] = useState(false);
  const firstAgent =
    lead === null &&
    (noModels ||
      (AsyncResult.isSuccess(leads) &&
        leads.value.leads.every((held) => held.retired !== undefined)));
  const { offered, withMediumEffort } = useKinAgentModels(environmentId);
  const companyDefault = Option.getOrNull(
    AsyncResult.value(useAtomValue(kinClient.agentDefaults({ environmentId, input: { orgId } }))),
  )?.model;
  const [pickedModel, setPickedModel] = useState<ModelSelection | null>(null);
  const starting = kinLeadStartingModel(offered);
  const model =
    pickedModel ?? companyDefault ?? (starting === null ? null : withMediumEffort(starting));
  const [character, setCharacter] = useState("");
  const [writeForMe, setWriteForMe] = useState(false);
  const setCharacterBody = useAtomCommand(kinClient.characterSet, { reportFailure: false });
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
  const characterId = useId();

  const checked = kinLeadDraftCheck({ name, area, charter, intro });
  const discard = useKinFormDiscard(
    kinFormTyped(initial, { name, area, charter, intro }) ||
      character.trim() !== "" ||
      writeForMe ||
      pickedModel !== null,
    closeLeadForm,
  );
  const areaInvalid = area.trim() !== "" && kinDomainSlug(area) === null;
  const canSave = checked.ok && !busy && !(firstAgent && model === null);

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
              ...((firstAgent || pickedModel !== null) && model !== null ? { model } : undefined),
            },
          }).then(async (result) => {
            if (result._tag !== "Success") return { cause: squashAtomCommandFailure(result) };
            // The host gives every new agent a starter character; the owner's own replaces it.
            if (character.trim() !== "")
              await setCharacterBody({
                environmentId,
                input: { orgId, agentId: result.value.agentId, body: character.trim() },
              });
            const chief = Option.getOrNull(AsyncResult.value(leads))?.leads.find(
              (held) => held.domain === "chief-of-staff" && held.retired === undefined,
            );
            if (writeForMe && chief !== undefined) {
              prefillKinDraft(
                environmentId,
                orgId,
                chief.ownerChatId,
                kinAgentWriteCharacterStarter(leadName, kinDomainLabel(domain)),
              );
              return { chatId: chief.ownerChatId };
            }
            return { chatId: result.value.ownerChatId };
          })
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
      // Another device retired the last agent meanwhile: the model is this form's to choose.
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
        if (!open && !busy) discard.close();
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
                  autoFocus
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={areaId}>Area</Label>
                <Input
                  id={areaId}
                  value={area}
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
                <Label htmlFor={charterId}>{KIN_AGENTS_COPY.charterLabel}</Label>
                <Textarea
                  id={charterId}
                  rows={5}
                  value={charter}
                  aria-invalid={charter.length > KIN_LEAD_CHARTER_MAX}
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
              {lead === null ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1.5 text-sm font-medium">{KIN_LEAD_MODELS.title}</legend>
                  {model === null ? (
                    <p className="text-xs text-destructive-foreground">{KIN_LEAD_MODELS.none}</p>
                  ) : (
                    <>
                      <KinAgentModelPicker
                        environmentId={environmentId}
                        disabled={busy}
                        label={KIN_LEAD_MODELS.title}
                        selection={model}
                        onChange={setPickedModel}
                      />
                      <p className="text-xs text-muted-foreground">
                        {firstAgent ? KIN_LEAD_MODELS.hint : KIN_AGENT_PAGE.modelDetail}
                      </p>
                    </>
                  )}
                </fieldset>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={introId}>{KIN_AGENTS_COPY.introLabel}</Label>
                <Textarea
                  id={introId}
                  rows={2}
                  value={intro}
                  aria-invalid={intro.length > KIN_LEAD_INTRO_MAX}
                  placeholder={KIN_AGENTS_COPY.charterExample}
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
                    : KIN_AGENTS_COPY.teammateViewHint}
                </p>
              </div>
              {lead === null ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <Label htmlFor={characterId}>{KIN_AGENT_PAGE.characterField}</Label>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Checkbox
                        checked={writeForMe}
                        disabled={character.trim() !== ""}
                        onCheckedChange={(checked) => setWriteForMe(checked === true)}
                      />
                      {KIN_AGENT_PAGE.writeForMe}
                    </label>
                  </div>
                  <Textarea
                    id={characterId}
                    rows={4}
                    value={character}
                    disabled={writeForMe}
                    placeholder={KIN_AGENT_PAGE.characterPlaceholder}
                    onChange={(event) => setCharacter(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    {writeForMe ? KIN_AGENT_PAGE.writeForMeDetail : KIN_AGENT_PAGE.characterRule}
                  </p>
                </div>
              ) : null}
              {error === null ? null : (
                <Alert variant="error">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={discard.close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSave} aria-busy={busy}>
              {lead === null ? "Create agent" : "Save changes"}
            </Button>
          </DialogFooter>
        </form>
        {discard.ask}
      </DialogPopup>
    </Dialog>
  );
}
