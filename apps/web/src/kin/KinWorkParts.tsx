import { KIN_RETRY, kinFailure } from "@t3tools/client-runtime/kin/kinAnswers";
import { KIN_WORK_PRIVATE, kinWorkStaleNotice } from "@t3tools/client-runtime/kin/kinWork";
import { kinHostLink } from "@t3tools/client-runtime/kin/kinHost";
import type {
  KinHealthView,
  KinWorkTimelineLine,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import type { KinWorkFormProblem } from "@t3tools/client-runtime/kin/kinWorkForms";
import { KIN_WORK_FORM_COPY } from "@t3tools/client-runtime/kin/kinWorkForms";
import type { EnvironmentId, KinRecordKey } from "@t3tools/contracts";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  ListFilterIcon,
  LockIcon,
  XIcon,
} from "lucide-react";
import { useState } from "react";

import { Alert, AlertAction, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItemLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../components/ui/menu";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";
import { KIN_GATE_FAILED, type KinGate } from "@t3tools/client-runtime/kin/kinAccess";
import { KIN_OFFLINE_PAGE } from "@t3tools/client-runtime/kin/kinAnswers";
import { retryKinAccess } from "./kinClient";
import { useKinHost, useKinHostAt } from "./useKinHost";

/**
 * A titled block of a task, client or project, with an optional action beside the title. With
 * `fold` it is one line, its title and summary, that opens to the block; the action shows open.
 */
export function KinWorkSection(props: {
  readonly title: string;
  readonly action?: React.ReactNode;
  /** One line instead; `onOpen` makes the line open a page rather than unfold the block. */
  readonly fold?: { readonly summary: string | null; readonly onOpen?: () => void };
  readonly children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (props.fold === undefined)
    return (
      <section className="flex flex-col gap-2">
        <div className="flex min-h-6 flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <h3 className="text-xs font-medium whitespace-nowrap text-muted-foreground">
            {props.title}
          </h3>
          {props.action}
        </div>
        {props.children}
      </section>
    );
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <button
          type="button"
          aria-expanded={props.fold.onOpen === undefined ? open : undefined}
          onClick={props.fold.onOpen ?? (() => setOpen(!open))}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-start outline-none ring-ring hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset"
        >
          <span className="shrink-0 text-sm text-foreground">{props.title}</span>
          {props.fold.summary === null ? null : (
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {props.fold.summary}
            </span>
          )}
          {props.fold.onOpen !== undefined ? (
            <ChevronRightIcon
              aria-hidden
              className="ms-auto size-4 shrink-0 text-muted-foreground"
            />
          ) : open ? (
            <ChevronUpIcon aria-hidden className="ms-auto size-4 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDownIcon
              aria-hidden
              className="ms-auto size-4 shrink-0 text-muted-foreground"
            />
          )}
        </button>
        {open ? props.action : null}
      </div>
      {open ? props.children : null}
    </section>
  );
}

/** The line over rows older than the host's, as `kinWorkStaleNotice` words it. */
export function KinWorkStaleLine(props: {
  readonly environmentId: EnvironmentId;
  readonly onRetry?: () => void;
}) {
  const notice = kinWorkStaleNotice(kinHostLink(useKinHostAt(props.environmentId)));
  if (notice === null) return null;
  return (
    <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
      {notice.message}
      {notice.retry && props.onRetry !== undefined ? (
        <Button size="xs" variant="outline" onClick={props.onRetry}>
          {KIN_RETRY}
        </Button>
      ) : null}
    </p>
  );
}

/** A small lock beside whatever only the owner sees. */
export function KinWorkPrivateMark() {
  return (
    <span className="inline-flex shrink-0 items-center text-muted-foreground">
      <LockIcon aria-hidden className="size-3.5" />
      <span className="sr-only">{KIN_WORK_PRIVATE}</span>
    </span>
  );
}

const HEALTH_VARIANT = { good: "success", warning: "warning", bad: "error" } as const;

export function KinWorkHealthBadge(props: { readonly health: KinHealthView }) {
  return (
    <Badge size="sm" variant={HEALTH_VARIANT[props.health.tone]}>
      {props.health.label}
    </Badge>
  );
}

/** A screen-wide word about why there is nothing to show, with one thing to do about it. */
export function KinWorkNotice(props: {
  readonly title: string;
  readonly detail: string;
  readonly action?: React.ReactNode;
}) {
  return (
    <Empty size="compact">
      <EmptyHeader>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.detail}</EmptyDescription>
      </EmptyHeader>
      {props.action === undefined ? null : <EmptyContent>{props.action}</EmptyContent>}
    </Empty>
  );
}

/**
 * A read that failed, said as `kinFailure` says it: a Retry only when the request got no answer
 * or Kin is busy, else the host's reason with nothing to retry.
 */
export function KinLoadFailed(props: {
  /** What failed, as a heading: "Couldn't load this list". */
  readonly what: string;
  /** The failure: an error, a Cause or a failed AsyncResult; unknown reads as the connection. */
  readonly cause: unknown;
  readonly onRetry: () => void;
  readonly className?: string;
}) {
  const failure = kinFailure(props.cause, `${props.what}.`);
  return (
    <div className={cn("flex flex-col items-start gap-3", props.className)}>
      <Alert variant={failure.kind === "gone" ? "info" : "error"}>
        <AlertDescription>{failure.text}</AlertDescription>
      </Alert>
      {failure.retry ? (
        <Button size="sm" variant="outline" onClick={props.onRetry}>
          {KIN_RETRY}
        </Button>
      ) : null}
    </div>
  );
}

/** A gated page before its reads: skeleton rows, offline, or the page's own refusal. */
export function KinGateView(props: {
  readonly gate: Exclude<KinGate, null>;
  readonly refused: { readonly title: string; readonly detail: string };
  readonly offline?: { readonly title: string; readonly detail: string };
  /** What is loading, for screen readers. */
  readonly label: string;
}) {
  if (props.gate === "refused") return <KinWorkNotice {...props.refused} />;
  if (props.gate === "offline") return <KinWorkNotice {...(props.offline ?? KIN_OFFLINE_PAGE)} />;
  if (props.gate === "failed") return <KinGateFailed />;
  return (
    <div
      className="mx-auto w-full max-w-3xl p-4"
      role="status"
      aria-label={`Loading ${props.label}`}
    >
      <KinWorkRowSkeletons />
    </div>
  );
}

/** A gate whose read of what this person may open failed, with a Retry of that read. */
export function KinGateFailed(props: { readonly className?: string }) {
  const host = useKinHost();
  return (
    <KinLoadFailed
      what={KIN_GATE_FAILED}
      cause={null}
      onRetry={() => {
        if (host._tag === "host") retryKinAccess(host.environmentId);
      }}
      className={cn("mx-auto w-full max-w-3xl p-4", props.className)}
    />
  );
}

export function KinWorkRowSkeletons() {
  return (
    <div className="flex flex-col gap-4 py-2">
      {[0, 1, 2, 3].map((index) => (
        <div key={index} className="flex items-start gap-3 px-2">
          <Skeleton className="size-4" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-3/5" />
            <Skeleton className="h-3 w-2/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Who did what and when, newest first. A line about a task opens it. */
export function KinWorkTimeline(props: {
  readonly lines: ReadonlyArray<KinWorkTimelineLine>;
  readonly onOpenTask: (key: KinRecordKey) => void;
}) {
  return (
    <ol className="flex flex-col gap-1.5">
      {props.lines.map((line) => {
        const { task } = line;
        return (
          <li key={line.key} className="flex gap-3 text-sm">
            <span className="w-14 shrink-0 text-xs leading-5 text-muted-foreground tabular-nums">
              {line.when}
            </span>
            <span className="min-w-0 flex-1 text-foreground">
              {line.text}
              {line.about === null ? null : task === null ? (
                <span className="text-muted-foreground"> · {line.about}</span>
              ) : (
                <>
                  <span className="text-muted-foreground"> · </span>
                  <button
                    type="button"
                    onClick={() => props.onOpenTask(task)}
                    className="rounded-sm text-muted-foreground underline-offset-2 outline-none ring-ring hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-inset"
                  >
                    {line.about}
                  </button>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** Why a change didn't go through, with the way on where there is one. */
export function KinWorkProblem(props: {
  readonly problem: KinWorkFormProblem;
  /** Opens the one that already has this name. */
  readonly onOpenExisting?: (key: KinRecordKey) => void;
}) {
  const { problem, onOpenExisting } = props;
  return (
    <Alert variant={problem.kind === "failed" || problem.kind === "invalid" ? "error" : "warning"}>
      <AlertDescription>{problem.text}</AlertDescription>
      {problem.kind === "duplicate" && onOpenExisting !== undefined ? (
        <AlertAction>
          <Button size="xs" variant="outline" onClick={() => onOpenExisting(problem.existing)}>
            {KIN_WORK_FORM_COPY.openExisting}
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}

/** One way a place's list narrows: a short set inline, a long one (people, clients) one level in. */
export interface KinFilterGroup {
  readonly label: string;
  readonly value: string;
  readonly options: ReadonlyArray<{
    readonly value: string;
    readonly label: string;
    readonly detail?: string | null;
  }>;
  readonly onChange: (value: string) => void;
  readonly long?: boolean;
  /** Said once under the choices, such as the fixed order inside each group. */
  readonly note?: string;
}

/** A place's one Filter control, and what it is narrowed to as one chip that clears it. */
export function KinFilter(props: {
  readonly groups: ReadonlyArray<KinFilterGroup>;
  readonly chip: string | null;
  readonly onClear: () => void;
  /** A grouping other than the default, as its own chip that puts the default back. */
  readonly grouped?: { readonly label: string; readonly onClear: () => void } | null;
}) {
  const groups = props.groups.filter((group) => group.options.length > 1);
  if (groups.length === 0) return null;
  const radio = (group: KinFilterGroup) => (
    <MenuRadioGroup value={group.value} onValueChange={(value) => group.onChange(String(value))}>
      {group.options.map((option) => (
        // A pick is the whole job: the menu closes on it, over the rows it just narrowed.
        <MenuRadioItem key={option.value} value={option.value} closeOnClick title={option.label}>
          <span className="flex min-w-0 items-center justify-between gap-4">
            <span className="max-w-72 truncate">{option.label}</span>
            {option.detail == null ? null : (
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {option.detail}
              </span>
            )}
          </span>
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Menu>
        <MenuTrigger render={<Button size="sm" variant="outline" />}>
          <ListFilterIcon aria-hidden />
          Filter
        </MenuTrigger>
        <MenuPopup align="start" side="bottom">
          {groups.map((group, index) => (
            <MenuGroup key={group.label}>
              {index === 0 ? null : <MenuSeparator />}
              {group.long ? (
                <MenuSub>
                  <MenuSubTrigger>
                    <MenuItemLabel>{group.label}</MenuItemLabel>
                    <span className="ms-auto max-w-32 truncate text-xs text-muted-foreground">
                      {group.options.find((option) => option.value === group.value)?.label}
                    </span>
                  </MenuSubTrigger>
                  <MenuSubPopup>{radio(group)}</MenuSubPopup>
                </MenuSub>
              ) : (
                <>
                  <MenuGroupLabel>{group.label}</MenuGroupLabel>
                  {radio(group)}
                  {group.note === undefined ? null : (
                    <p className="max-w-64 px-2 py-1.5 text-xs text-muted-foreground">
                      {group.note}
                    </p>
                  )}
                </>
              )}
            </MenuGroup>
          ))}
        </MenuPopup>
      </Menu>
      {props.grouped == null ? null : (
        <Button
          size="xs"
          variant="secondary"
          aria-label={`${props.grouped.label}. Clear grouping`}
          onClick={props.grouped.onClear}
          className="min-w-0 shrink"
        >
          <span className="truncate">{props.grouped.label}</span>
          <XIcon aria-hidden />
        </Button>
      )}
      {props.chip === null ? null : (
        <Button
          size="xs"
          variant="secondary"
          aria-label={`Filtered to ${props.chip}. Clear filter`}
          onClick={props.onClear}
          className="min-w-0 shrink"
        >
          <span className="truncate">{props.chip}</span>
          <XIcon aria-hidden />
        </Button>
      )}
    </div>
  );
}
