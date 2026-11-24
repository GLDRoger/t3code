import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_SETTINGS_COPY } from "@t3tools/client-runtime/kin/kinSettingsSpread";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { SettingsGroup } from "../../components/settings/SettingsGroup";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Skeleton } from "../../components/ui/skeleton";

/**
 * Kin's Settings pages, one anatomy for all of them (docs: plan-detail/web-settings-patterns.md).
 * The modal header carries the page's name, so a page starts with what it is for, then sections.
 */
export function KinSettingsPage(props: {
  /** What comes before the purpose: a section's own switch. */
  readonly top?: ReactNode;
  /** One sentence on what the page is for, from the person's side. */
  readonly purpose?: ReactNode;
  /** The page's one primary action, beside the purpose: "Add check-in". */
  readonly action?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-6 sm:px-6">
      {props.top}
      {props.purpose === undefined && props.action === undefined ? null : (
        <div className="flex min-h-8 items-start justify-between gap-4">
          <p className="text-pretty pt-1 text-sm text-muted-foreground">{props.purpose}</p>
          {props.action === undefined ? null : <div className="shrink-0">{props.action}</div>}
        </div>
      )}
      {props.children}
    </div>
  );
}

/** A titled group of rows in one card. `plain` drops the card for a free block. */
export function KinSettingsSection(props: {
  readonly title?: string;
  readonly description?: ReactNode;
  /** One quiet action for the section, at the right of its title. */
  readonly action?: ReactNode;
  /** The last change's failure, said under the card until the next change. */
  readonly problem?: string | null;
  /** `useSearchableSetting(...).id`, so a settings search lands here. */
  readonly searchId?: string;
  readonly plain?: boolean;
  readonly children: ReactNode;
}) {
  const hasHeader =
    props.title !== undefined || props.description !== undefined || props.action !== undefined;
  return (
    <section
      id={props.searchId}
      tabIndex={props.searchId === undefined ? undefined : -1}
      aria-label={props.title}
      className="flex flex-col gap-2 outline-none"
    >
      {hasHeader ? (
        <div className="flex min-h-7 items-end justify-between gap-3 px-1">
          <div className="flex min-w-0 flex-col gap-0.5">
            {props.title === undefined ? null : (
              <h3 className="text-sm font-semibold text-foreground">{props.title}</h3>
            )}
            {props.description === undefined ? null : (
              <p className="text-pretty text-xs text-muted-foreground">{props.description}</p>
            )}
          </div>
          {props.action === undefined ? null : <div className="shrink-0">{props.action}</div>}
        </div>
      ) : null}
      <SettingsGroup variant={props.plain === true ? "plain" : "grouped"}>
        {props.children}
      </SettingsGroup>
      {props.problem == null ? null : <KinSettingsProblem>{props.problem}</KinSettingsProblem>}
    </section>
  );
}

/**
 * The one row. Main text says which thing it is; `detail` is one secondary line; `status` shows
 * only when something is not fine; `control` is at most one quiet control; `onOpen` makes the
 * whole row the target and adds the chevron.
 */
export function KinSettingsRow(props: {
  readonly title: ReactNode;
  readonly detail?: ReactNode;
  /** A mark before the text: a 24px avatar, or a 16px icon centred in the same slot. */
  readonly leading?: ReactNode;
  readonly status?: ReactNode;
  readonly control?: ReactNode;
  readonly onOpen?: () => void;
  /** What a screen reader hears for the row's target, when the title alone isn't enough. */
  readonly openLabel?: string;
  /** Lets a long main text wrap instead of cutting it: a sentence, not a name. */
  readonly wrap?: boolean;
  /** Several wide controls: they drop below the text when both don't fit, and the text breaks anywhere. */
  readonly stack?: boolean;
  /** `useSearchableSetting(...).id`, so a settings search lands on this row. */
  readonly searchId?: string;
}) {
  const stack = props.stack === true;
  const text =
    props.wrap === true ? "text-pretty" : stack ? "[overflow-wrap:anywhere]" : "truncate";
  return (
    <div
      data-slot="kin-settings-row"
      id={props.searchId}
      tabIndex={props.searchId === undefined ? undefined : -1}
      // A found row rings inside the card, so the ring never covers the rows beside it.
      className={`relative flex min-h-12 items-center gap-3 px-4 py-2.5 outline-none first:rounded-t-xl last:rounded-b-xl has-[[data-kin-row-open]:hover]:bg-accent/50 data-[kin-setting-found]:ring-inset! data-[kin-setting-found]:ring-offset-0!${stack ? " flex-wrap" : ""}`}
    >
      {props.leading === undefined ? null : (
        <span className="flex size-6 shrink-0 items-center justify-center text-muted-foreground">
          {props.leading}
        </span>
      )}
      <div className={`flex min-w-0 flex-1 flex-col gap-0.5${stack ? " basis-48" : ""}`}>
        {props.onOpen === undefined ? (
          <span className={`${text} text-sm font-medium text-foreground`}>{props.title}</span>
        ) : (
          <button
            type="button"
            data-kin-row-open
            aria-label={props.openLabel}
            onClick={props.onOpen}
            className={`${text} text-start text-sm font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring`}
          >
            {props.title}
          </button>
        )}
        {props.detail === undefined || props.detail === null ? null : (
          <span className={`${text} text-xs text-muted-foreground`}>{props.detail}</span>
        )}
      </div>
      {props.status === undefined || props.status === null ? null : (
        <span className="shrink-0">{props.status}</span>
      )}
      {props.control === undefined || props.control === null ? null : (
        <div className={`relative z-10 flex shrink-0 items-center gap-2${stack ? " ml-auto" : ""}`}>
          {props.control}
        </div>
      )}
      {props.onOpen === undefined ? null : (
        <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      )}
    </div>
  );
}

/**
 * A row's state when it is not fine. `attention` and `error` are badges; `quiet` (Off, Paused) is
 * plain text. A fine state shows nothing: pass no status at all.
 */
export function KinSettingsStatus(props: {
  readonly tone: "attention" | "error" | "quiet";
  readonly children: ReactNode;
}) {
  return props.tone === "quiet" ? (
    <span className="text-xs text-muted-foreground">{props.children}</span>
  ) : (
    <Badge variant={props.tone === "error" ? "error" : "warning"}>{props.children}</Badge>
  );
}

/** Inside a section's card when it has nothing: one sentence, then the way to add the first. */
export function KinSettingsEmpty(props: {
  readonly children: ReactNode;
  readonly action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-start gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-pretty text-sm text-muted-foreground">{props.children}</p>
      {props.action === undefined ? null : <div className="shrink-0">{props.action}</div>}
    </div>
  );
}

/** Rows' shape while the first answer comes, so nothing jumps when it does. */
export function KinSettingsLoading(props: { readonly rows?: number }) {
  return (
    <div aria-busy role="status" aria-label={KIN_SETTINGS_COPY.loading}>
      {Array.from({ length: props.rows ?? 3 }, (_, index) => (
        <div key={index} className="flex min-h-12 items-center gap-3 px-4 py-2.5">
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3 w-64 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** The first read failed: what couldn't load, and Try again. */
export function KinSettingsLoadFailed(props: {
  readonly children: ReactNode;
  readonly onRetry: () => void;
}) {
  return (
    <KinSettingsEmpty
      action={
        <Button size="xs" variant="outline" onClick={props.onRetry}>
          {KIN_RETRY}
        </Button>
      }
    >
      <span role="alert">{props.children}</span>
    </KinSettingsEmpty>
  );
}

/**
 * The last line of a long list's card: the first rows show, and this shows the rest. Lists stay
 * short to open; a person who wants all of them asks once.
 */
export function KinSettingsShowAll(props: { readonly label: string; readonly onShow: () => void }) {
  return (
    <div className="flex min-h-10 items-center px-2 py-1">
      <Button size="xs" variant="ghost" onClick={props.onShow}>
        {props.label}
      </Button>
    </div>
  );
}

/**
 * Several read-mostly values that one form edits, read at a glance: label, then value, one line
 * each, wrapping long values. The section's own action opens the form, so there is one way in,
 * not one per line. `attention` marks only a line missing something the reader needs.
 */
export function KinSettingsFacts(props: {
  readonly facts: ReadonlyArray<{
    readonly label: string;
    readonly value: ReactNode;
    readonly attention?: ReactNode;
  }>;
}) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-1 px-4 py-3 sm:grid-cols-[minmax(8rem,auto)_1fr] sm:gap-y-2">
      {props.facts.map((fact) => (
        <div key={fact.label} className="contents">
          <dt className="pt-1 text-xs text-muted-foreground sm:pt-0 sm:text-sm">{fact.label}</dt>
          <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-foreground">
            <span className="min-w-0 whitespace-pre-line break-words">{fact.value}</span>
            {fact.attention === undefined || fact.attention === null ? null : (
              <KinSettingsStatus tone="attention">{fact.attention}</KinSettingsStatus>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A change that didn't go through, in one line under where it was made. */
function KinSettingsProblem(props: { readonly children: ReactNode }) {
  return (
    <p role="alert" className="px-1 text-xs text-destructive-foreground">
      {props.children}
    </p>
  );
}
