import { useAtomValue } from "@effect/atom-react";
import {
  KIN_BRAND,
  KIN_BRAND_FONTS,
  KIN_BRAND_SETTINGS,
  kinBrandDraftOf,
  kinBrandInput,
  kinBrandSample,
  kinContrastHint,
  kinHexColor,
  kinLogoRemoveInput,
  kinLogoResource,
  type KinBrandDraft,
  type KinBrandField,
} from "@t3tools/client-runtime/kin/kinBrand";
import { KIN_COMPANY } from "@t3tools/client-runtime/kin/kinCompanyProfile";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";

import type { KinCompanyProfile } from "@t3tools/contracts";

import { MessageSquareIcon } from "lucide-react";
import { useId, useState } from "react";

import { useAssetUrls } from "../assets/assetUrls";
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
import { Skeleton } from "../components/ui/skeleton";

import { Textarea } from "../components/ui/textarea";

import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";

import { kinClient } from "./kinClient";
import { KinSettingsField, KinSettingsFormDialog } from "./settings/KinSettingsControls";
import { KinSettingsRow, KinSettingsSection } from "./settings/KinSettingsLayout";
import { kinHostConnected } from "./useKinHost";
import { useKinAskAgent } from "./useKinMoney";
import { type KinWorkTarget } from "./useKinWork";

const SERIF = new Set(["Libertinus Serif", "New Computer Modern"]);
const fontStack = (font: string | null) =>
  font === null
    ? undefined
    : `"${font}", ${SERIF.has(font) ? "Georgia, serif" : font.includes("Mono") ? "monospace" : "system-ui, sans-serif"}`;

/** A letterhead drawn with the draft's colours and font, so a change is seen before it is saved. */
function SampleHeader(props: {
  readonly profile: KinCompanyProfile;
  readonly draft: KinBrandDraft;
  readonly logoUrl: string | null;
}) {
  const sample = kinBrandSample(props.draft);
  const name = props.profile.tradeName ?? props.profile.legalName ?? "Your company";
  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="text-xs text-muted-foreground">{KIN_BRAND.sample}</figcaption>
      <div
        className="flex flex-col gap-3 rounded-md border border-border bg-white p-4"
        style={{ fontFamily: fontStack(sample.font), color: "#111827" }}
      >
        <div className="flex items-start gap-3">
          {props.logoUrl === null ? null : (
            <img src={props.logoUrl} alt="" className="size-10 shrink-0 object-contain" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-base font-semibold break-words" style={{ color: sample.primary }}>
              {name}
            </p>
            <p className="text-xs" style={{ color: sample.secondary }}>
              Tax invoice
            </p>
          </div>
          <p className="text-right text-xs tabular-nums" style={{ color: sample.secondary }}>
            INV/26-27/001
          </p>
        </div>
        <div className="h-0.5 rounded-full" style={{ backgroundColor: sample.primary }} />
        {sample.footer === null ? null : (
          <p className="text-2xs" style={{ color: sample.secondary }}>
            {sample.footer}
          </p>
        )}
      </div>
    </figure>
  );
}

function ColorField(props: {
  readonly label: string;
  readonly value: string;
  readonly problem: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const id = useId();
  const hex = kinHexColor(props.value);
  const hint = props.problem === undefined ? kinContrastHint(props.value) : null;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{props.label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${props.label} picker`}
          value={typeof hex === "string" ? hex.toLowerCase() : "#000000"}
          disabled={props.disabled}
          onChange={(event) => props.onChange(event.target.value.toUpperCase())}
          className="h-9 w-11 shrink-0 cursor-pointer rounded-md border border-input bg-transparent p-1 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-not-allowed"
        />
        <Input
          id={id}
          value={props.value}
          placeholder={KIN_BRAND.colorPlaceholder}
          disabled={props.disabled}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={props.problem !== undefined}
          aria-describedby={`${id}-hint`}
          onChange={(event) => props.onChange(event.target.value)}
        />
      </div>
      <p
        id={`${id}-hint`}
        className={
          props.problem !== undefined || hint?.ok === false
            ? "text-xs text-warning-foreground"
            : "text-xs text-muted-foreground"
        }
      >
        {props.problem ?? hint?.text ?? " "}
      </p>
    </div>
  );
}

/** The company's logo, colours, font and footer as rows; one form changes them, logo aside. */
export function KinBrandSection(
  props: KinWorkTarget & { readonly profile: KinCompanyProfile; readonly onRefresh: () => void },
) {
  const { environmentId, profile } = props;
  const canEdit = useAtomValue(kinClient.companyProfileSet.permissionAtom(environmentId));
  const asker = useKinAskAgent(props);
  const [logoUrl = null] = useAssetUrls(
    environmentId,
    profile.logo === null ? [] : [kinLogoResource(profile.logo)],
  );
  const [editing, setEditing] = useState(false);
  const brand = profile.brand;
  const open = canEdit ? { onOpen: () => setEditing(true) } : {};
  return (
    <KinSettingsSection title={KIN_BRAND.title} description={KIN_BRAND_SETTINGS.detail}>
      <KinSettingsRow
        title={KIN_BRAND.logo}
        detail={profile.logo === null ? KIN_BRAND_SETTINGS.logoNone : profile.logo.name}
        leading={
          profile.logo === null ? undefined : logoUrl === null ? (
            <Skeleton className="size-5" />
          ) : (
            <img src={logoUrl} alt="" className="max-h-full max-w-full object-contain" />
          )
        }
        control={
          asker === null ? null : (
            <Button size="xs" variant="outline" onClick={() => asker.ask(KIN_BRAND.askLogoDraft)}>
              <MessageSquareIcon />
              {profile.logo === null ? KIN_BRAND.askLogo : KIN_BRAND_SETTINGS.sendNew}
            </Button>
          )
        }
      />
      <KinSettingsRow
        title={KIN_BRAND_SETTINGS.colours}
        detail={KIN_BRAND_SETTINGS.coloursLine(brand.primaryColor, brand.secondaryColor)}
        openLabel={`${KIN_BRAND.edit}: ${KIN_BRAND_SETTINGS.colours}`}
        {...open}
      />
      <KinSettingsRow
        title={KIN_BRAND.font}
        detail={brand.font ?? KIN_BRAND.defaultFont}
        openLabel={`${KIN_BRAND.edit}: ${KIN_BRAND.font}`}
        {...open}
      />
      <KinSettingsRow
        title={KIN_BRAND.footer}
        detail={brand.footer ?? KIN_BRAND_SETTINGS.none}
        openLabel={`${KIN_BRAND.edit}: ${KIN_BRAND.footer}`}
        {...open}
      />
      <div className="px-4 pt-3 pb-4">
        <SampleHeader profile={profile} draft={kinBrandDraftOf(brand)} logoUrl={logoUrl} />
      </div>
      {editing ? (
        <BrandDialog {...props} logoUrl={logoUrl} onClose={() => setEditing(false)} />
      ) : null}
    </KinSettingsSection>
  );
}

/** Colours, font and footer, seen on the sample as they are typed, saved together. */
function BrandDialog(
  props: KinWorkTarget & {
    readonly profile: KinCompanyProfile;
    readonly logoUrl: string | null;
    readonly onRefresh: () => void;
    readonly onClose: () => void;
  },
) {
  const { environmentId, orgId, profile } = props;
  const set = useAtomCommand(kinClient.companyProfileSet, { reportFailure: false });
  const [draft, setDraft] = useState<KinBrandDraft>(() => kinBrandDraftOf(profile.brand));
  const [problems, setProblems] = useState<Partial<Record<KinBrandField, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const send = async (input: Parameters<typeof set>[0]["input"]) => {
    setSaving(true);
    setProblem(null);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => set({ environmentId, input }),
    });
    setSaving(false);
    props.onRefresh();
    if (!outcome.ok) return setProblem(outcome.changed ? KIN_COMPANY.changed : outcome.problem);
    props.onClose();
  };
  const save = () => {
    const checked = kinBrandInput(orgId, profile, draft);
    if (!checked.ok) return setProblems(checked.problems);
    setProblems({});
    if (checked.input === null) return props.onClose();
    void send(checked.input);
  };
  return (
    <>
      <KinSettingsFormDialog
        title={KIN_BRAND.edit}
        description={KIN_BRAND_SETTINGS.detail}
        submitLabel={KIN_BRAND_SETTINGS.save}
        busy={saving}
        problem={problem}
        remove={
          profile.logo === null ? undefined : (
            <Button
              type="button"
              variant="ghost-destructive"
              disabled={saving}
              onClick={() => setRemoving(true)}
            >
              {KIN_BRAND.removeLogo}
            </Button>
          )
        }
        onSubmit={save}
        onClose={props.onClose}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <ColorField
            label={KIN_BRAND.primary}
            value={draft.primaryColor}
            problem={problems.primaryColor}
            disabled={saving}
            onChange={(primaryColor) => setDraft({ ...draft, primaryColor })}
          />
          <ColorField
            label={KIN_BRAND.secondary}
            value={draft.secondaryColor}
            problem={problems.secondaryColor}
            disabled={saving}
            onChange={(secondaryColor) => setDraft({ ...draft, secondaryColor })}
          />
        </div>
        <KinSettingsField label={KIN_BRAND.font}>
          {(ids) => (
            <Select
              value={draft.font ?? ""}
              disabled={saving}
              onValueChange={(value) =>
                setDraft({ ...draft, font: KIN_BRAND_FONTS.find((one) => one === value) ?? null })
              }
            >
              <SelectTrigger id={ids.control} className="w-full">
                <SelectValue>{draft.font ?? KIN_BRAND.defaultFont}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="">{KIN_BRAND.defaultFont}</SelectItem>
                {KIN_BRAND_FONTS.map((font) => (
                  <SelectItem key={font} value={font}>
                    <span style={{ fontFamily: fontStack(font) }}>{font}</span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
        </KinSettingsField>
        <KinSettingsField label={KIN_BRAND.footer} help={problems.footer}>
          {(ids) => (
            <Textarea
              id={ids.control}
              rows={2}
              value={draft.footer}
              disabled={saving}
              aria-invalid={problems.footer !== undefined}
              onChange={(event) => setDraft({ ...draft, footer: event.target.value })}
            />
          )}
        </KinSettingsField>
        <SampleHeader profile={profile} draft={draft} logoUrl={props.logoUrl} />
      </KinSettingsFormDialog>
      <KinConfirm
        ask={
          removing
            ? {
                title: KIN_BRAND.removeTitle,
                detail: KIN_BRAND.removeDetail,
                action: KIN_BRAND.removeLogo,
                destructive: true,
              }
            : null
        }
        onConfirm={() => void send(kinLogoRemoveInput(orgId, profile))}
        onClose={() => setRemoving(false)}
      />
    </>
  );
}
