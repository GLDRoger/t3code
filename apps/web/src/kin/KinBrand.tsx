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
import {
  KIN_TEMPLATES,
  kinTemplateGroups,
  type KinTemplateView,
} from "@t3tools/client-runtime/kin/kinTemplates";
import type { KinCompanyProfile } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  EyeIcon,
  LockOpenIcon,
  MessageSquareIcon,
  PaletteIcon,
  RotateCcwIcon,
  Trash2Icon,
} from "lucide-react";
import { useId, useState } from "react";

import { useAssetUrls } from "../assets/assetUrls";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
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
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";
import { kinPreviewUrl } from "./KinInvoice";
import { kinClient } from "./kinClient";
import { kinHostConnected } from "./useKinHost";
import {
  useKinAskAgent,
  useKinMoneyActions,
  useKinRecipes,
  type KinPreviewFile,
} from "./useKinMoney";
import { useKinWorkDirectory, type KinWorkTarget } from "./useKinWork";

const SERIF = new Set(["Libertinus Serif", "New Computer Modern"]);
const fontStack = (font: string | null) =>
  font === null
    ? undefined
    : `"${font}", ${SERIF.has(font) ? "Georgia, serif" : font.includes("Mono") ? "monospace" : "system-ui, sans-serif"}`;

function SectionHeading(props: { readonly title: string; readonly detail: string }) {
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
          <SectionHeading title={KIN_BRAND.title} detail={KIN_BRAND.detail} />
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

type Ask = { readonly kind: "undo" | "clear"; readonly template: KinTemplateView };

/** The templates Kin makes documents from: who changed each last, a preview, and ways back. */
export function KinTemplatesSection(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const allowed = useAtomValue(kinClient.companyRead.permissionAtom(environmentId));
  const canUndo = useAtomValue(kinClient.undoRecipe.permissionAtom(environmentId));
  const canClear = useAtomValue(kinClient.clearRecipeLabel.permissionAtom(environmentId));
  const canPreview = useAtomValue(kinClient.docRender.permissionAtom(environmentId));
  const recipes = useKinRecipes(props, allowed);
  const { names } = useKinWorkDirectory(props, allowed);
  const asker = useKinAskAgent(props);
  const actions = useKinMoneyActions(props);
  const undo = useAtomCommand(kinClient.undoRecipe, { reportFailure: false });
  const clear = useAtomCommand(kinClient.clearRecipeLabel, { reportFailure: false });
  const [asking, setAsking] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  const [shown, setShown] = useState<{
    readonly title: string;
    readonly url: string;
    readonly file: KinPreviewFile;
  } | null>(null);
  const [now] = useState(() => new Date());
  const closePreview = () => {
    if (shown !== null) URL.revokeObjectURL(shown.url);
    setShown(null);
  };
  const preview = async (template: KinTemplateView, list: string | null) => {
    setSaid(null);
    let entry;
    if (list !== null) {
      const latest = await kinClient.workList.run(appAtomRegistry, {
        environmentId,
        input: { orgId, list, limit: 1 },
      });
      entry = AsyncResult.isSuccess(latest) ? latest.value.records[0]?.key : undefined;
      if (entry === undefined) return setSaid({ ok: false, text: KIN_TEMPLATES.noPreviewEntry });
    }
    const files = await actions.preview(template.name, entry);
    const file = files?.[0];
    if (file === undefined) {
      if (files !== null) setSaid({ ok: false, text: KIN_TEMPLATES.previewFailed });
      return;
    }
    setShown({ title: template.title, url: kinPreviewUrl(file), file });
  };
  const confirm = async (ask: Ask) => {
    setBusy(true);
    setSaid(null);
    const input = { orgId, recipe: ask.template.name };
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () =>
        ask.kind === "undo"
          ? undo({ environmentId, input })
          : clear({ environmentId, input: { ...input, commit: ask.template.commit } }),
    });
    setBusy(false);
    recipes.refresh();
    if (!outcome.ok) return setSaid({ ok: false, text: outcome.problem });
    setSaid({
      ok: true,
      text:
        ask.kind === "clear"
          ? KIN_TEMPLATES.cleared
          : "removed" in outcome.value && outcome.value.removed
            ? KIN_TEMPLATES.removed
            : KIN_TEMPLATES.undone,
    });
  };
  const heading = (
    <div className="flex flex-col items-start gap-2 sm:flex-row sm:gap-4">
      <div className="min-w-0 flex-1">
        <SectionHeading title={KIN_TEMPLATES.title} detail={KIN_TEMPLATES.detail} />
      </div>
      {asker === null ? null : (
        <Button size="sm" variant="outline" onClick={() => asker.ask(KIN_TEMPLATES.askChangeDraft)}>
          <MessageSquareIcon />
          {KIN_TEMPLATES.askChange}
        </Button>
      )}
    </div>
  );
  if (!allowed) return null;
  const { state } = recipes;
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-5">
      {heading}
      {state._tag === "loading" ? (
        <div className="flex flex-col gap-2" role="status" aria-label="Loading templates">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-3.5 w-1/2" />
        </div>
      ) : state._tag !== "ready" ? (
        <div className="flex flex-col items-start gap-2">
          <Alert variant="error">
            <AlertDescription>
              Couldn't load your templates. Check your connection.
            </AlertDescription>
          </Alert>
          <Button size="sm" variant="outline" onClick={recipes.refresh}>
            Retry
          </Button>
        </div>
      ) : state.value.recipes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{KIN_TEMPLATES.empty}</p>
      ) : (
        kinTemplateGroups(state.value.recipes, names, now).map((group) => (
          <div key={group.list ?? "other"} className="flex flex-col gap-1">
            <h4 className="text-xs text-muted-foreground">{group.title}</h4>
            <ul className="flex flex-col divide-y divide-border/60 rounded-md border border-border">
              {group.templates.map((template) => (
                <li key={template.name} className="flex flex-col gap-2 p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-foreground">{template.title}</span>
                    {template.labelled ? (
                      <Badge size="sm" variant="warning">
                        {KIN_TEMPLATES.private}
                      </Badge>
                    ) : null}
                  </div>
                  {template.description === null ? null : (
                    <p className="text-xs text-muted-foreground">{template.description}</p>
                  )}
                  <p className="text-xs text-muted-foreground">{template.changed}</p>
                  {template.labelled ? (
                    <p className="text-xs text-muted-foreground">{KIN_TEMPLATES.privateDetail}</p>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {canPreview ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={actions.busy || busy}
                        onClick={() => void preview(template, group.list)}
                      >
                        <EyeIcon />
                        {KIN_TEMPLATES.preview}
                      </Button>
                    ) : null}
                    {canUndo && template.canUndo ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setAsking({ kind: "undo", template })}
                      >
                        <RotateCcwIcon />
                        {KIN_TEMPLATES.undo}
                      </Button>
                    ) : null}
                    {canClear && template.labelled ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setAsking({ kind: "clear", template })}
                      >
                        <LockOpenIcon />
                        {KIN_TEMPLATES.clearPrivate}
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))
      )}
      {actions.busy ? (
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {KIN_TEMPLATES.previewing}
        </p>
      ) : null}
      {actions.problem !== null || (said !== null && !said.ok) ? (
        <Alert variant="error">
          <AlertDescription>{actions.problem ?? said?.text}</AlertDescription>
        </Alert>
      ) : said !== null ? (
        <p role="status" className="text-xs text-muted-foreground">
          {said.text}
        </p>
      ) : null}
      <KinConfirm
        ask={
          asking === null
            ? null
            : asking.kind === "undo"
              ? {
                  title: KIN_TEMPLATES.undoTitle,
                  detail: KIN_TEMPLATES.undoDetail,
                  action: KIN_TEMPLATES.undo,
                }
              : {
                  title: KIN_TEMPLATES.clearTitle,
                  detail: KIN_TEMPLATES.clearDetail,
                  action: KIN_TEMPLATES.clearPrivate,
                }
        }
        onConfirm={() => {
          if (asking !== null) void confirm(asking);
        }}
        onClose={() => setAsking(null)}
      />
      <Dialog
        open={shown !== null}
        onOpenChange={(open) => {
          if (!open) closePreview();
        }}
      >
        <DialogPopup className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{shown?.title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {shown === null ? null : (
              // oxlint-disable-next-line react/iframe-missing-sandbox -- Chrome will not render a PDF in a sandboxed frame; the src is a blob made here
              <iframe
                title={`${KIN_TEMPLATES.preview}: ${shown.file.name}`}
                src={shown.url}
                className="h-[60vh] w-full rounded-md border border-border bg-white"
              />
            )}
          </DialogPanel>
          <DialogFooter>
            {shown === null ? null : (
              <Button variant="outline" render={<a href={shown.url} download={shown.file.name} />}>
                Download preview
              </Button>
            )}
            <Button onClick={closePreview}>Done</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </section>
  );
}
