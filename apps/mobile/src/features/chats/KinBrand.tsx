import { useAtomValue } from "@effect/atom-react";
import {
  KIN_BRAND,
  KIN_BRAND_FONTS,
  KIN_BRAND_SWATCHES,
  kinBrandDraftOf,
  kinBrandInput,
  kinBrandSample,
  kinContrastHint,
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
import type { EnvironmentId, KinCompanyLogo, KinCompanyProfile } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { Image } from "expo-image";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { FilePreviewModal } from "../../components/ui/FilePreviewModal";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { Menu } from "../../components/ui/Menu";
import { Notice } from "../../components/ui/Notice";
import { appAtomRegistry } from "../../state/atom-registry";
import { useAssetUrlState } from "../../state/assets";
import { useAtomCommand } from "../../state/use-atom-command";
import type { AttachmentPreviewFile } from "../../lib/attachmentDownload";
import { KinWorkFrame, KinWorkLoading, KinWorkTextField } from "./components/KinWorkPieces";
import { kinWritePreview } from "./KinInvoice";
import { kinClient } from "./state/kinClient";
import { kinHostConnected } from "./state/useKinHost";
import { useKinAskAgent, useKinMoneyActions, useKinRecipes } from "./state/useKinMoney";
import { useKinWorkDirectory, type KinWorkTarget } from "./state/useKinWork";

const SERIF = new Set<string>(["Libertinus Serif", "New Computer Modern"]);
const fontFamily = (font: string | null) =>
  font === null
    ? undefined
    : SERIF.has(font)
      ? Platform.select({ ios: "Georgia", default: "serif" })
      : font.includes("Mono")
        ? Platform.select({ ios: "Menlo", default: "monospace" })
        : undefined;

function useLogoUrl(environmentId: EnvironmentId, logo: KinCompanyLogo | null) {
  const asset = useAssetUrlState(environmentId, logo === null ? null : kinLogoResource(logo));
  return logo !== null && asset._tag === "Success" ? asset.url : null;
}

/** A letterhead in the draft's colours and font, so a change is seen before it is saved. */
function SampleHeader(props: {
  readonly profile: KinCompanyProfile;
  readonly draft: KinBrandDraft;
  readonly logoUrl: string | null;
}) {
  const sample = kinBrandSample(props.draft);
  const family = fontFamily(sample.font);
  const name = props.profile.tradeName ?? props.profile.legalName ?? "Your company";
  return (
    <View className="gap-2 px-2">
      <Text textRole="footnote" className="text-foreground-muted">
        {KIN_BRAND.sample}
      </Text>
      <View
        className="gap-3 rounded-xl border border-border bg-white p-4"
        accessibilityLabel={`${KIN_BRAND.sample}: ${name}`}
      >
        <View className="flex-row items-start gap-3">
          {props.logoUrl === null ? null : (
            <Image
              source={{ uri: props.logoUrl }}
              contentFit="contain"
              style={{ width: 40, height: 40 }}
              accessibilityIgnoresInvertColors
            />
          )}
          <View className="min-w-0 flex-1">
            <Text
              style={{ color: sample.primary, fontFamily: family, fontSize: 17, fontWeight: "600" }}
            >
              {name}
            </Text>
            <Text style={{ color: sample.secondary, fontFamily: family, fontSize: 13 }}>
              Tax invoice
            </Text>
          </View>
          <Text
            style={{
              color: sample.secondary,
              fontFamily: family,
              fontSize: 12,
              fontVariant: ["tabular-nums"],
            }}
          >
            INV/26-27/001
          </Text>
        </View>
        <View style={{ height: 2, borderRadius: 1, backgroundColor: sample.primary }} />
        {sample.footer === null ? null : (
          <Text style={{ color: sample.secondary, fontFamily: family, fontSize: 11 }}>
            {sample.footer}
          </Text>
        )}
      </View>
    </View>
  );
}

/** The brand as it is, with the logo, a way to send or remove it, and a way into the form. */
export function KinBrandRows(
  props: KinWorkTarget & {
    readonly profile: KinCompanyProfile;
    readonly onRefresh: () => void;
    readonly onEdit: (() => void) | null;
  },
) {
  const { environmentId, orgId, profile } = props;
  const set = useAtomCommand(kinClient.companyProfileSet, { reportFailure: false });
  const asker = useKinAskAgent(props);
  const logoUrl = useLogoUrl(environmentId, profile.logo);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const remove = async () => {
    setBusy(true);
    setProblem(null);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => set({ environmentId, input: kinLogoRemoveInput(orgId, profile) }),
    });
    setBusy(false);
    props.onRefresh();
    if (!outcome.ok) setProblem(outcome.changed ? KIN_COMPANY.changed : outcome.problem);
  };
  const { brand } = profile;
  const colour = (value: string | null) => value ?? KIN_BRAND.defaultFont;
  return (
    <>
      <ListSection title={KIN_BRAND.title} footer={KIN_BRAND.detail}>
        <View className="flex-row items-center gap-3 px-4 py-3">
          {profile.logo === null ? null : (
            <View className="size-14 items-center justify-center rounded-lg border border-border bg-white p-1">
              {logoUrl === null ? null : (
                <Image
                  source={{ uri: logoUrl }}
                  contentFit="contain"
                  style={{ width: "100%", height: "100%" }}
                  accessibilityLabel={`${KIN_BRAND.logo}: ${profile.logo.name}`}
                />
              )}
            </View>
          )}
          <View className="min-w-0 flex-1 gap-1">
            <Text textRole="body" className="text-foreground">
              {profile.logo === null ? KIN_BRAND.noLogo : profile.logo.name}
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              {profile.logo === null ? KIN_BRAND.addLogo : KIN_BRAND.changeLogo}
            </Text>
          </View>
        </View>
        {asker === null ? null : (
          <ListActionRow
            icon="bubble.left"
            label={KIN_BRAND.askLogo}
            onPress={() => asker.ask(KIN_BRAND.askLogoDraft)}
          />
        )}
        {profile.logo !== null && props.onEdit !== null ? (
          <ListActionRow
            icon="trash"
            tone="danger"
            label={KIN_BRAND.removeLogo}
            loading={busy}
            disabled={busy}
            onPress={() =>
              Dialog.confirm({
                title: KIN_BRAND.removeTitle,
                message: KIN_BRAND.removeDetail,
                confirmText: KIN_BRAND.removeLogo,
                destructive: true,
                onConfirm: () => void remove(),
              })
            }
          />
        ) : null}
      </ListSection>
      {problem === null ? null : <Notice message={problem} tone="danger" />}
      <ListSection>
        {(
          [
            [KIN_BRAND.primary, colour(brand.primaryColor), brand.primaryColor],
            [KIN_BRAND.secondary, colour(brand.secondaryColor), brand.secondaryColor],
            [KIN_BRAND.font, brand.font ?? KIN_BRAND.defaultFont, null],
            [KIN_BRAND.footer, brand.footer ?? "None", null],
          ] as const
        ).map(([label, value, swatch]) => (
          <View key={label} className="min-h-14 justify-center gap-1 px-4 py-3">
            <Text className="text-sm text-foreground-muted">{label}</Text>
            <View className="flex-row items-center gap-2">
              {swatch === null ? null : (
                <View
                  className="size-4 rounded border border-border"
                  style={{ backgroundColor: swatch }}
                />
              )}
              <Text textRole="body" selectable className="text-foreground">
                {value}
              </Text>
            </View>
          </View>
        ))}
        {props.onEdit === null ? null : (
          <ListActionRow icon="paintbrush" label={KIN_BRAND.edit} onPress={props.onEdit} />
        )}
      </ListSection>
      <SampleHeader profile={profile} draft={kinBrandDraftOf(brand)} logoUrl={logoUrl} />
    </>
  );
}

function ColourField(props: {
  readonly label: string;
  readonly value: string;
  readonly problem: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: string) => void;
}) {
  const hint = props.problem === undefined ? kinContrastHint(props.value) : null;
  return (
    <ListSection>
      <KinWorkTextField
        label={props.label}
        value={props.value}
        placeholder={KIN_BRAND.colorPlaceholder}
        keyboard="plain"
        maxLength={7}
        disabled={props.disabled}
        {...(props.problem !== undefined
          ? { hint: props.problem }
          : hint === null
            ? {}
            : { hint: hint.text })}
        onChangeText={props.onChange}
      />
      <View className="flex-row flex-wrap gap-2 px-4 pb-3">
        {KIN_BRAND_SWATCHES.map((swatch) => {
          const on = props.value.trim().toUpperCase() === swatch;
          return (
            <Pressable
              key={swatch}
              accessibilityRole="radio"
              accessibilityState={{ selected: on, disabled: props.disabled }}
              accessibilityLabel={`${props.label} ${swatch}`}
              disabled={props.disabled}
              hitSlop={4}
              onPress={() => props.onChange(swatch)}
              className={
                on
                  ? "size-8 rounded-full border-2 border-foreground"
                  : "size-8 rounded-full border border-border"
              }
              style={{ backgroundColor: swatch }}
            />
          );
        })}
      </View>
    </ListSection>
  );
}

/** Colours by tap or hex with a contrast hint, a font from the fixed list, the footer, and a sample. */
export function KinBrandForm(
  props: KinWorkTarget & {
    readonly profile: KinCompanyProfile;
    readonly onRefresh: () => void;
    readonly onDone: (saved: boolean) => void;
  },
) {
  const { environmentId, orgId, profile } = props;
  const set = useAtomCommand(kinClient.companyProfileSet, { reportFailure: false });
  const logoUrl = useLogoUrl(environmentId, profile.logo);
  const [draft, setDraft] = useState(() => kinBrandDraftOf(profile.brand));
  const [problems, setProblems] = useState<Partial<Record<KinBrandField, string>>>({});
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const checked = kinBrandInput(orgId, profile, draft);
    setProblem(null);
    if (!checked.ok) return setProblems(checked.problems);
    setProblems({});
    const { input } = checked;
    if (input === null) return props.onDone(false);
    setSaving(true);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => set({ environmentId, input }),
    });
    setSaving(false);
    props.onRefresh();
    if (!outcome.ok) return setProblem(outcome.changed ? KIN_COMPANY.changed : outcome.problem);
    props.onDone(true);
  };
  return (
    <KinWorkFrame
      title={KIN_BRAND.edit}
      form
      onClose={() => props.onDone(false)}
      confirm={{
        label: KIN_BRAND.save,
        onPress: () => void save(),
        loading: saving,
        disabled: saving,
      }}
    >
      {problem === null ? null : <Notice message={problem} tone="danger" />}
      <ColourField
        label={KIN_BRAND.primary}
        value={draft.primaryColor}
        problem={problems.primaryColor}
        disabled={saving}
        onChange={(primaryColor) => setDraft({ ...draft, primaryColor })}
      />
      <ColourField
        label={KIN_BRAND.secondary}
        value={draft.secondaryColor}
        problem={problems.secondaryColor}
        disabled={saving}
        onChange={(secondaryColor) => setDraft({ ...draft, secondaryColor })}
      />
      <ListSection>
        <Menu
          title={KIN_BRAND.font}
          accessibilityRole="button"
          accessibilityLabel={`${KIN_BRAND.font}: ${draft.font ?? KIN_BRAND.defaultFont}. Change`}
          actions={[
            {
              id: "",
              title: KIN_BRAND.defaultFont,
              state: draft.font === null ? ("on" as const) : ("off" as const),
            },
            ...KIN_BRAND_FONTS.map((font) => ({
              id: font,
              title: font,
              state: font === draft.font ? ("on" as const) : ("off" as const),
            })),
          ]}
          onPressAction={({ nativeEvent: { event } }) =>
            setDraft({ ...draft, font: KIN_BRAND_FONTS.find((font) => font === event) ?? null })
          }
        >
          <View pointerEvents="none">
            <ListRowLayout label={draft.font ?? KIN_BRAND.defaultFont} detail={KIN_BRAND.font} />
          </View>
        </Menu>
      </ListSection>
      <ListSection>
        <KinWorkTextField
          label={KIN_BRAND.footer}
          value={draft.footer}
          placeholder={KIN_BRAND.footerPlaceholder}
          multiline
          maxLength={300}
          disabled={saving}
          {...(problems.footer === undefined ? {} : { hint: problems.footer })}
          onChangeText={(footer) => setDraft({ ...draft, footer })}
        />
      </ListSection>
      <SampleHeader profile={profile} draft={draft} logoUrl={logoUrl} />
    </KinWorkFrame>
  );
}

/** The templates Kin makes documents from: who changed each last, a preview, and ways back. */
export function KinTemplateRows(props: KinWorkTarget) {
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
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ readonly ok: boolean; readonly text: string } | null>(null);
  const [shown, setShown] = useState<{
    readonly file: AttachmentPreviewFile;
    readonly name: string;
    readonly mimeType: string;
  } | null>(null);
  const [now] = useState(() => new Date());
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
    const written = await kinWritePreview(file);
    if (typeof written === "string") return setSaid({ ok: false, text: written });
    shown?.file.dispose();
    setShown({ file: written, name: file.name, mimeType: file.mimeType });
  };
  const run = async (kind: "undo" | "clear", template: KinTemplateView) => {
    setBusy(true);
    setSaid(null);
    const input = { orgId, recipe: template.name };
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () =>
        kind === "undo"
          ? undo({ environmentId, input })
          : clear({ environmentId, input: { ...input, commit: template.commit } }),
    });
    setBusy(false);
    recipes.refresh();
    if (!outcome.ok) return setSaid({ ok: false, text: outcome.problem });
    setSaid({
      ok: true,
      text:
        kind === "clear"
          ? KIN_TEMPLATES.cleared
          : "removed" in outcome.value && outcome.value.removed
            ? KIN_TEMPLATES.removed
            : KIN_TEMPLATES.undone,
    });
  };
  if (!allowed) return null;
  const { state } = recipes;
  return (
    <>
      <ListSection title={KIN_TEMPLATES.title} footer={KIN_TEMPLATES.detail}>
        {asker === null ? null : (
          <ListActionRow
            icon="bubble.left"
            label={KIN_TEMPLATES.askChange}
            onPress={() => asker.ask(KIN_TEMPLATES.askChangeDraft)}
          />
        )}
      </ListSection>
      {state._tag === "loading" ? (
        <KinWorkLoading label="Loading templates" />
      ) : state._tag !== "ready" ? (
        <View className="items-start gap-2 px-2">
          <Notice message="Couldn't load your templates. Check your connection." tone="danger" />
          <Button tone="secondary" label="Try again" onPress={recipes.refresh} />
        </View>
      ) : state.value.recipes.length === 0 ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {KIN_TEMPLATES.empty}
        </Text>
      ) : (
        kinTemplateGroups(state.value.recipes, names, now).map((group) => (
          <ListSection key={group.list ?? "other"} title={group.title}>
            {group.templates.map((template) => (
              <View key={template.name}>
                <View className="gap-1 px-4 py-3">
                  <View className="flex-row items-center gap-2">
                    <Text textRole="body" className="font-t3-medium text-foreground">
                      {template.title}
                    </Text>
                    {template.labelled ? (
                      <Text textRole="footnote" className="font-t3-medium text-warning">
                        {KIN_TEMPLATES.private}
                      </Text>
                    ) : null}
                  </View>
                  {template.description === null ? null : (
                    <Text textRole="footnote" className="text-foreground-muted">
                      {template.description}
                    </Text>
                  )}
                  <Text textRole="footnote" className="text-foreground-muted">
                    {template.changed}
                  </Text>
                  {template.labelled ? (
                    <Text textRole="footnote" className="text-foreground-muted">
                      {KIN_TEMPLATES.privateDetail}
                    </Text>
                  ) : null}
                </View>
                {canPreview ? (
                  <ListActionRow
                    icon="eye"
                    label={KIN_TEMPLATES.preview}
                    disabled={actions.busy || busy}
                    loading={actions.busy}
                    onPress={() => void preview(template, group.list)}
                  />
                ) : null}
                {canUndo && template.canUndo ? (
                  <ListActionRow
                    icon="arrow.uturn.backward"
                    label={KIN_TEMPLATES.undo}
                    disabled={busy}
                    onPress={() =>
                      Dialog.confirm({
                        title: KIN_TEMPLATES.undoTitle,
                        message: KIN_TEMPLATES.undoDetail,
                        confirmText: KIN_TEMPLATES.undo,
                        onConfirm: () => void run("undo", template),
                      })
                    }
                  />
                ) : null}
                {canClear && template.labelled ? (
                  <ListActionRow
                    icon="lock"
                    label={KIN_TEMPLATES.clearPrivate}
                    disabled={busy}
                    onPress={() =>
                      Dialog.confirm({
                        title: KIN_TEMPLATES.clearTitle,
                        message: KIN_TEMPLATES.clearDetail,
                        confirmText: KIN_TEMPLATES.clearPrivate,
                        onConfirm: () => void run("clear", template),
                      })
                    }
                  />
                ) : null}
              </View>
            ))}
          </ListSection>
        ))
      )}
      {actions.problem !== null || (said !== null && !said.ok) ? (
        <Notice message={actions.problem ?? said?.text ?? ""} tone="danger" />
      ) : said !== null ? (
        <Notice message={said.text} icon="checkmark.circle" />
      ) : null}
      <FilePreviewModal
        source={
          shown === null
            ? null
            : { kind: "pdf", uri: shown.file.uri, name: shown.name, mimeType: shown.mimeType }
        }
        onRequestClose={() => {
          shown?.file.dispose();
          setShown(null);
        }}
      />
    </>
  );
}
