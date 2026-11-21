import {
  KIN_DOCS,
  kinDocChangeLine,
  kinDocExport,
  kinDocHasContents,
  kinDocOutline,
  kinDocPieceKey,
  kinDocPieces,
  kinDocPrevious,
  kinDocPrivacy,
  kinDocRef,
  kinDocSections,
  type KinDocAsk,
} from "@t3tools/client-runtime/kin/kinDocs";
import type { KinDocDetail, KinDocSection, KinMessageRef } from "@t3tools/contracts";
import {
  CopyIcon,
  EllipsisIcon,
  FileDownIcon,
  HistoryIcon,
  LinkIcon,
  ListIcon,
  LockIcon,
  LockOpenIcon,
  MessageCircleQuestionIcon,
  PencilLineIcon,
  ShareIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";

import { kinDocFileId, kinDocMarkdown } from "@t3tools/client-runtime/kin/kinChatFeed";
import ChatMarkdown from "../components/ChatMarkdown";
import { Alert, AlertAction, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../components/ui/menu";
import {
  isSelectionRectVisible,
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "../lib/selectionActions";
import { downloadPlanAsTextFile } from "../proposedPlan";
import { KinEmbedView } from "./KinEmbedView";
import { useKinDocLabel } from "./KinConfirm";
import { KinDocFileCard } from "./KinInvoice";
import { useNowMinuteMs } from "./useKinClock";
import type { KinWorkDirectory, KinWorkTarget } from "./useKinWork";

const HEADINGS = "h1,h2,h3,h4,h5,h6";
const plain = (text: string) =>
  text
    .replace(/[`*_~[\]()<>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The heading element of each section the host names, in order. A heading the host doesn't count
 * (inside a quote, or underlined instead of hashed) is passed over, so a section is never
 * hung on the wrong one.
 */
function findHeadings(
  root: HTMLElement,
  outline: ReadonlyArray<KinDocSection>,
): ReadonlyMap<string, HTMLElement> {
  const found = new Map<string, HTMLElement>();
  const drawn = Array.from(root.querySelectorAll<HTMLElement>(HEADINGS)).filter(
    (heading) => heading.closest("blockquote,li,table,[data-kin-doc-embed]") === null,
  );
  let at = 0;
  for (const section of outline) {
    if (section.id === "top") continue;
    const wanted = plain(section.title);
    const index = drawn.findIndex(
      (heading, i) =>
        i >= at &&
        Number(heading.tagName.slice(1)) === section.level &&
        plain(heading.dataset.kinDocTitle ?? heading.textContent ?? "") === wanted,
    );
    if (index === -1) continue;
    const heading = drawn[index]!;
    // Kept apart from the menu's own words, which later land inside the heading.
    heading.dataset.kinDocTitle ??= heading.textContent ?? "";
    found.set(section.id, heading);
    at = index + 1;
  }
  return found;
}

/**
 * Where a heading's menu is drawn: a node of our own inside it. The renderer owns the heading's
 * text, so React refuses the heading itself as a portal's container.
 */
const menuSlot = (heading: HTMLElement) =>
  heading.querySelector<HTMLElement>(":scope > [data-kin-doc-section-menu]");

/** The section a node sits in: the one whose heading is the last at or before it. */
function sectionAt(
  root: HTMLElement,
  headings: ReadonlyMap<string, HTMLElement>,
  node: Node,
  hasTop: boolean,
): string | null {
  let held: string | null = hasTop ? "top" : null;
  for (const [id, heading] of headings) {
    if (!root.contains(heading)) continue;
    const order = heading.compareDocumentPosition(node);
    if (
      heading === node ||
      order & Node.DOCUMENT_POSITION_FOLLOWING ||
      order & Node.DOCUMENT_POSITION_CONTAINED_BY
    )
      held = id;
    else break;
  }
  return held;
}

export type KinDocPoint = (ref: KinMessageRef, intent: KinDocAsk) => void;

const FILE_IMAGE = "#kin-file:";
// The sanitizer drops a source with a scheme it doesn't know; a fragment reaches the renderer,
// which loads nothing else from one.
const fileImageSource = (id: string) => `${FILE_IMAGE}${id}`;
const fileImageAttachment = (src: string) =>
  src.startsWith(FILE_IMAGE) ? kinDocFileId(src.slice(1)) : null;

/**
 * Change is by hand where the host lets this reader (`onEdit`); else Ask and Change show only
 * where there is an agent to ask, and a teammate suggests a change.
 */
function AskItems(props: {
  readonly onAsk: ((intent: KinDocAsk) => void) | null;
  readonly onEdit: (() => void) | null;
  readonly suggests: boolean;
  readonly onCopyLink: () => void;
  /** Null where the section's text can't be told apart from the rest. */
  readonly onCopyText: (() => void) | null;
}) {
  const { onAsk } = props;
  return (
    <>
      {onAsk === null ? null : (
        <>
          <MenuItem onClick={() => onAsk("ask")}>
            <MessageCircleQuestionIcon />
            {KIN_DOCS.ask}
          </MenuItem>
          {props.onEdit === null ? (
            <MenuItem onClick={() => onAsk("change")}>
              <PencilLineIcon />
              {props.suggests ? KIN_DOCS.suggest : KIN_DOCS.change}
            </MenuItem>
          ) : null}
        </>
      )}
      {props.onEdit === null ? null : (
        <MenuItem onClick={props.onEdit}>
          <PencilLineIcon />
          {KIN_DOCS.change}
        </MenuItem>
      )}
      <MenuItem onClick={props.onCopyLink}>
        <LinkIcon />
        {KIN_DOCS.copyLink}
      </MenuItem>
      {props.onCopyText === null ? null : (
        <MenuItem onClick={props.onCopyText}>
          <CopyIcon />
          {KIN_DOCS.copyText}
        </MenuItem>
      )}
    </>
  );
}

/** A doc as a document: its title, who last changed it and how, then everything the agent wrote. */
export function KinDocReader(
  props: KinWorkTarget & {
    readonly doc: KinDocDetail;
    readonly directory: KinWorkDirectory;
    /** The section to arrive at. */
    readonly section: string | null;
    /** Null where no agent keeps the doc, so there is nobody to ask. */
    readonly onPoint: KinDocPoint | null;
    /** A teammate's Change this is a suggestion the owner decides on. */
    readonly suggests?: boolean;
    readonly onCopyLink: (section: string | null) => void;
    /** Copies this markdown as clean text (`kinDocCopyText`). */
    readonly onCopyText: (markdown: string) => void;
    /** Opens a section to change by hand; null where this reader may not. */
    readonly onEdit:
      | ((section: { readonly id: string; readonly title: string; readonly text: string }) => void)
      | null;
    readonly onSeeChanges: (to: number) => void;
    readonly onOpenLatest: () => void;
    readonly onHistory: () => void;
    /** Null where the doc is a file already, or this browser may not make one. */
    readonly onExportPdf: (() => void) | null;
    /** Null where this browser may not restore. */
    readonly onRestore: ((version: number) => void) | null;
    /** Where the page header's own buttons go. */
    readonly actions: HTMLElement | null;
    /** What links to the doc and what it links to, after the body. */
    readonly linked: React.ReactNode;
  },
) {
  const { doc, onPoint } = props;
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const [article, setArticle] = useState<HTMLDivElement | null>(null);
  const [headings, setHeadings] = useState<ReadonlyMap<string, HTMLElement>>(new Map());
  const outline = kinDocOutline(doc.outline);
  const sections = kinDocSections(doc.body, doc.outline);
  const copySection = (id: string) => {
    const text = sections?.find((section) => section.id === id)?.text;
    return text === undefined ? null : () => props.onCopyText(text);
  };
  const { onEdit } = props;
  const editSection = (id: string | null) => {
    const found = id === null ? undefined : sections?.find((section) => section.id === id);
    return onEdit === null || found === undefined ? null : () => onEdit(found);
  };
  const hasTop = doc.outline[0]?.id === "top";
  const line = kinDocChangeLine(
    {
      at: doc.version.at,
      kind: doc.version.kind,
      summary: doc.version.summary,
      by: doc.version.provenance.by,
    },
    names,
    now,
  );
  const old = doc.version.version !== doc.latest.version;
  const previous = kinDocPrevious(doc.version);
  const privacy = kinDocPrivacy(doc);
  const label = useKinDocLabel(props, doc);
  // The body opens with the doc's own name as its heading: say it once.
  const first = doc.outline.find((section) => section.id !== "top");
  const titled =
    !hasTop && first?.level === 1 && plain(first.title).toLowerCase() === doc.title.toLowerCase();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- finds the heading elements the markdown renderer drew, to jump to them and to hang each section's menu on, again whenever it redraws
  useLayoutEffect(() => {
    const root = article;
    if (root === null) return;
    const scan = () => {
      const next = findHeadings(root, doc.outline);
      for (const heading of next.values()) {
        if (menuSlot(heading) !== null) continue;
        const slot = document.createElement("span");
        slot.dataset.kinDocSectionMenu = "";
        slot.className = "ms-1.5 inline-flex align-middle";
        heading.append(slot);
      }
      setHeadings((held) => {
        const same = next.size === held.size && [...next].every(([id, el]) => held.get(id) === el);
        return same ? held : next;
      });
    };
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(root, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      for (const slot of root.querySelectorAll("[data-kin-doc-section-menu]")) slot.remove();
    };
  }, [article, doc.outline]);

  // Moves the reader's own scroller only: `scrollIntoView` also shifts the page around it.
  const reveal = (element: HTMLElement | undefined) => {
    if (scroller === null || element === undefined) return;
    const top = element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTo({ top: scroller.scrollTop + top - 12 });
  };
  const jump = (id: string) => {
    if (id === "top") scroller?.scrollTo({ top: 0 });
    else reveal(headings.get(id));
  };
  /** A link to another part of the doc, such as a footnote, goes there in this scroller. */
  const followFragment = (event: MouseEvent<HTMLElement>) => {
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    const href = link?.getAttribute("href");
    if (article === null || href === null || href === undefined || !href.startsWith("#")) return;
    event.preventDefault();
    event.stopPropagation();
    let id = href.slice(1);
    try {
      id = decodeURIComponent(id);
    } catch {
      // A malformed escape is looked up as written.
    }
    const bare = (held: string) => held.replace(/^(user-content-)+/, "");
    reveal(
      [...article.querySelectorAll<HTMLElement>("[id]")].find(
        (held) => held.id === id || bare(held.id) === bare(id),
      ),
    );
  };
  const arrived = useRef<string | null>(null);
  const target = props.section !== null && headings.has(props.section) ? props.section : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the page to the section a link or a search hit named, once its heading is drawn
  useEffect(() => {
    if (target === null || arrived.current === target) return;
    const heading = headings.get(target);
    if (heading === undefined || scroller === null) return;
    arrived.current = target;
    const top = heading.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTo({ top: scroller.scrollTop + top - 12 });
  }, [target, headings, scroller]);

  const point = (section: string | null) =>
    onPoint === null ? null : (intent: KinDocAsk) => onPoint(kinDocRef(doc, section), intent);

  return (
    <>
      {props.actions === null
        ? null
        : createPortal(
            <>
              {kinDocHasContents(doc.outline) ? (
                <Menu>
                  <MenuTrigger
                    render={
                      <Button size="icon-sm" variant="ghost" aria-label={KIN_DOCS.contents} />
                    }
                  >
                    <ListIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    {outline.map((row) => (
                      <MenuItem key={row.id} onClick={() => jump(row.id)}>
                        <span
                          className={row.depth === 0 ? "font-medium" : "text-muted-foreground"}
                          style={{ paddingInlineStart: `${row.depth * 0.75}rem` }}
                        >
                          {row.title}
                        </span>
                      </MenuItem>
                    ))}
                  </MenuPopup>
                </Menu>
              ) : null}
              <Menu>
                <MenuTrigger
                  render={<Button size="icon-sm" variant="ghost" aria-label="Doc actions" />}
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  <AskItems
                    onAsk={point(null)}
                    onEdit={sections?.length === 1 ? editSection(sections[0]!.id) : null}
                    suggests={props.suggests === true}
                    onCopyLink={() => props.onCopyLink(null)}
                    onCopyText={() => props.onCopyText(doc.body)}
                  />
                  {onEdit === null || sections === null || sections.length < 2 ? null : (
                    <MenuSub>
                      <MenuSubTrigger>
                        <PencilLineIcon />
                        {KIN_DOCS.change}
                      </MenuSubTrigger>
                      <MenuSubPopup>
                        {sections.map((section) => (
                          <MenuItem key={section.id} onClick={() => onEdit(section)}>
                            {section.title}
                          </MenuItem>
                        ))}
                      </MenuSubPopup>
                    </MenuSub>
                  )}
                  <MenuSeparator />
                  <MenuItem onClick={props.onHistory}>
                    <HistoryIcon />
                    {KIN_DOCS.history}
                  </MenuItem>
                  <MenuItem
                    onClick={() => {
                      const file = kinDocExport(doc);
                      downloadPlanAsTextFile(file.filename, file.text);
                    }}
                  >
                    <ShareIcon />
                    {KIN_DOCS.export}
                  </MenuItem>
                  {props.onExportPdf === null ? null : (
                    <MenuItem onClick={props.onExportPdf}>
                      <FileDownIcon />
                      {KIN_DOCS.exportPdf}
                    </MenuItem>
                  )}
                  {label.action === null ? null : (
                    <MenuItem onClick={label.ask}>
                      {label.action.sensitive ? <LockIcon /> : <LockOpenIcon />}
                      {label.action.label}
                    </MenuItem>
                  )}
                </MenuPopup>
              </Menu>
            </>,
            props.actions,
          )}
      <div
        ref={setScroller}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-both"
      >
        <article className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 pt-6 pb-24">
          <header className="flex flex-col gap-2">
            {titled ? null : (
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">{doc.title}</h1>
            )}
            <p className="text-sm text-muted-foreground">
              {line.lead}
              {line.summary === null ? null : ` · ${line.summary}`}
              {previous === null ? null : (
                <>
                  {" · "}
                  <button
                    type="button"
                    onClick={() => props.onSeeChanges(doc.version.version)}
                    className="rounded-sm font-medium text-foreground underline-offset-2 outline-none ring-ring hover:underline focus-visible:ring-2 focus-visible:ring-inset"
                  >
                    {KIN_DOCS.changes}
                  </button>
                </>
              )}
            </p>
            {label.dialog}
            {label.problem === null ? null : (
              <Alert variant="error">
                <AlertDescription>{label.problem}</AlertDescription>
                <AlertAction>
                  <Button size="xs" variant="ghost" onClick={label.dismiss}>
                    Dismiss
                  </Button>
                </AlertAction>
              </Alert>
            )}
            {privacy === null ? null : (
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <LockIcon aria-hidden className="size-3.5 shrink-0" />
                {privacy}
              </p>
            )}
            {old ? (
              <Alert variant="warning">
                <AlertDescription>
                  {KIN_DOCS.oldVersion(doc.version.version, doc.latest.version)}
                </AlertDescription>
                <AlertAction>
                  <Button size="xs" variant="outline" onClick={props.onOpenLatest}>
                    {KIN_DOCS.openLatest}
                  </Button>
                  {props.onRestore === null ? null : (
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => props.onRestore?.(doc.version.version)}
                    >
                      {KIN_DOCS.restore}
                    </Button>
                  )}
                </AlertAction>
              </Alert>
            ) : null}
          </header>
          {doc.version.file === undefined ? null : (
            <KinDocFileCard environmentId={props.environmentId} file={doc.version.file} />
          )}
          {doc.body.trim() === "" ? (
            doc.version.file === undefined ? (
              <p className="text-sm text-muted-foreground">{KIN_DOCS.noText}</p>
            ) : null
          ) : (
            <div
              ref={setArticle}
              onClickCapture={followFragment}
              className="flex flex-col gap-3 leading-relaxed text-foreground"
            >
              {kinDocPieces(doc.body, doc).map((piece, index) =>
                piece.type === "text" ? (
                  <ChatMarkdown
                    key={kinDocPieceKey(piece, index)}
                    text={kinDocMarkdown(piece.text, fileImageSource)}
                    cwd={undefined}
                    environmentId={props.environmentId}
                    imageAttachment={fileImageAttachment}
                  />
                ) : (
                  <div key={kinDocPieceKey(piece, index)} data-kin-doc-embed="">
                    <KinEmbedView
                      environmentId={props.environmentId}
                      orgId={props.orgId}
                      embed={piece.embed}
                    />
                  </div>
                ),
              )}
            </div>
          )}
          {props.linked}
        </article>
      </div>
      {[...headings].map(([id, heading]) => {
        const slot = menuSlot(heading);
        return slot === null
          ? null
          : createPortal(
              <Menu>
                <MenuTrigger
                  render={
                    <Button size="icon-xs" variant="ghost-muted" aria-label="Section actions" />
                  }
                >
                  <EllipsisIcon />
                </MenuTrigger>
                <MenuPopup align="start">
                  <AskItems
                    onAsk={point(id)}
                    onEdit={editSection(id)}
                    suggests={props.suggests === true}
                    onCopyLink={() => props.onCopyLink(id)}
                    onCopyText={copySection(id)}
                  />
                </MenuPopup>
              </Menu>,
              slot,
              id,
            );
      })}
      <KinDocSelectionMenu
        root={article}
        resolve={(node) => (article === null ? null : sectionAt(article, headings, node, hasTop))}
        onAsk={onPoint === null ? null : (section, intent) => point(section)?.(intent)}
        onEdit={(section) => editSection(section)?.()}
        canEdit={onEdit !== null && sections !== null}
        suggests={props.suggests === true}
        onCopyLink={props.onCopyLink}
      />
    </>
  );
}

/** Ask, change and copy link, beside whatever text is selected in the doc. */
function KinDocSelectionMenu(props: {
  readonly root: HTMLDivElement | null;
  readonly resolve: (node: Node) => string | null;
  readonly onAsk: ((section: string | null, intent: KinDocAsk) => void) | null;
  /** Changes the selection's section by hand, where `canEdit`. */
  readonly onEdit: (section: string | null) => void;
  readonly canEdit: boolean;
  readonly suggests: boolean;
  readonly onCopyLink: (section: string | null) => void;
}) {
  const [held, setHeld] = useState<{
    readonly node: Node;
    readonly position: SelectionActionPoint;
  } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const { root } = props;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the document's selectionchange to follow text selected inside the doc
  useEffect(() => {
    if (root === null) return;
    const clear = () => setHeld(null);
    const actions = observeSelectionActions({
      element: root,
      getActionElement: () => barRef.current,
      onDismiss: clear,
      onSelection: (pointer) => {
        const selection = window.getSelection();
        const range =
          selection === null || selection.rangeCount === 0 || selection.isCollapsed
            ? null
            : selection.getRangeAt(0);
        if (
          range === null ||
          !root.contains(range.commonAncestorContainer) ||
          range.toString().trim() === "" ||
          (range.startContainer.parentElement?.closest("[data-kin-doc-section-menu]") ?? null) !==
            null
        )
          return clear();
        const bounds = root.getBoundingClientRect();
        const rects = range.getClientRects();
        const last = rects.item(rects.length - 1) ?? range.getBoundingClientRect();
        if (!isSelectionRectVisible(last, [{ ...bounds.toJSON(), top: 0, bottom: innerHeight }]))
          return clear();
        setHeld({
          node: range.startContainer,
          position: resolveSelectionActionPosition({
            bounds,
            selectionRect: last,
            pointer,
            viewport: { width: window.innerWidth, height: window.innerHeight },
          }),
        });
      },
    });
    document.addEventListener("selectionchange", actions.selectionChanged);
    return () => {
      document.removeEventListener("selectionchange", actions.selectionChanged);
      actions.dispose();
    };
  }, [root]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the bar's DOM node and clamps it inside the window before paint
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (bar === null || held === null) return;
    const rect = bar.getBoundingClientRect();
    bar.style.left = `${Math.max(8, Math.min(held.position.x, window.innerWidth - rect.width - 8))}px`;
    bar.style.top = `${Math.max(8, Math.min(held.position.y, window.innerHeight - rect.height - 8))}px`;
  }, [held]);

  if (held === null) return null;
  const done = () => {
    window.getSelection()?.removeAllRanges();
    setHeld(null);
  };
  const { onAsk } = props;
  const section = () => props.resolve(held.node);
  return createPortal(
    <div
      ref={barRef}
      role="toolbar"
      aria-label="About the selected text"
      className="fixed z-50 flex max-w-[calc(100vw-1rem)] items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg"
      style={{ left: held.position.x, top: held.position.y }}
      onPointerDown={(event) => event.preventDefault()}
    >
      {onAsk === null ? null : (
        <>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              onAsk(section(), "ask");
              done();
            }}
          >
            <MessageCircleQuestionIcon />
            {KIN_DOCS.ask}
          </Button>
          {props.canEdit ? null : (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                onAsk(section(), "change");
                done();
              }}
            >
              <PencilLineIcon />
              {props.suggests ? KIN_DOCS.suggest : KIN_DOCS.change}
            </Button>
          )}
        </>
      )}
      {props.canEdit ? (
        <Button
          size="xs"
          variant="ghost"
          onClick={() => {
            props.onEdit(section());
            done();
          }}
        >
          <PencilLineIcon />
          {KIN_DOCS.change}
        </Button>
      ) : null}
      <Button
        size="xs"
        variant="ghost"
        onClick={() => {
          props.onCopyLink(section());
          done();
        }}
      >
        <LinkIcon />
        {KIN_DOCS.copyLink}
      </Button>
    </div>,
    document.body,
  );
}
