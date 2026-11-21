import { useKinOwnerLevel } from "./useKinOwnerLevel";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  KIN_RETRY,
  KIN_CHECK_CONNECTION,
  kinFailureText,
} from "@t3tools/client-runtime/kin/kinAnswers";
import { FileDiff } from "@pierre/diffs/react";
import { useAtomValue } from "@effect/atom-react";
import {
  KIN_DOCS,
  KIN_DOC_HOMES,
  KIN_DOC_KIND_LABELS,
  kinDocKindOf,
  kinDocUnfiled,
  kinDocCopyText,
  kinDocDiffSummary,
  kinDocPdfInput,
  kinDocRestoreOutcome,
  kinDocVersionView,
} from "@t3tools/client-runtime/kin/kinDocs";
import type { KinNotificationDestination } from "@t3tools/client-runtime/kin/kinNotificationDestination";
import { KIN_TASK_RECORD } from "@t3tools/client-runtime/kin/kinTaskRecord";
import { KIN_DOC_CHANGES } from "@t3tools/client-runtime/kin/kinDocChanges";
import { KIN_DOC_COMPANY, KIN_DOC_SHARE } from "@t3tools/client-runtime/kin/kinWork";
import { kinWorkReadState } from "@t3tools/client-runtime/kin/kinWorkForms";
import type { KinDocDetail, KinRecordKey } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { ArrowLeftIcon, FolderInputIcon, XIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { DiffWorkerPoolProvider } from "../components/DiffWorkerPoolProvider";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { DIFF_VIEW_UNSAFE_CSS } from "../components/diffs/StyledDiffCodeView";
import { Alert, AlertAction, AlertDescription } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { Skeleton } from "../components/ui/skeleton";
import { toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import { useRenderedAppearance } from "../hooks/useTheme";
import {
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { randomUUID } from "../lib/utils";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useAtomCommand } from "../state/use-atom-command";
import { KinDocChangesView } from "./KinDocChangesView";
import { KinDocFileDialog } from "./KinDocFileDialog";
import { KinDocReader } from "./KinDocReader";
import { openDestination } from "./KinNotifications";
import { KinLinkedGroups } from "./KinWorkItemSheet";
import { KinWorkShareRow } from "./KinWorkShareRow";
import { KinWorkNotice, KinLoadFailed } from "./KinWorkParts";
import { kinClient } from "./kinClient";
import { useNowMinuteMs } from "./useKinClock";
import { useKinDoc, useKinDocAsk, useKinDocHistory } from "./useKinDocs";
import { kinHostConnected } from "./useKinHost";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

/** Which doc is open and how: read, or compared with another version, with its history beside. */
export interface KinDocWhere {
  readonly doc: KinRecordKey;
  readonly version?: number;
  readonly section?: string;
  /** The two versions compared; `from` is the one before `to` when absent. */
  readonly changes?: { readonly to: number; readonly from?: number };
  readonly history?: boolean;
}

type Restoring = { readonly version: number; readonly latest: number } | null;

export function KinDocPage(
  props: KinWorkTarget & {
    readonly where: KinDocWhere;
    readonly directory: KinWorkDirectory;
    readonly onGo: (where: KinDocWhere | null) => void;
    /** The address of this doc, or one section of it, for Copy link. */
    readonly linkTo: (section: string | null) => string;
    /** The place the doc was opened from, which Back returns to. */
    readonly placeTitle: string;
    /** Beside its place's list, under that place's header, rather than the whole page. */
    readonly inPane: boolean;
    /** A task or money entry linked to the doc, on its panel over the place. */
    readonly onOpenKey: (key: KinRecordKey) => void;
    readonly onOpenClient: (key: KinRecordKey) => void;
    readonly onOpenProject: (key: KinRecordKey) => void;
  },
) {
  const { placeTitle, inPane } = props;
  const { where, onGo } = props;
  const { environmentId, orgId } = props;
  const { names } = props.directory;
  const key = where.doc;
  const comparing = where.changes;
  // Compared versions are read at `to`, so the page names the doc as it was then.
  const { state, refresh } = useKinDoc(props, key, comparing?.to ?? where.version ?? null);
  const doc = state._tag === "ready" ? state.value : null;
  const canRestore = useAtomValue(kinClient.docRestore.permissionAtom(environmentId));
  const canRender = useAtomValue(kinClient.docRender.permissionAtom(environmentId));
  const render = useAtomCommand(kinClient.docRender, { reportFailure: false });
  const canPdf = doc !== null && canRender && kinDocPdfInput(orgId, doc, "pdf") !== null;
  const exportPdf = async () => {
    const pdfInput = doc === null ? null : kinDocPdfInput(orgId, doc, randomUUID());
    if (pdfInput === null) return;
    const toast = toastManager.add({ type: "loading", title: KIN_DOCS.exportingPdf });
    const result = await render({ environmentId, input: pdfInput });
    toastManager.close(toast);
    const made = AsyncResult.isSuccess(result) ? result.value.documents[0] : undefined;
    if (made === undefined)
      return setProblem(
        kinFailureText(
          AsyncResult.isFailure(result) ? squashAtomCommandFailure(result) : null,
          KIN_DOCS.exportPdfFailed,
        ),
      );
    onGo({ doc: made.key });
  };
  const restore = useAtomCommand(kinClient.docRestore, { reportFailure: false });
  const ownerLevel = useKinOwnerLevel(environmentId);
  const navigate = useNavigate();
  const ask = useKinDocAsk(props, doc, names.me, ownerLevel);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const [restoring, setRestoring] = useState<Restoring>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** The version that was latest before a restore, which restoring again undoes. */
  const [undo, setUndo] = useState<number | null>(null);
  const [filing, setFiling] = useState(false);
  const canFile = useAtomValue(kinClient.docFile.permissionAtom(environmentId));

  const run = async (target: NonNullable<Restoring>, undoing: boolean) => {
    if (!kinHostConnected(environmentId)) {
      setProblem(KIN_DOCS.restoreOffline);
      setRestoring(null);
      return;
    }
    setBusy(true);
    setProblem(null);
    const outcome = kinDocRestoreOutcome(
      await restore({ environmentId, input: { orgId, key, ...target } }),
    );
    setBusy(false);
    setRestoring(null);
    if (outcome._tag === "refused") {
      setProblem(outcome.text);
      if (outcome.moved) refresh();
      return;
    }
    setUndo(undoing ? null : target.latest);
    refresh();
    onGo({ doc: key });
  };

  const openLinked = (to: KinNotificationDestination) => {
    if (to._tag !== "record") return void openDestination(navigate, props, to);
    if (to.kind === "doc") return onGo({ doc: to.key });
    if (to.kind === "client") return props.onOpenClient(to.key);
    if (to.kind === "project") return props.onOpenProject(to.key);
    props.onOpenKey(to.key);
  };

  const copyLink = (section: string | null) => {
    void navigator.clipboard.writeText(props.linkTo(section)).then(
      () => toastManager.add({ type: "success", title: KIN_DOCS.copied }),
      () => setProblem("Couldn't copy the link."),
    );
  };
  const copyText = (markdown: string) => {
    void navigator.clipboard.writeText(kinDocCopyText(markdown)).then(
      () => toastManager.add({ type: "success", title: KIN_DOCS.textCopied }),
      () => setProblem("Couldn't copy the text."),
    );
  };

  return (
    <>
      <WorkspacePageHeader electron={isElectron && !inPane} titlebarInset={!inPane}>
        {inPane && comparing === undefined ? null : (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={comparing === undefined ? `Back to ${placeTitle}` : "Back to the doc"}
            className={inPane ? undefined : "md:hidden"}
            onClick={() => onGo(comparing === undefined ? null : { doc: key })}
          >
            <ArrowLeftIcon />
          </Button>
        )}
        <WorkspaceBreadcrumb ariaLabel={KIN_DOCS.title}>
          {inPane ? null : (
            <>
              <WorkspaceBreadcrumbItem className="max-md:hidden">
                <Button size="xs" variant="ghost" onClick={() => onGo(null)}>
                  {placeTitle}
                </Button>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator className="max-md:hidden" />
            </>
          )}
          {comparing === undefined ? (
            <WorkspaceBreadcrumbItem current>
              <span className="truncate">{doc?.title ?? key}</span>
            </WorkspaceBreadcrumbItem>
          ) : (
            <>
              <WorkspaceBreadcrumbItem className="max-md:hidden">
                <Button size="xs" variant="ghost" onClick={() => onGo({ doc: key })}>
                  <span className="max-w-48 truncate">{doc?.title ?? key}</span>
                </Button>
              </WorkspaceBreadcrumbItem>
              <WorkspaceBreadcrumbSeparator className="max-md:hidden" />
              <WorkspaceBreadcrumbItem current>
                <span className="truncate">Changes</span>
              </WorkspaceBreadcrumbItem>
            </>
          )}
        </WorkspaceBreadcrumb>
        <div ref={setActions} className="ms-auto flex items-center gap-1" />
        {inPane ? (
          <Button size="icon-sm" variant="ghost" aria-label="Close doc" onClick={() => onGo(null)}>
            <XIcon />
          </Button>
        ) : null}
      </WorkspacePageHeader>
      {problem === null && undo === null ? null : (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 pt-3">
          {problem === null ? null : (
            <Alert variant="error">
              <AlertDescription>{problem}</AlertDescription>
              <AlertAction>
                <Button size="xs" variant="outline" onClick={() => setProblem(null)}>
                  Dismiss
                </Button>
              </AlertAction>
            </Alert>
          )}
          {undo === null || doc === null ? null : (
            <Alert variant="success">
              <AlertDescription>{KIN_DOCS.restored(doc.latest.version)}</AlertDescription>
              <AlertAction>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run({ version: undo, latest: doc.latest.version }, true)}
                >
                  Undo
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setUndo(null)}>
                  Dismiss
                </Button>
              </AlertAction>
            </Alert>
          )}
        </div>
      )}
      {doc === null || comparing !== undefined ? null : (
        <KinDocFiling doc={doc} canFile={canFile} onFile={() => setFiling(true)} />
      )}
      {doc === null ||
      comparing !== undefined ||
      doc.archived ||
      doc.sensitive ||
      doc.sensitiveInherited === true ? null : (
        <div className="mx-auto w-full max-w-3xl px-6 pt-3">
          {doc.company === true ? (
            <div className="flex flex-col gap-0.5">
              <p className="text-sm font-medium text-foreground">{KIN_DOC_COMPANY.label}</p>
              <p className="text-xs text-muted-foreground">{KIN_DOC_COMPANY.note}</p>
            </div>
          ) : (
            <KinWorkShareRow
              environmentId={environmentId}
              orgId={orgId}
              itemKey={doc.key}
              shared={doc.shared === true}
              disabled={busy}
              copy={KIN_DOC_SHARE}
              onSettled={refresh}
            />
          )}
        </div>
      )}
      {filing && doc !== null ? (
        <KinDocFileDialog {...props} doc={doc} onClose={() => setFiling(false)} />
      ) : null}
      {state._tag === "refused" ? (
        <KinWorkNotice {...KIN_DOCS.unavailable} />
      ) : state._tag === "gone" ? (
        <KinWorkNotice
          {...KIN_DOCS.gone}
          action={
            <Button size="sm" variant="outline" onClick={() => onGo(null)}>
              Back to {placeTitle}
            </Button>
          }
        />
      ) : state._tag === "failed" ? (
        <KinWorkNotice
          {...KIN_DOCS.failed}
          action={
            <Button size="sm" variant="outline" onClick={refresh}>
              Retry
            </Button>
          }
        />
      ) : doc === null ? (
        <div
          className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 pt-8"
          role="status"
          aria-label="Loading doc"
        >
          <Skeleton className="h-7 w-2/5" />
          <Skeleton className="h-3.5 w-3/5" />
          <Skeleton className="mt-4 h-3.5 w-full" />
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-4/5" />
        </div>
      ) : comparing !== undefined ? (
        <KinDocChanges
          {...props}
          doc={doc}
          comparing={comparing}
          onRestore={
            canRestore ? (version) => setRestoring({ version, latest: doc.latest.version }) : null
          }
        />
      ) : (
        <KinDocReader
          {...props}
          // A fresh reader per version, so one version's headings never serve another's.
          key={doc.version.version}
          doc={doc}
          section={where.section ?? null}
          actions={actions}
          onPoint={ask}
          suggests={!ownerLevel}
          onCopyLink={copyLink}
          onCopyText={copyText}
          onSeeChanges={(to) => onGo({ doc: key, changes: { to } })}
          onOpenLatest={() => onGo({ doc: key })}
          onHistory={() => onGo({ ...where, history: true })}
          onExportPdf={canPdf ? () => void exportPdf() : null}
          onRestore={
            canRestore ? (version) => setRestoring({ version, latest: doc.latest.version }) : null
          }
          linked={
            <KinLinkedGroups
              item={doc}
              title={KIN_TASK_RECORD.linked}
              // The filing row above the doc names its client and project already.
              parentsShown
              onOpen={openLinked}
            />
          }
        />
      )}
      {where.history === true && doc !== null ? (
        <KinDocHistory
          {...props}
          doc={doc}
          onClose={() => onGo({ ...where, history: false })}
          onOpen={(version) =>
            onGo(version === doc.latest.version ? { doc: key } : { doc: key, version })
          }
          onCompare={(changes) => onGo({ doc: key, changes })}
          onRestore={
            canRestore ? (version) => setRestoring({ version, latest: doc.latest.version }) : null
          }
        />
      ) : null}
      <AlertDialog
        open={restoring !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setRestoring(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore version {restoring?.version}?</AlertDialogTitle>
            <AlertDialogDescription>
              {KIN_DOCS.restoreDetail(restoring?.version)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              disabled={busy}
              aria-busy={busy}
              onClick={() => {
                if (restoring !== null) void run(restoring, false);
              }}
            >
              {busy ? KIN_DOCS.restoring : "Restore"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

/** What differs between two versions, in the app's own diff view, and the way back. */
/** What kind of doc this is and where it is filed, with the way to change either. */
function KinDocFiling(props: {
  readonly doc: KinDocDetail;
  readonly canFile: boolean;
  readonly onFile: () => void;
}) {
  const { doc } = props;
  const kind = kinDocKindOf(doc);
  const unfiled = kinDocUnfiled(doc);
  const home =
    doc.company === true
      ? KIN_DOC_HOMES.company
      : [doc.party?.title, doc.project?.title].filter(Boolean).join(" · ");
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-1.5 px-6 pt-3">
      <Badge size="sm" variant="outline">
        {KIN_DOC_KIND_LABELS[kind].one}
      </Badge>
      {unfiled ? (
        <Badge size="sm" variant="warning">
          {KIN_DOC_HOMES.unfiled}
        </Badge>
      ) : (
        <span className="truncate text-xs text-muted-foreground">{home}</span>
      )}
      {props.canFile ? (
        <Button size="xs" variant="ghost" onClick={props.onFile}>
          <FolderInputIcon />
          {unfiled ? KIN_DOC_HOMES.file : "Change"}
        </Button>
      ) : null}
    </div>
  );
}

function KinDocChanges(
  props: KinWorkTarget & {
    readonly doc: KinDocDetail;
    readonly comparing: NonNullable<KinDocWhere["changes"]>;
    readonly directory: KinWorkDirectory;
    readonly onRestore: ((version: number) => void) | null;
  },
) {
  const { doc, comparing } = props;
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const theme = useRenderedAppearance();
  const atom = kinClient.docDiff({
    environmentId: props.environmentId,
    input: {
      orgId: props.orgId,
      key: doc.key,
      to: comparing.to,
      ...(comparing.from === undefined ? {} : { from: comparing.from }),
    },
  });
  const state = kinWorkReadState(useAtomValue(atom));
  const [source, setSource] = useState(false);
  if (comparing.to === 1 && comparing.from === undefined)
    return <KinWorkNotice {...KIN_DOCS.firstVersion} />;
  if (state._tag === "loading")
    return (
      <div
        className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 pt-8"
        role="status"
        aria-label="Loading changes"
      >
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  if (state._tag !== "ready")
    return (
      <KinWorkNotice
        title={KIN_DOCS.changesFailed}
        detail={KIN_CHECK_CONNECTION}
        action={
          <Button size="sm" variant="outline" onClick={() => appAtomRegistry.refresh(atom)}>
            Retry
          </Button>
        }
      />
    );
  const diff = state.value;
  const to = kinDocVersionView(diff.to, doc.latest.version, names, now);
  const patch = getRenderablePatch(diff.patch, `kin-doc:${doc.key}:${theme}`);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-both">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 pt-6 pb-24">
        <header className="flex flex-col gap-1">
          <div className="flex items-start gap-3">
            <h1 className="min-w-0 flex-1 text-lg font-semibold text-foreground">
              Version {diff.from.version} to {diff.to.version}
            </h1>
            {patch === null ? null : (
              <Button size="xs" variant="outline" onClick={() => setSource(!source)}>
                {source ? KIN_DOC_CHANGES.showDocument : KIN_DOC_CHANGES.showSource}
              </Button>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {to.line.lead}
            {to.asked === null ? null : ` · ${to.asked}`}
          </p>
          {to.line.summary === null ? null : (
            <p className="text-sm text-foreground">“{to.line.summary}”</p>
          )}
        </header>
        {patch === null ? (
          <KinWorkNotice {...KIN_DOCS.noChanges} />
        ) : !source ? (
          <KinDocChangesView
            environmentId={props.environmentId}
            orgId={props.orgId}
            docKey={doc.key}
            from={diff.from.version}
            to={diff.to.version}
          />
        ) : patch.kind === "raw" ? (
          <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 text-xs">{patch.text}</pre>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <DiffWorkerPoolProvider>
              {patch.files.map((file) => (
                <FileDiff
                  key={resolveFileDiffPath(file)}
                  fileDiff={file}
                  options={{
                    collapsed: false,
                    diffStyle: "unified",
                    overflow: "wrap",
                    disableFileHeader: true,
                    theme: resolveDiffThemeName(theme),
                    themeType: theme,
                    preferredHighlighter: PREFERRED_HIGHLIGHTER,
                    unsafeCSS: DIFF_VIEW_UNSAFE_CSS,
                  }}
                />
              ))}
            </DiffWorkerPoolProvider>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          {kinDocDiffSummary(diff, doc.outline.length)}
        </p>
        {props.onRestore === null || diff.from.version === doc.latest.version ? null : (
          <div>
            <Button variant="outline" onClick={() => props.onRestore?.(diff.from.version)}>
              Restore version {diff.from.version}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Every version, newest first: who made it, when and why, and the way to open, compare or restore it. */
function KinDocHistory(
  props: KinWorkTarget & {
    readonly doc: KinDocDetail;
    readonly directory: KinWorkDirectory;
    readonly onClose: () => void;
    readonly onOpen: (version: number) => void;
    readonly onCompare: (changes: NonNullable<KinDocWhere["changes"]>) => void;
    readonly onRestore: ((version: number) => void) | null;
  },
) {
  const { doc } = props;
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const latest = doc.latest.version;
  const { state, list } = useKinDocHistory(props, doc.key, doc.seq);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <SheetPopup side="right">
        <SheetHeader>
          <SheetTitle>{KIN_DOCS.history}</SheetTitle>
          <SheetDescription>{doc.title}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto px-6 pb-6">
          {state.loading ? (
            <div className="flex flex-col gap-2" role="status" aria-label="Loading history">
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-3.5 w-3/5" />
              <Skeleton className="h-3.5 w-2/5" />
            </div>
          ) : state.failed !== null ? (
            <KinLoadFailed
              what={KIN_DOCS.historyFailed}
              cause={state.failed}
              onRetry={list.refresh}
            />
          ) : (
            <ol className="flex flex-col">
              {state.records.map((held) => {
                const view = kinDocVersionView(held, latest, names, now);
                return (
                  <li
                    key={view.version}
                    aria-label={view.accessibilityLabel}
                    className="flex flex-col gap-1.5 border-b border-border/60 py-3"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{view.label}</span>
                      {view.current ? (
                        <Badge size="sm" variant="outline">
                          Current
                        </Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {view.line.lead}
                      {view.asked === null ? null : ` · ${view.asked}`}
                    </p>
                    {view.line.summary === null ? null : (
                      <p className="text-sm text-foreground">{view.line.summary}</p>
                    )}
                    <div className="flex flex-wrap gap-1.5 pt-0.5">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => props.onOpen(view.version)}
                      >
                        Open
                      </Button>
                      {view.previous === null ? null : (
                        <Button
                          size="xs"
                          variant="outline"
                          onClick={() => props.onCompare({ to: view.version })}
                        >
                          {KIN_DOCS.changes}
                        </Button>
                      )}
                      {view.current ? null : (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => props.onCompare({ from: view.version, to: latest })}
                        >
                          {KIN_DOCS.compare}
                        </Button>
                      )}
                      {view.current || props.onRestore === null ? null : (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => props.onRestore?.(view.version)}
                        >
                          Restore
                        </Button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
          {!state.more ? null : (
            <div className="flex items-center gap-3 pt-3">
              <Button
                size="xs"
                variant="outline"
                disabled={state.loadingMore}
                aria-busy={state.loadingMore}
                onClick={() => void list.loadMore()}
              >
                {state.moreFailed ? KIN_RETRY : KIN_DOCS.earlierVersions}
              </Button>
            </div>
          )}
        </div>
      </SheetPopup>
    </Sheet>
  );
}
