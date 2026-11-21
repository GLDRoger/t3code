import { useAtomValue } from "@effect/atom-react";
import {
  KIN_COMPANY,
  KIN_COMPANY_SETTINGS,
  kinCompanyCountrySuggestion,
  kinCompanyEditSections,
  kinCompanyDraftOf,
  kinCountryName,
  kinDeviceRegion,
  kinCompanyInput,
  kinCompanyRead,
  type KinCompanyDraft,
  type KinCompanyFieldId,
} from "@t3tools/client-runtime/kin/kinCompanyProfile";
import { KIN_OFFLINE_PAGE, kinFailureText } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import { KIN_SETTINGS_COPY } from "@t3tools/client-runtime/kin/kinSettingsSpread";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { KinCompanyProfile } from "@t3tools/contracts";
import { useState } from "react";

import { useSearchableSetting } from "../components/settings/settingsSearch";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import { useAtomCommand } from "../state/use-atom-command";
import { readPreparedConnection } from "../state/session";
import { KinBrandSection } from "./KinBrand";
import { KinTemplatesSection } from "./KinTemplates";
import { kinNewLeadTarget } from "./KinNewLeadButton";
import { kinClient } from "./kinClient";
import { KinSettingsField, KinSettingsFormDialog } from "./settings/KinSettingsControls";
import {
  KinSettingsEmpty,
  KinSettingsFacts,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsRow,
  KinSettingsSection,
} from "./settings/KinSettingsLayout";
import { KinGateFailed } from "./KinWorkParts";
import { kinHostConnected, useKinGate, useKinHost } from "./useKinHost";
import { useKinCompanyProfile, useKinCountryNeeded } from "./useKinMoney";
import type { KinWorkTarget } from "./useKinWork";

/**
 * The company's legal, tax and bank details, its brand, templates and data, as sections of
 * Settings → Company details, for whoever runs this Kin and nobody else.
 */
export function KinCompanyProfileSettings() {
  const target = kinNewLeadTarget(useKinHost());
  if (target === null) return <Notice>{KIN_COMPANY.noKin.detail}</Notice>;
  return <Permitted environmentId={target.environmentId} orgId={target.orgId} />;
}

function Notice(props: { readonly children: string; readonly onRetry?: () => void }) {
  const searchableSetting = useSearchableSetting();
  return (
    <KinSettingsSection
      title={KIN_COMPANY_SETTINGS.company}
      searchId={searchableSetting("company-details").id}
    >
      {props.onRetry === undefined ? (
        <KinSettingsEmpty>{props.children}</KinSettingsEmpty>
      ) : (
        <KinSettingsLoadFailed onRetry={props.onRetry}>{props.children}</KinSettingsLoadFailed>
      )}
    </KinSettingsSection>
  );
}

function Permitted(props: KinWorkTarget) {
  const gate = useKinGate(
    kinClient.companyRead.permissionStateAtom(props.environmentId),
    props.environmentId,
  );
  const { state, refresh } = useKinCompanyProfile(props, gate === null);
  const searchableSetting = useSearchableSetting();
  if (gate === "refused" || state._tag === "refused")
    return <Notice>{KIN_COMPANY.onlyOwner.detail}</Notice>;
  if (gate === "offline") return <Notice>{KIN_OFFLINE_PAGE.detail}</Notice>;
  if (gate === "failed")
    return (
      <KinSettingsSection
        title={KIN_COMPANY_SETTINGS.company}
        searchId={searchableSetting("company-details").id}
      >
        <KinGateFailed className="px-4 py-3" />
      </KinSettingsSection>
    );
  if (state._tag === "loading") {
    return (
      <KinSettingsSection
        title={KIN_COMPANY_SETTINGS.company}
        searchId={searchableSetting("company-details").id}
      >
        <KinSettingsLoading rows={4} />
      </KinSettingsSection>
    );
  }
  if (state._tag !== "ready") {
    const text =
      state._tag === "failed"
        ? kinFailureText(state.cause, `${KIN_COMPANY.loadFailed}.`)
        : `${KIN_COMPANY.loadFailed}.`;
    return <Notice onRetry={refresh}>{text}</Notice>;
  }
  return <Profile {...props} profile={state.value} onRefresh={refresh} />;
}

function Profile(
  props: KinWorkTarget & { readonly profile: KinCompanyProfile; readonly onRefresh: () => void },
) {
  const { environmentId, orgId, profile } = props;
  const canEdit = useAtomValue(kinClient.companyProfileSet.permissionAtom(environmentId));
  const searchableSetting = useSearchableSetting();
  const [editing, setEditing] = useState(false);
  const [company, tax, bank] = kinCompanyRead(profile);
  const facts = (section: typeof company) =>
    (section?.rows ?? []).map((row) => ({
      label: row.label,
      value: row.id === "country" ? kinCountryName(row.value) : row.value,
    }));
  const companyFacts = [...facts(company), ...facts(tax)];
  const bankFacts = facts(bank);
  return (
    <>
      <KinSettingsSection
        title={KIN_COMPANY_SETTINGS.company}
        description={KIN_COMPANY_SETTINGS.companyDetail}
        searchId={searchableSetting("company-details").id}
        action={
          canEdit ? (
            <Button size="xs" variant="outline" onClick={() => setEditing(true)}>
              {KIN_SETTINGS_COPY.edit}
            </Button>
          ) : undefined
        }
      >
        <KinSettingsFacts
          facts={[
            ...(companyFacts.length === 0
              ? [{ label: KIN_COMPANY_SETTINGS.legalName, value: KIN_COMPANY_SETTINGS.notSet }]
              : companyFacts),
            ...(bankFacts.length === 0
              ? [
                  {
                    label: KIN_COMPANY_SETTINGS.bank,
                    value: KIN_COMPANY_SETTINGS.notSet,
                    attention: KIN_COMPANY_SETTINGS.bankNeeded,
                  },
                ]
              : bankFacts),
          ]}
        />
      </KinSettingsSection>
      <KinBrandSection {...props} profile={profile} onRefresh={props.onRefresh} />
      <KinTemplatesSection environmentId={environmentId} orgId={orgId} />
      {editing ? <ProfileDialog {...props} onClose={() => setEditing(false)} /> : null}
    </>
  );
}

/** Every detail in one form, in the order an invoice needs them. */
function ProfileDialog(
  props: KinWorkTarget & {
    readonly profile: KinCompanyProfile;
    readonly onRefresh: () => void;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId, profile } = props;
  const set = useAtomCommand(kinClient.companyProfileSet, { reportFailure: false });
  const waiting = useKinCountryNeeded(props);
  const region = kinDeviceRegion();
  const [draft, setDraft] = useState<KinCompanyDraft>(() =>
    kinCompanyDraftOf(profile, region, waiting),
  );
  const [problems, setProblems] = useState<Readonly<Partial<Record<KinCompanyFieldId, string>>>>(
    {},
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const checked = kinCompanyInput(orgId, profile, draft);
    setProblem(null);
    if (!checked.ok) return setProblems(checked.problems);
    setProblems({});
    const { input } = checked;
    if (input === null) return props.onClose();
    setSaving(true);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => set({ environmentId, input }),
    });
    setSaving(false);
    props.onRefresh();
    if (!outcome.ok) return setProblem(outcome.changed ? KIN_COMPANY.changed : outcome.problem);
    props.onClose();
  };
  const suggestion = kinCompanyCountrySuggestion(draft, region, waiting);
  const typedCountry = draft.country.trim().toUpperCase();
  return (
    <KinSettingsFormDialog
      title={KIN_COMPANY_SETTINGS.editTitle}
      description={KIN_COMPANY_SETTINGS.companyDetail}
      submitLabel={KIN_COMPANY_SETTINGS.save}
      busy={saving}
      problem={problem}
      onSubmit={() => void save()}
      onClose={props.onClose}
    >
      {kinCompanyEditSections(profile, draft).map((section) => (
        <fieldset key={section.title} className="flex flex-col gap-3">
          <legend className="pb-2 text-xs font-medium text-muted-foreground">
            {section.title}
          </legend>
          {section.fields.map((field) => {
            const fieldProblem = problems[field.id];
            const help =
              fieldProblem === undefined ? (
                field.id === "country" ? (
                  /^[A-Z]{2}$/.test(typedCountry) ? (
                    kinCountryName(typedCountry)
                  ) : (
                    KIN_COMPANY_SETTINGS.countryHelp
                  )
                ) : undefined
              ) : (
                <span className="text-destructive-foreground">{fieldProblem}</span>
              );
            return (
              <KinSettingsField key={field.id} label={field.label} help={help}>
                {(ids) => {
                  const shared = {
                    id: ids.control,
                    value: draft[field.id],
                    placeholder: field.placeholder,
                    disabled: saving,
                    "aria-invalid": fieldProblem !== undefined,
                  };
                  return (
                    <>
                      {field.multiline ? (
                        <Textarea
                          {...shared}
                          rows={3}
                          onChange={(event) =>
                            setDraft({ ...draft, [field.id]: event.target.value })
                          }
                        />
                      ) : (
                        <Input
                          {...shared}
                          type={field.day ? "date" : undefined}
                          autoComplete="off"
                          spellCheck={false}
                          autoCapitalize={field.code ? "characters" : undefined}
                          onChange={(event) =>
                            setDraft({ ...draft, [field.id]: event.target.value })
                          }
                        />
                      )}
                      {field.id === "country" && suggestion !== null ? (
                        <div>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            disabled={saving}
                            onClick={() => setDraft(suggestion.accept())}
                          >
                            {suggestion.label}
                          </Button>
                        </div>
                      ) : null}
                    </>
                  );
                }}
              </KinSettingsField>
            );
          })}
        </fieldset>
      ))}
    </KinSettingsFormDialog>
  );
}

/** Download everything: the owner's alone. The zip streams over HTTP straight to disk. */
export function KinCompanyExportSection(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const allowed = useAtomValue(kinClient.exportLink.permissionAtom(environmentId));
  const link = useAtomCommand(kinClient.exportLink, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "preparing" | "started">("idle");
  const [problem, setProblem] = useState<string | null>(null);
  if (!allowed) return null;
  const download = async () => {
    setState("preparing");
    setProblem(null);
    const failed = (cause: unknown) => {
      setState("idle");
      setProblem(kinFailureText(cause, KIN_COMPANY.export.failed));
    };
    const connection = readPreparedConnection(environmentId);
    if (connection === null) return failed(null);
    const result = await link({ environmentId, input: { orgId } });
    if (result._tag === "Failure") return failed(squashAtomCommandFailure(result));
    const url = resolveAssetUrl(connection.httpBaseUrl, result.value.url);
    if (url === null) return failed(null);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.rel = "noreferrer";
    anchor.click();
    setState("started");
    setOpen(false);
  };
  return (
    <KinSettingsSection title={KIN_COMPANY.export.title}>
      <KinSettingsRow
        title={KIN_COMPANY_SETTINGS.exportRow}
        detail={
          state === "started" ? KIN_COMPANY.export.started : KIN_COMPANY_SETTINGS.exportDetail
        }
        onOpen={() => {
          setProblem(null);
          setOpen(true);
        }}
      />
      {open ? (
        <KinSettingsFormDialog
          title={KIN_COMPANY_SETTINGS.exportRow}
          description={KIN_COMPANY.export.detail}
          submitLabel={KIN_COMPANY_SETTINGS.exportSubmit}
          busy={false}
          notReady={state === "preparing" ? KIN_COMPANY.export.preparing : null}
          problem={problem}
          onSubmit={() => void download()}
          onClose={() => setOpen(false)}
        >
          <p className="text-pretty text-xs text-muted-foreground">{KIN_COMPANY.export.leaves}</p>
        </KinSettingsFormDialog>
      ) : null}
    </KinSettingsSection>
  );
}
