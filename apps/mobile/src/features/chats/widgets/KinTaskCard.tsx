import { memo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Chip } from "../../../components/ui/Chip";
import { cn } from "../../../lib/cn";
import { useOpenWorkspaceDetail } from "../../layout/useOpenWorkspaceDetail";
import { PullRequestGlyph } from "../../pull-requests/pullRequestGlyphs";
import type { KinTaskCardView, KinTaskTone } from "./kinCardPresentation";

const TONE_CLASSES: Record<KinTaskTone, string> = {
  active: "text-foreground",
  attention: "text-warning-foreground",
  done: "text-foreground-secondary",
  muted: "text-foreground-muted",
};

/** A delegated task. Tapping it opens the T3 thread doing the work; status updates in place. */
export const KinTaskCard = memo(function KinTaskCard(props: {
  readonly task: KinTaskCardView;
  /** The screen's safe link handler (`useOpenPullRequest`). */
  readonly onOpenLink: (url: string) => void;
}) {
  const { task } = props;
  const openDetail = useOpenWorkspaceDetail();
  const open = task.open;
  const openThread = open === null ? undefined : () => openDetail({ name: "Thread", params: open });
  const prActions = task.pullRequests.map((pr) => ({ name: pr.url, label: `Open ${pr.label}` }));

  return (
    <Pressable
      accessible
      accessibilityRole={open === null ? undefined : "button"}
      accessibilityLabel={task.accessibilityLabel}
      accessibilityActions={prActions}
      onAccessibilityAction={(event) => {
        const pr = task.pullRequests.find((item) => item.url === event.nativeEvent.actionName);
        if (pr) props.onOpenLink(pr.url);
      }}
      onPress={openThread}
      className={cn(
        "gap-2.5 rounded-[20px] border border-border bg-card-alt p-4",
        open !== null && "active:opacity-80",
      )}
    >
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        Task
      </Text>
      <Text textRole="headline" className="font-t3-bold text-foreground">
        {task.title}
      </Text>
      <Text textRole="footnote" className={cn("font-t3-medium", TONE_CLASSES[task.tone])}>
        {task.statusLabel}
      </Text>
      {task.working ? (
        // Static on purpose: a bar that animates for the whole task would repaint for minutes.
        <View className="h-1 overflow-hidden rounded-full bg-primary/20">
          <View className="h-1 w-1/3 rounded-full bg-primary/60" />
        </View>
      ) : null}
      {task.detail === null ? null : (
        <Text textRole="footnote" numberOfLines={4} className="text-foreground-secondary">
          {task.detail}
        </Text>
      )}
      {task.unknownEnvironment ? (
        <Text textRole="footnote" className="text-foreground-muted">
          That thread is on an environment this phone doesn't know.
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
