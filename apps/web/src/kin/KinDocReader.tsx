import {
  KIN_DOCS,
  kinDocChangeLine,
  kinDocExport,
  kinDocHasContents,
  kinDocOutline,
  kinDocPrevious,
  kinDocPrivacy,
  kinDocRef,
  type KinDocAsk,
} from "@t3tools/client-runtime/kin/kinDocs";
import type { KinDocDetail, KinDocSection, KinMessageRef } from "@t3tools/contracts";
import {
  EllipsisIcon,
  HistoryIcon,
  LinkIcon,
  ListIcon,
  LockIcon,
  MessageCircleQuestionIcon,
  PencilLineIcon,
  ShareIcon,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { kinBodyMarkdown } from "@t3tools/client-runtime/kin/kinChatFeed";
import ChatMarkdown from "../components/ChatMarkdown";
import { Alert, AlertAction, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import {
  isSelectionRectVisible,
  observeSelectionActions,
  resolveSelectionActionPosition,
  type SelectionActionPoint,
} from "../lib/selectionActions";
import { downloadPlanAsTextFile } from "../proposedPlan";
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
    (heading) => heading.closest("blockquote,li,table") === null,
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

function AskItems(props: {
  readonly onAsk: ((intent: KinDocAsk) => void) | null;
  readonly onCopyLink: () => void;
}) {
  return (
    <>
      <MenuItem disabled={props.onAsk === null} onClick={() => props.onAsk?.("ask")}>
        <MessageCircleQuestionIcon />
        {KIN_DOCS.ask}
      </MenuItem>
      <MenuItem disabled={props.onAsk === null} onClick={() => props.onAsk?.("change")}>
        <PencilLineIcon />
        {KIN_DOCS.change}
      </MenuItem>
      <MenuItem onClick={props.onCopyLink}>
        <LinkIcon />
        {KIN_DOCS.copyLink}
      </MenuItem>
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
    readonly onCopyLink: (section: string | null) => void;
    readonly onSeeChanges: (to: number) => void;
    readonly onOpenLatest: () => void;
    readonly onHistory: () => void;
    /** Null where this browser may not restore. */
    readonly onRestore: ((version: number) => void) | null;
    /** Where the page header's own buttons go. */
    readonly actions: HTMLElement | null;
  },
) {
  const { doc, onPoint } = props;
  const { names } = props.directory;
  const now = new Date(useNowMinuteMs());
  const scrollRef = useRef<HTMLDivElement>(null);
  const [article, setArticle] = useState<HTMLDivElement | null>(null);
  const [headings, setHeadings] = useState<ReadonlyMap<string, HTMLElement>>(new Map());
  const outline = kinDocOutline(doc.outline);
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
  // The body opens with the doc's own name as its heading: say it once.
  const first = doc.outline.find((section) => section.id !== "top");
  const titled =
    !hasTop && first?.level === 1 && plain(first.title).toLowerCase() === doc.title.toLowerCase();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- finds the heading elements the markdown renderer drew, to jump to them and to hang each section's menu on, again whenever it redraws
  useLayoutEffect(() => {
    const root = article;
    if (root === null) return;
    const scan = () =>
      setHeadings((held) => {
        const next = findHeadings(root, doc.outline);
        const same = next.size === held.size && [...next].every(([id, el]) => held.get(id) === el);
        return same ? held : next;
      });
    scan();
    const observer = new MutationObserver(scan);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [article, doc.outline]);

  const jump = (id: string) => {
    if (id === "top") scrollRef.current?.scrollTo({ top: 0 });
    else headings.get(id)?.scrollIntoView({ block: "start" });
  };
  const arrived = useRef<string | null>(null);
  const target = props.section !== null && headings.has(props.section) ? props.section : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the page to the section a link or a search hit named, once its heading is drawn
  useEffect(() => {
    if (target === null || arrived.current === target) return;
    arrived.current = target;
    headings.get(target)?.scrollIntoView({ block: "start" });
  }, [target, headings]);

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
                  <AskItems onAsk={point(null)} onCopyLink={() => props.onCopyLink(null)} />
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
                </MenuPopup>
              </Menu>
            </>,
            props.actions,
          )}
      <div
        ref={scrollRef}
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
            {privacy === null ? null : (
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <LockIcon aria-hidden className="size-3.5 shrink-0" />
                {privacy}
              </p>
            )}
            {old ? (
              <Alert variant="warning">
                <AlertDescription>
                  You're reading version {doc.version.version}. The latest is version{" "}
                  {doc.latest.version}.
                </AlertDescription>
                <AlertAction>
                  <Button size="xs" variant="outline" onClick={props.onOpenLatest}>
                    Open the latest
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
          {doc.body.trim() === "" ? (
            <p className="text-sm text-muted-foreground">This doc has no text yet.</p>
          ) : (
            <div ref={setArticle} className="leading-relaxed text-foreground">
              <ChatMarkdown
                text={kinBodyMarkdown(doc.body)}
                cwd={undefined}
                environmentId={props.environmentId}
              />
            </div>
          )}
        </article>
      </div>
      {[...headings].map(([id, heading]) =>
        createPortal(
          <span data-kin-doc-section-menu className="ms-1.5 inline-flex align-middle" key={id}>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label={`Section actions: ${heading.dataset.kinDocTitle ?? ""}`}
                  />
                }
              >
                <EllipsisIcon />
              </MenuTrigger>
              <MenuPopup align="start">
                <AskItems onAsk={point(id)} onCopyLink={() => props.onCopyLink(id)} />
              </MenuPopup>
            </Menu>
          </span>,
          heading,
          id,
        ),
      )}
      <KinDocSelectionMenu
        root={article}
        resolve={(node) => (article === null ? null : sectionAt(article, headings, node, hasTop))}
        onAsk={onPoint === null ? null : (section, intent) => point(section)?.(intent)}
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
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              onAsk(section(), "change");
              done();
            }}
          >
            <PencilLineIcon />
            {KIN_DOCS.change}
          </Button>
        </>
      )}
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
