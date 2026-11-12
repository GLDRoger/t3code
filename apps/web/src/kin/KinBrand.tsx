import { useAtomValue } from "@effect/atom-react";
import {
  KIN_BRAND,
  KIN_BRAND_FONTS,
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

import { MessageSquareIcon, PaletteIcon, Trash2Icon } from "lucide-react";
import { useId, useState } from "react";

import { useAssetUrls } from "../assets/assetUrls";
import { Alert, AlertDescription } from "../components/ui/alert";

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
import { kinHostConnected } from "./useKinHost";
import { useKinAskAgent } from "./useKinMoney";
import { type KinWorkTarget } from "./useKinWork";

const SERIF = new Set(["Libertinus Serif", "New Computer Modern"]);
const fontStack = (font: string | null) =>
  font === null
    ? undefined
    : `"${font}", ${SERIF.has(font) ? "Georgia, serif" : font.includes("Mono") ? "monospace" : "system-ui, sans-serif"}`;

export function KinSettingsHeading(props: { readonly title: string; readonly detail: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
      <p className="text-xs text-muted-foreground">{props.detail}</p>
    </div>
  );
}

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

/** The company's logo, colours, font and footer, as every brand-aware template uses them. */
export function KinBrandSection(
  props: KinWorkTarget & { readonly profile: KinCompanyProfile; readonly onRefresh: () => void },
) {
  const { environmentId, orgId, profile } = props;
  const canEdit = useAtomValue(kinClient.companyProfileSet.permissionAtom(environmentId));
  const set = useAtomCommand(kinClient.companyProfileSet, { reportFailure: false });
  const asker = useKinAskAgent(props);
  const [logoUrl = null] = useAssetUrls(
    environmentId,
    profile.logo === null ? [] : [kinLogoResource(profile.logo)],
  );
  const [draft, setDraft] = useState<KinBrandDraft | null>(null);
  const [problems, setProblems] = useState<Partial<Record<KinBrandField, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [removing, setRemoving] = useState(false);
  const fontId = useId();
  const footerId = useId();
  const send = async (input: Parameters<typeof set>[0]["input"]) => {
    setSaving(true);
    setProblem(null);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => set({ environmentId, input }),
    });
    setSaving(false);
    props.onRefresh();
    if (!outcome.ok) setProblem(outcome.changed ? KIN_COMPANY.changed : outcome.problem);
    return outcome.ok;
  };
  const save = async (typed: KinBrandDraft) => {
    const checked = kinBrandInput(orgId, profile, typed);
    if (!checked.ok) return setProblems(checked.problems);
    setProblems({});
    if (checked.input === null) return setDraft(null);
    if (await send(checked.input)) {
      setDraft(null);
      setSaved(true);
    }
  };
  const shown = draft ?? kinBrandDraftOf(profile.brand);
  const logo = (
    <div className="flex items-start gap-3">
      {profile.logo === null ? null : (
        <div className="flex size-16 shrink-0 items-center justify-center rounded-md border border-border bg-white p-1.5">
          {logoUrl === null ? (
            <Skeleton className="size-full" />
          ) : (
            <img
              src={logoUrl}
              alt={`${KIN_BRAND.logo}: ${profile.logo.name}`}
              className="max-h-full max-w-full object-contain"
            />
          )}
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
        <p className="text-sm text-foreground">
          {profile.logo === null ? KIN_BRAND.noLogo : profile.logo.name}
        </p>
        <p className="text-xs text-muted-foreground">
          {profile.logo === null ? KIN_BRAND.addLogo : KIN_BRAND.changeLogo}
        </p>
        <div className="flex flex-wrap gap-2">
          {asker === null ? null : (
            <Button size="sm" variant="outline" onClick={() => asker.ask(KIN_BRAND.askLogoDraft)}>
              <MessageSquareIcon />
              {KIN_BRAND.askLogo}
            </Button>
          )}
          {profile.logo !== null && canEdit ? (
            <Button size="sm" variant="outline" disabled={saving} onClick={() => setRemoving(true)}>
              <Trash2Icon />
              {KIN_BRAND.removeLogo}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
  return (
    <section
      className="flex flex-col gap-4 border-t border-border pt-5"
      aria-labelledby={`${fontId}-title`}
    >
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:gap-4">
        <div id={`${fontId}-title`} className="min-w-0 flex-1">
          <KinSettingsHeading title={KIN_BRAND.title} detail={KIN_BRAND.detail} />
        </div>
        {canEdit && draft === null ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setSaved(false);
              setDraft(kinBrandDraftOf(profile.brand));
            }}
          >
            <PaletteIcon />
            {KIN_BRAND.edit}
          </Button>
        ) : null}
      </div>
      {logo}
      {draft === null ? (
        <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-6 gap-y-1.5 text-sm">
          {(
            [
              [KIN_BRAND.primary, profile.brand.primaryColor],
              [KIN_BRAND.secondary, profile.brand.secondaryColor],
            ] as const
          ).map(([label, color]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="flex items-center gap-2 font-mono text-xs text-foreground">
                {color === null ? (
                  <span className="font-sans text-sm text-muted-foreground">
                    {KIN_BRAND.defaultFont}
                  </span>
                ) : (
                  <>
                    <span
                      aria-hidden
                      className="size-3.5 rounded-sm border border-border"
                      style={{ backgroundColor: color }}
                    />
                    {color}
                  </>
                )}
              </dd>
            </div>
          ))}
          <dt className="text-muted-foreground">{KIN_BRAND.font}</dt>
          <dd className="text-foreground">{profile.brand.font ?? KIN_BRAND.defaultFont}</dd>
          <dt className="text-muted-foreground">{KIN_BRAND.footer}</dt>
          <dd className="min-w-0 break-words text-foreground">{profile.brand.footer ?? "None"}</dd>
        </dl>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void save(draft);
          }}
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
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={fontId}>{KIN_BRAND.font}</Label>
            <Select
              value={draft.font ?? ""}
              disabled={saving}
              onValueChange={(value) =>
                setDraft({ ...draft, font: KIN_BRAND_FONTS.find((one) => one === value) ?? null })
              }
            >
              <SelectTrigger id={fontId} className="w-full sm:w-80">
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
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={footerId}>{KIN_BRAND.footer}</Label>
            <Textarea
              id={footerId}
              rows={2}
              value={draft.footer}
              placeholder={KIN_BRAND.footerPlaceholder}
              disabled={saving}
              aria-invalid={problems.footer !== undefined}
              onChange={(event) => setDraft({ ...draft, footer: event.target.value })}
            />
            {problems.footer === undefined ? null : (
              <p className="text-xs text-destructive-foreground">{problems.footer}</p>
            )}
          </div>
          <SampleHeader profile={profile} draft={shown} logoUrl={logoUrl} />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={saving}
              onClick={() => {
                setProblems({});
                setProblem(null);
                setDraft(null);
              }}
            >
              {KIN_BRAND.cancel}
            </Button>
            <Button type="submit" disabled={saving} aria-busy={saving}>
              {KIN_BRAND.save}
            </Button>
          </div>
        </form>
      )}
      {draft === null ? <SampleHeader profile={profile} draft={shown} logoUrl={logoUrl} /> : null}
      {saved ? (
        <p role="status" className="text-xs text-muted-foreground">
          {KIN_BRAND.saved}
        </p>
      ) : null}
      {problem === null ? null : (
        <Alert variant="error">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      )}
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
    </section>
  );
}
