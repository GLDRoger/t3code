import { kinNow } from "@t3tools/client-runtime/kin/kinNow";
import { useAtomValue } from "@effect/atom-react";
import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_TEMPLATES,
  KIN_TEMPLATES_SETTINGS,
  kinTemplateGroups,
  type KinTemplateView,
} from "@t3tools/client-runtime/kin/kinTemplates";
import { AsyncResult } from "effect/reactivity";
import { EyeIcon, MessageSquareIcon, RotateCcwIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Label } from "../components/ui/label";
import { Spinner } from "../components/ui/spinner";
import { Switch } from "../components/ui/switch";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinConfirm } from "./KinConfirm";
import { KinSettingsDialog } from "./settings/KinSettingsControls";
import { kinPreviewUrl } from "./KinInvoice";
import { kinClient } from "./kinClient";
import {
  KinSettingsEmpty,
  KinSettingsLoadFailed,
  KinSettingsLoading,
  KinSettingsRow,
  KinSettingsSection,
  KinSettingsStatus,
} from "./settings/KinSettingsLayout";
import { kinHostConnected } from "./useKinHost";
import {
  useKinAskAgent,
  useKinMoneyActions,
  useKinRecipes,
  type KinPreviewFile,
} from "./useKinMoney";
import { useKinWorkDirectory, type KinWorkTarget } from "./useKinWork";

type Ask = { readonly kind: "undo" | "clear" | "set"; readonly template: KinTemplateView };

/** The templates Kin makes documents from, one row each, opening what can be done with it. */
export function KinTemplatesSection(props: KinWorkTarget) {
  const { environmentId, orgId } = props;
  const allowed = useAtomValue(kinClient.companyRead.permissionAtom(environmentId));
  const canUndo = useAtomValue(kinClient.undoRecipe.permissionAtom(environmentId));
  const canLabel = useAtomValue(kinClient.labelRecipe.permissionAtom(environmentId));
  const canDefault = useAtomValue(kinClient.setDefaultRecipe.permissionAtom(environmentId));
  const canPreview = useAtomValue(kinClient.docRender.permissionAtom(environmentId));
  const recipes = useKinRecipes(props, allowed);
  const { names } = useKinWorkDirectory(props, allowed);
  const asker = useKinAskAgent(props);
  const actions = useKinMoneyActions(props);
  const undo = useAtomCommand(kinClient.undoRecipe, { reportFailure: false });
  const label = useAtomCommand(kinClient.labelRecipe, { reportFailure: false });
  const setDefault = useAtomCommand(kinClient.setDefaultRecipe, { reportFailure: false });
  const [opened, setOpened] = useState<string | null>(null);
  const [asking, setAsking] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<{
    readonly title: string;
    readonly url: string;
    readonly file: KinPreviewFile;
  } | null>(null);
  const [now] = useState(() => kinNow());
  const privateId = useId();
  const closePreview = () => {
    if (shown !== null) URL.revokeObjectURL(shown.url);
    setShown(null);
  };
  const preview = async (template: KinTemplateView, list: string | null) => {
    setProblem(null);
    let entry;
    if (list !== null) {
      const latest = await kinClient.workList.run(appAtomRegistry, {
        environmentId,
        input: { orgId, list, limit: 1 },
      });
      entry = AsyncResult.isSuccess(latest) ? latest.value.records[0]?.key : undefined;
      if (entry === undefined) return setProblem(KIN_TEMPLATES.noPreviewEntry);
    }
    const files = await actions.preview(template.name, entry);
    const file = files?.[0];
    if (file === undefined) {
      if (files !== null) setProblem(KIN_TEMPLATES.previewFailed);
      return;
    }
    setShown({ title: template.title, url: kinPreviewUrl(file), file });
  };
  const confirm = async (ask: Ask) => {
    setBusy(true);
    setProblem(null);
    const input = { orgId, recipe: ask.template.name };
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () =>
        ask.kind === "undo"
          ? undo({ environmentId, input })
          : label({
              environmentId,
              input: { ...input, commit: ask.template.commit, sensitive: ask.kind === "set" },
            }),
    });
    setBusy(false);
    recipes.refresh();
    if (!outcome.ok) setProblem(outcome.problem);
  };
  const makeDefault = async (template: KinTemplateView) => {
    setBusy(true);
    setProblem(null);
    const outcome = await kinListSend({
      online: () => kinHostConnected(environmentId),
      send: () => setDefault({ environmentId, input: { orgId, recipe: template.name } }),
    });
    setBusy(false);
    recipes.refresh();
    if (!outcome.ok) setProblem(outcome.problem);
  };
  if (!allowed) return null;
  const { state } = recipes;
  const groups = state._tag === "ready" ? kinTemplateGroups(state.value.recipes, names, now) : [];
  const open = groups
    .flatMap((group) => group.templates.map((template) => ({ group, template })))
    .find(({ template }) => template.name === opened);
  const failed = actions.problem ?? problem;
  return (
    <KinSettingsSection
      title={KIN_TEMPLATES.title}
      description={KIN_TEMPLATES_SETTINGS.detail}
      problem={open === undefined ? failed : null}
      action={
        asker === null ? undefined : (
          <Button
            size="xs"
            variant="outline"
            onClick={() => asker.ask(KIN_TEMPLATES.askChangeDraft)}
          >
            <MessageSquareIcon />
            {KIN_TEMPLATES.askChange}
          </Button>
        )
      }
    >
      {state._tag === "loading" ? (
        <KinSettingsLoading rows={2} />
      ) : state._tag !== "ready" ? (
        <KinSettingsLoadFailed onRetry={recipes.refresh}>
          {KIN_TEMPLATES.loadFailed}
        </KinSettingsLoadFailed>
      ) : groups.length === 0 ? (
        <KinSettingsEmpty>{KIN_TEMPLATES.empty}</KinSettingsEmpty>
      ) : (
        groups.flatMap((group) =>
          group.templates.map((template) => (
            <KinSettingsRow
              key={template.name}
              title={template.title}
              // Kin's own starter needs no "changed by" on every row; a real change does.
              detail={[
                template.isDefault && group.list !== null
                  ? KIN_TEMPLATES_SETTINGS.usedFor(group.title)
                  : group.title,
                template.canUndo ? template.changed : null,
              ]
                .filter((part) => part !== null)
                .join(" · ")}
              status={
                template.labelled || template.alwaysPrivate ? (
                  <KinSettingsStatus tone="quiet">{KIN_TEMPLATES.private}</KinSettingsStatus>
                ) : null
              }
              openLabel={KIN_TEMPLATES_SETTINGS.open(template.title)}
              onOpen={() => {
                setProblem(null);
                setOpened(template.name);
              }}
            />
          )),
        )
      )}
      {open === undefined ? null : (
        <KinSettingsDialog
          title={open.template.title}
          description={open.template.description ?? open.template.changed}
          busy={busy}
          problem={failed}
          start={
            canUndo && open.template.canUndo ? (
              <Button
                variant="ghost"
                disabled={busy}
                onClick={() => setAsking({ kind: "undo", template: open.template })}
              >
                <RotateCcwIcon />
                {KIN_TEMPLATES.undo}
              </Button>
            ) : undefined
          }
          secondary={
            canPreview ? (
              <Button
                variant="outline"
                disabled={actions.busy || busy}
                aria-busy={actions.busy}
                onClick={() => void preview(open.template, open.group.list)}
              >
                {actions.busy ? <Spinner /> : <EyeIcon />}
                {actions.busy ? KIN_TEMPLATES.previewing : KIN_TEMPLATES.preview}
              </Button>
            ) : undefined
          }
          onClose={() => setOpened(null)}
        >
          {open.template.description === null ? null : (
            <p className="text-xs text-muted-foreground">{open.template.changed}</p>
          )}
          {open.group.list === null ? null : (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-foreground">
                {open.template.isDefault
                  ? KIN_TEMPLATES_SETTINGS.usedFor(open.group.title)
                  : open.group.title}
              </p>
              {canDefault && !open.template.isDefault ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void makeDefault(open.template)}
                >
                  {KIN_TEMPLATES.pickFor(open.group.title)}
                </Button>
              ) : null}
            </div>
          )}
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-0.5">
              <Label htmlFor={privateId}>{KIN_TEMPLATES_SETTINGS.privateLabel}</Label>
              <p className="text-xs text-muted-foreground">
                {open.template.alwaysPrivate
                  ? KIN_TEMPLATES.alwaysPrivateDetail
                  : open.template.labelled
                    ? KIN_TEMPLATES.privateDetail
                    : KIN_TEMPLATES.setDetail}
              </p>
            </div>
            <Switch
              id={privateId}
              checked={open.template.alwaysPrivate || open.template.labelled}
              disabled={busy || !canLabel || open.template.alwaysPrivate}
              onCheckedChange={() =>
                setAsking({
                  kind: open.template.labelled ? "clear" : "set",
                  template: open.template,
                })
              }
            />
          </div>
        </KinSettingsDialog>
      )}
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
              : asking.kind === "set"
                ? {
                    title: KIN_TEMPLATES.setTitle,
                    detail: KIN_TEMPLATES.setDetail,
                    action: KIN_TEMPLATES.setPrivate,
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
        onOpenChange={(next) => {
          if (!next) closePreview();
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
            <Button onClick={closePreview}>{KIN_TEMPLATES_SETTINGS.done}</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </KinSettingsSection>
  );
}
