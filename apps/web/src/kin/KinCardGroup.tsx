import { useAtomValue } from "@effect/atom-react";
import {
  kinCardView,
  kinTaskCardWithoutThread,
} from "@t3tools/client-runtime/kin/kinCardPresentation";
import {
  kinChoiceAnswered,
  kinChoiceCardView,
  kinChoiceUndoneLine,
} from "@t3tools/client-runtime/kin/kinChoicePresentation";
import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import type { EnvironmentId, KinPersonId, KinWidget } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { memo, useState } from "react";

import { Button } from "../components/ui/button";
import { PullRequestGlyph } from "../components/pullRequest/pullRequestIcons";
import { environmentCatalog } from "../connection/catalog";
import { cn } from "../lib/utils";
import { CardFrame, TONE_CLASSES, useKinModelName } from "./KinCards";
import { useNowMinuteMs } from "./useKinClock";
import { KIN_WEB_ONLY } from "./kinWebOnly";

/**
 * Cards that read as one (`kinGroupCardRows`): an answered question with the tasks its answer
 * started, or tasks posted together, one compact row per task.
 */
export function KinCardGroup(props: {
  readonly question: KinWidget | undefined;
  readonly tasks: ReadonlyArray<KinWidget | undefined>;
  readonly environmentId: EnvironmentId;
  readonly viewerPersonId: KinPersonId | null;
}) {
  const rows = (
    <ul className="flex flex-col divide-y divide-border">
      {props.tasks.map((widget, index) => (
        <KinTaskRow
          key={widget?.widgetId ?? index}
          widget={widget}
          environmentId={props.environmentId}
        />
      ))}
    </ul>
  );
  if (props.question === undefined)
    return <CardFrame eyebrow={props.tasks.length === 1 ? "Task" : "Tasks"}>{rows}</CardFrame>;
  return (
    <CardFrame>
      <KinGroupQuestion widget={props.question} viewerPersonId={props.viewerPersonId} />
      <div className="border-t border-border pt-1">{rows}</div>
    </CardFrame>
  );
}

const KinGroupQuestion = memo(function KinGroupQuestion(props: {
  readonly widget: KinWidget;
  readonly viewerPersonId: KinPersonId | null;
}) {
  const nowMs = useNowMinuteMs();
  const [expanded, setExpanded] = useState(false);
  const choice = kinChoiceCardView(props.widget);
  if (choice === null) return null;
  const answered = kinChoiceAnswered(choice, props.viewerPersonId, null);
  const undone = kinChoiceUndoneLine(choice, props.viewerPersonId, new Date(nowMs));
  return (
    <>
      {expanded && choice.askedBy !== null ? (
        <p className="text-xs text-muted-foreground">{choice.askedBy}</p>
      ) : null}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((open) => !open)}
        className={cn("text-left text-foreground", !expanded && "line-clamp-3")}
      >
        {choice.question}
      </button>
      {expanded && choice.detail !== null ? (
        <p className="whitespace-pre-line text-xs text-muted-foreground">{choice.detail}</p>
      ) : null}
      {answered?.text == null ? null : (
        <p className="text-xs font-medium text-muted-foreground">{answered.text}</p>
      )}
      {undone === null ? null : <p className="text-xs text-muted-foreground">{undone}</p>}
    </>
  );
});

// Memoized on its widget, so a task changing state redraws only its own row.
const KinTaskRow = memo(function KinTaskRow(props: {
  readonly widget: KinWidget | undefined;
  readonly environmentId: EnvironmentId;
}) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const modelName = useKinModelName(props.environmentId);
  const view = kinCardView(
    props.widget,
    props.environmentId,
    (environmentId) => !catalog.isReady || catalog.entries.has(environmentId),
    null,
    undefined,
    modelName,
  );
  if (view.kind !== "task") return null;
  const task = KIN_WEB_ONLY ? kinTaskCardWithoutThread(view.task) : view.task;
  return (
    <li aria-label={task.accessibilityLabel} className="flex flex-col gap-1 py-2 last:pb-0">
      <div className="flex items-baseline gap-3">
        {task.open === null ? (
          <p className="min-w-0 flex-1 text-foreground">{task.title}</p>
        ) : (
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId: task.open.environmentId, threadId: task.open.threadId }}
            className="min-w-0 flex-1 text-foreground underline-offset-2 hover:underline"
          >
            {task.title}
          </Link>
        )}
        <span className={cn("shrink-0 text-xs font-medium", TONE_CLASSES[task.tone])}>
          {task.statusLabel}
        </span>
      </div>
      {task.detail === null ? null : (
        <p className="line-clamp-2 text-xs text-muted-foreground">{task.detail}</p>
      )}
      {task.unknownEnvironment ? (
        <p className="text-xs text-muted-foreground">
          {KIN_DEVICE_COPY.unknownEnvironment("browser")}
        </p>
      ) : null}
      {task.pullRequests.length === 0 && task.model === null ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {task.pullRequests.map((pr) => (
            <Button
              key={pr.url}
              size="xs"
              variant="outline"
              render={<a href={pr.url} target="_blank" rel="noreferrer noopener" />}
            >
              <PullRequestGlyph.pullRequest />
              {pr.label}
            </Button>
          ))}
          {task.model === null ? null : (
            <span className="truncate text-xs text-muted-foreground">{task.model}</span>
          )}
        </div>
      )}
    </li>
  );
});
