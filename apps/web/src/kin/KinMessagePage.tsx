import { kinBodyMarkdown } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  kinBriefHead,
  kinLinkedMarkdown,
  kinLinkOf,
  kinPageView,
} from "@t3tools/client-runtime/kin/kinMessagePage";
import {
  KinOrgId,
  KinPersonId,
  type EnvironmentId,
  type KinMessageLink,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import ChatMarkdown, { type ChatMarkdownContextReference } from "../components/ChatMarkdown";
import { cn } from "../lib/utils";
import { openKinProfile } from "./KinProfileSheet";
import { KIN_PLACE_PATH } from "./kinPlaces";

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
  switch (to._tag) {
    case "chat":
      return (
        <Link to="/kin/$environmentId/$orgId/$chatId" params={{ ...params, chatId: to.chatId }} title={title}>
          {label}
        </Link>
      );
    case "settings":
      return (
        <Link to="/kin/$environmentId/$orgId/settings" params={params}>
          {label}
        </Link>
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
      const place =
        to.kind === "task"
          ? KIN_PLACE_PATH.tasks
          : to.kind === "entry"
            ? KIN_PLACE_PATH.money
            : to.kind === "doc"
              ? KIN_PLACE_PATH.docs
              : KIN_PLACE_PATH.clients;
      const search =
        to.kind === "client"
          ? { client: to.key }
          : to.kind === "project"
            ? { project: to.key }
            : to.kind === "doc"
              ? { doc: to.key }
              : { task: to.key };
      return (
        <Link to={place} params={params} search={search} title={title}>
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

/** One titled part of a page; its heading folds it away and back. */
function KinPageSection(
  props: Where & {
    readonly title: string;
    readonly markdown: string;
    readonly links: ReadonlyArray<KinMessageLink> | undefined;
  },
) {
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
        <div className="pt-1.5">
          <KinLinkedMarkdown {...props} />
        </div>
      ) : null}
    </section>
  );
}

/**
 * An agent's long or structured message as a page: full column width, no bubble, its headings as
 * headings and each section folding on its own. A brief opens with its greeting and date.
 */
export function KinMessagePage(
  props: Where & {
    readonly body: string;
    readonly links: ReadonlyArray<KinMessageLink> | undefined;
    readonly brief: { readonly createdAt: string; readonly firstName: string | null } | null;
    readonly label: string;
  },
) {
  const view = kinPageView(props.body, props.brief !== null);
  const head = props.brief === null ? null : kinBriefHead(props.brief.createdAt, props.brief.firstName);
  return (
    <article aria-label={props.label} className="flex w-full min-w-0 flex-col gap-3 py-1 text-sm text-foreground">
      {head === null ? null : (
        <header className="flex flex-col gap-0.5">
          <h2 className="m-0 font-serif text-3xl leading-tight font-normal italic tracking-tight text-foreground">
            {head.greeting}
          </h2>
          <p className="m-0 text-xs text-muted-foreground">{head.date}</p>
        </header>
      )}
      {view.lead === null ? null : <KinLinkedMarkdown {...props} markdown={view.lead} />}
      {view.sections.map((section) => (
        <KinPageSection
          key={`${section.title}:${section.markdown.slice(0, 48)}`}
          {...props}
          title={section.title}
          markdown={section.markdown}
        />
      ))}
    </article>
  );
}
