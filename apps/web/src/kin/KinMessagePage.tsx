import { kinBodyMarkdown } from "@t3tools/client-runtime/kin/kinChatFeed";
import { kinDocPieceKey, kinDocPieces } from "@t3tools/client-runtime/kin/kinDocs";
import {
  kinLinkedMarkdown,
  kinLinkOf,
  kinPageView,
} from "@t3tools/client-runtime/kin/kinMessagePage";
import {
  KinChatId,
  KinOrgId,
  KinPersonId,
  type EnvironmentId,
  type KinEmbed,
  type KinMessageLink,
} from "@t3tools/contracts";
import { Link, useRouter } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import ChatMarkdown, { type ChatMarkdownContextReference } from "../components/ChatMarkdown";
import { cn } from "../lib/utils";
import { KinEmbedView } from "./KinEmbedView";
import { openKinProfile } from "./KinProfileSheet";
import { kinRecordPlace } from "./kinPlaces";
import { openKinSettings } from "./kinSettingsAddress";
import { kinProfileRequestAtom } from "./kinTeamForm";
import { appAtomRegistry } from "../rpc/atomRegistry";

interface Where {
  readonly environmentId: EnvironmentId;
  readonly orgId: string;
}

/** A name in a message, as an in-app link to what it names; its hover says the entry's state. */
function KinInAppLink(props: Where & { readonly link: KinMessageLink; readonly label: string }) {
  const { link, label } = props;
  const params = { environmentId: props.environmentId, orgId: props.orgId };
  const title = link.note ?? undefined;
  const to = link.to;
  const router = useRouter();
  switch (to._tag) {
    case "chat":
      return (
        <Link
          to="/kin/$environmentId/$orgId/$chatId"
          params={{ ...params, chatId: to.chatId }}
          title={title}
          onClick={() => {
            // An agent's bare name opens its page beside its chat; "finance chat" just the chat.
            if (!/\bchat$/i.test(label.trim()))
              appAtomRegistry.set(kinProfileRequestAtom, KinChatId.make(to.chatId));
          }}
        >
          {label}
        </Link>
      );
    case "settings":
      return (
        <button
          type="button"
          className="text-info-foreground hover:underline focus-visible:underline outline-none"
          onClick={() => openKinSettings(router.history)}
        >
          {label}
        </button>
      );
    case "person":
      return (
        <button
          type="button"
          className="text-info-foreground hover:underline focus-visible:underline outline-none"
          onClick={() =>
            openKinProfile({
              environmentId: props.environmentId,
              orgId: KinOrgId.make(props.orgId),
              personId: KinPersonId.make(to.personId),
            })
          }
        >
          {label}
        </button>
      );
    case "record": {
      const place = kinRecordPlace(to);
      return (
        <Link to={place.to} params={params} search={place.search} title={title}>
          {label}
        </Link>
      );
    }
  }
}

/** A message's markdown with the names in it as links: in a bubble, a page or a brief. */
export function KinLinkedMarkdown(
  props: Where & {
    readonly markdown: string;
    readonly links: ReadonlyArray<KinMessageLink> | undefined;
  },
) {
  const renderContextReference = (reference: ChatMarkdownContextReference): ReactNode => {
    const link = kinLinkOf(`t3-context://v1/${reference.kind}/${reference.contextId}`, props.links);
    return link === null ? (
      <span>{reference.label}</span>
    ) : (
      <KinInAppLink {...props} link={link} label={reference.label} />
    );
  };
  return (
    <ChatMarkdown
      text={kinLinkedMarkdown(kinBodyMarkdown(props.markdown), props.links)}
      cwd={undefined}
      environmentId={props.environmentId}
      lineBreaks
      renderContextReference={renderContextReference}
    />
  );
}

interface PageText extends Where {
  readonly links: ReadonlyArray<KinMessageLink> | undefined;
  /** The whole body and its figures, so a block in any part finds the figure drawn for it. */
  readonly body: string;
  readonly embeds: ReadonlyArray<KinEmbed> | undefined;
}

/** A stretch of a page: its words with their links, and each figure in its place. */
function KinPageText(props: PageText & { readonly markdown: string }) {
  const pieces = kinDocPieces(props.markdown, props);
  return pieces.map((piece, index) =>
    piece.type === "text" ? (
      <KinLinkedMarkdown key={kinDocPieceKey(piece, index)} {...props} markdown={piece.text} />
    ) : (
      <div key={kinDocPieceKey(piece, index)} className="py-1">
        <KinEmbedView
          environmentId={props.environmentId}
          orgId={KinOrgId.make(props.orgId)}
          embed={piece.embed}
        />
      </div>
    ),
  );
}

/** One titled part of a page; its heading folds it away and back. */
function KinPageSection(props: PageText & { readonly title: string; readonly markdown: string }) {
  const [open, setOpen] = useState(true);
  const id = useId();
  return (
    <section aria-labelledby={id} className="border-t border-border/70 pt-3">
      <h3 id={id} className="m-0">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="group/kin-section flex w-full items-center justify-between gap-2 rounded-md text-left text-sm font-semibold text-foreground outline-none ring-ring focus-visible:ring-2 focus-visible:ring-inset"
        >
          {props.title}
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-4 shrink-0 text-muted-foreground opacity-0 group-hover/kin-section:opacity-100 group-focus-visible/kin-section:opacity-100 pointer-coarse:opacity-100",
              !open && "-rotate-90 opacity-100",
            )}
          />
        </button>
      </h3>
      {open ? (
        <div className="flex flex-col gap-2 pt-1.5">
          <KinPageText {...props} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * An agent's long or structured message as a page: full column width, no bubble, its headings as
 * headings, each section folding on its own and its figures in place. A brief opens with its
 * greeting and date; the turn's card, when it has one, closes the page.
 */
export function KinMessagePage(
  props: PageText & {
    readonly head: { readonly greeting: string; readonly date: string } | null;
    readonly label: string;
    readonly foot?: ReactNode;
  },
) {
  const { head, foot, ...text } = props;
  const view = kinPageView(props.body, head !== null);
  return (
    <article
      aria-label={props.label}
      className="flex w-full min-w-0 flex-col gap-3 py-1 text-sm text-foreground"
    >
      {head === null ? null : (
        <header className="flex flex-col gap-0.5">
          <h2 className="m-0 font-serif text-3xl leading-tight font-normal italic tracking-tight text-foreground">
            {head.greeting}
          </h2>
          <p className="m-0 text-xs text-muted-foreground">{head.date}</p>
        </header>
      )}
      {view.lead === null ? null : <KinPageText {...text} markdown={view.lead} />}
      {view.sections.map((section) => (
        <KinPageSection
          key={`${section.title}:${section.markdown.slice(0, 48)}`}
          {...text}
          title={section.title}
          markdown={section.markdown}
        />
      ))}
      {foot === undefined || foot === null ? null : <div className="pt-1">{foot}</div>}
    </article>
  );
}
