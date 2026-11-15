import { KIN_WORK_PRIVATE } from "@t3tools/client-runtime/kin/kinWork";
import type {
  KinHealthView,
  KinWorkTimelineLine,
} from "@t3tools/client-runtime/kin/kinWorkClients";
import type { KinWorkFormProblem } from "@t3tools/client-runtime/kin/kinWorkForms";
import { KIN_WORK_FORM_COPY } from "@t3tools/client-runtime/kin/kinWorkForms";
import type { KinRecordKey } from "@t3tools/contracts";
import { ListFilterIcon, LockIcon, XIcon } from "lucide-react";

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

/** A titled block of a task, client or project, with an optional action beside the title. */
export function KinWorkSection(props: {
  readonly title: string;
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{props.title}</h3>
        {props.action}
      </div>
      {props.children}
    </section>
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
}

/** A place's one Filter control, and what it is narrowed to as one chip that clears it. */
export function KinFilter(props: {
  readonly groups: ReadonlyArray<KinFilterGroup>;
  readonly chip: string | null;
  readonly onClear: () => void;
}) {
  const groups = props.groups.filter((group) => group.options.length > 1);
  if (groups.length === 0) return null;
  const radio = (group: KinFilterGroup) => (
    <MenuRadioGroup value={group.value} onValueChange={(value) => group.onChange(String(value))}>
      {group.options.map((option) => (
        <MenuRadioItem key={option.value} value={option.value}>
          <span className="flex min-w-0 items-center justify-between gap-4">
            <span className="truncate">{option.label}</span>
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
                </>
              )}
            </MenuGroup>
          ))}
        </MenuPopup>
      </Menu>
      {props.chip === null ? null : (
        <Button
          size="xs"
          variant="secondary"
          aria-label={`Filtered to ${props.chip}. Clear filter`}
          onClick={props.onClear}
          className="min-w-0"
        >
          <span className="truncate">{props.chip}</span>
          <XIcon aria-hidden />
        </Button>
      )}
    </div>
  );
}
