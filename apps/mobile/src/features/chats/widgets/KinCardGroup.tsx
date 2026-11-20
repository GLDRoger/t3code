import { useAtomValue } from "@effect/atom-react";
import {
  kinCardView,
  kinTaskCardWithoutThread,
  type KinTaskTone,
} from "@t3tools/client-runtime/kin/kinCardPresentation";
import {
  kinChoiceAnswered,
  kinChoiceCardView,
  kinChoiceUndoneLine,
} from "@t3tools/client-runtime/kin/kinChoicePresentation";
import { KIN_DEVICE_COPY } from "@t3tools/client-runtime/kin/kinDevice";
import { kinSentences } from "@t3tools/client-runtime/kin/kinScreenState";
import type { EnvironmentId, KinPersonId, KinWidget } from "@t3tools/contracts";
import { memo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Chip } from "../../../components/ui/Chip";
import { environmentCatalog } from "../../../connection/catalog";
import { cn } from "../../../lib/cn";
import { useNowMinuteMs } from "../../../lib/clock";
import { KIN_ONLY } from "../../../lib/kinOnly";
import { useOpenWorkspaceDetail } from "../../layout/useOpenWorkspaceDetail";
import { PullRequestGlyph } from "../../pull-requests/pullRequestGlyphs";
import { useKinModelName } from "./KinWidgetView";

const TONE_CLASSES: Record<KinTaskTone, string> = {
  active: "text-foreground",
  attention: "text-warning-foreground",
  done: "text-foreground-secondary",
  muted: "text-foreground-muted",
};

/**
 * Cards that read as one (`kinGroupCardRows`): an answered question with the tasks its answer
 * started, or tasks posted together, one compact row per task.
 */
export function KinCardGroup(props: {
  readonly question: KinWidget | undefined;
  readonly tasks: ReadonlyArray<KinWidget | undefined>;
  readonly environmentId: EnvironmentId;
  readonly viewerPersonId: KinPersonId | null;
  /** The screen's safe link handler (`useOpenPullRequest`). */
  readonly onOpenLink: (url: string) => void;
  readonly onLongPress?: () => void;
}) {
  return (
    <View className="gap-2 rounded-[20px] border border-border bg-card-alt p-4">
      {props.question === undefined ? (
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
          {props.tasks.length === 1 ? "Task" : "Tasks"}
        </Text>
      ) : (
        <KinGroupQuestion
          widget={props.question}
          viewerPersonId={props.viewerPersonId}
          {...(props.onLongPress === undefined ? {} : { onLongPress: props.onLongPress })}
        />
      )}
      <View className={cn(props.question !== undefined && "border-t border-border")}>
        {props.tasks.map((widget, index) => (
          <KinTaskRow
            key={widget?.widgetId ?? index}
            widget={widget}
            environmentId={props.environmentId}
            index={index}
            flush={props.question === undefined}
            onOpenLink={props.onOpenLink}
            {...(props.onLongPress === undefined ? {} : { onLongPress: props.onLongPress })}
          />
        ))}
      </View>
    </View>
  );
}

const KinGroupQuestion = memo(function KinGroupQuestion(props: {
  readonly widget: KinWidget;
  readonly viewerPersonId: KinPersonId | null;
  readonly onLongPress?: () => void;
}) {
  const nowMs = useNowMinuteMs();
  const [expanded, setExpanded] = useState(false);
  const choice = kinChoiceCardView(props.widget);
  if (choice === null) return null;
  const answered = kinChoiceAnswered(choice, props.viewerPersonId, null);
  const undone = kinChoiceUndoneLine(choice, props.viewerPersonId, new Date(nowMs));
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded }}
      accessibilityLabel={kinSentences([choice.question, answered?.text ?? null, undone])}
      onPress={() => setExpanded((open) => !open)}
      {...(props.onLongPress === undefined ? {} : { onLongPress: props.onLongPress })}
      className="gap-1.5 pb-2 active:opacity-80"
    >
      <Text className="text-foreground" numberOfLines={expanded ? undefined : 3}>
        {choice.question}
      </Text>
      {expanded && choice.detail !== null ? (
        <Text textRole="footnote" className="text-foreground-secondary">
          {choice.detail}
        </Text>
      ) : null}
      {answered?.text == null ? null : (
        <Text textRole="footnote" className="font-t3-medium text-foreground-secondary">
          {answered.text}
        </Text>
      )}
      {undone === null ? null : (
        <Text textRole="footnote" className="text-foreground-muted">
          {undone}
        </Text>
      )}
    </Pressable>
  );
});

// Memoized on its widget, so a task changing state redraws only its own row.
const KinTaskRow = memo(function KinTaskRow(props: {
  readonly widget: KinWidget | undefined;
  readonly environmentId: EnvironmentId;
  readonly index: number;
  /** No rule above the group: its first row starts at the card's top. */
  readonly flush: boolean;
  readonly onOpenLink: (url: string) => void;
  readonly onLongPress?: () => void;
}) {
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const modelName = useKinModelName(props.environmentId);
  const openDetail = useOpenWorkspaceDetail();
  const view = kinCardView(
    props.widget,
    props.environmentId,
    (environmentId) => !catalog.isReady || catalog.entries.has(environmentId),
    null,
    undefined,
    modelName,
  );
  if (view.kind !== "task") return null;
  // As the single task card: a Kin-only app has no thread screen to open.
  const task = KIN_ONLY ? kinTaskCardWithoutThread(view.task) : view.task;
  const open = task.open;
  return (
    <Pressable
      accessible
      accessibilityRole={open === null ? undefined : "button"}
      accessibilityLabel={task.accessibilityLabel}
      accessibilityActions={task.pullRequests.map((pr) => ({
        name: pr.url,
        label: `Open ${pr.label}`,
      }))}
      onAccessibilityAction={(event) => {
        const pr = task.pullRequests.find((item) => item.url === event.nativeEvent.actionName);
        if (pr) props.onOpenLink(pr.url);
      }}
      onPress={open === null ? undefined : () => openDetail({ name: "Thread", params: open })}
      {...(props.onLongPress === undefined ? {} : { onLongPress: props.onLongPress })}
      className={cn(
        "gap-1 py-2",
        props.index > 0 && "border-t border-border",
        props.index === 0 && props.flush && "pt-0",
        open !== null && "active:opacity-80",
      )}
    >
      <View className="flex-row items-baseline gap-3">
        <Text className="flex-1 text-foreground" numberOfLines={2}>
          {task.title}
        </Text>
        <Text textRole="footnote" className={cn("font-t3-medium", TONE_CLASSES[task.tone])}>
          {task.statusLabel}
        </Text>
      </View>
      {task.detail === null ? null : (
        <Text textRole="footnote" numberOfLines={2} className="text-foreground-secondary">
          {task.detail}
        </Text>
      )}
      {task.unknownEnvironment ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {KIN_DEVICE_COPY.unknownEnvironment("phone")}
        </Text>
      ) : null}
      {task.pullRequests.length === 0 && task.model === null ? null : (
        <View className="flex-row flex-wrap items-center gap-2">
          {task.pullRequests.map((pr) => (
            <Chip
              key={pr.url}
              size="small"
              icon={PullRequestGlyph.pullRequest}
              label={pr.label}
              accessibilityLabel={`Open ${pr.label}`}
              onPress={() => props.onOpenLink(pr.url)}
            />
          ))}
          {task.model === null ? null : (
            <Text textRole="caption" numberOfLines={1} className="text-foreground-muted">
              {task.model}
            </Text>
          )}
        </View>
      )}
    </Pressable>
  );
});
