import { useAtomValue } from "@effect/atom-react";

import { kinListSend } from "@t3tools/client-runtime/kin/kinLists";
import {
  KIN_TEMPLATES,
  kinTemplateGroups,
  type KinTemplateView,
} from "@t3tools/client-runtime/kin/kinTemplates";

import { AsyncResult } from "effect/reactivity";
import { EyeIcon, LockOpenIcon, MessageSquareIcon, RotateCcwIcon } from "lucide-react";
import { useState } from "react";

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

import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinSettingsHeading } from "./KinBrand";
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
        <KinSettingsHeading title={KIN_TEMPLATES.title} detail={KIN_TEMPLATES.detail} />
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
