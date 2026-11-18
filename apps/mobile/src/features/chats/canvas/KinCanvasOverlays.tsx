import { KIN_CANVAS, kinCanvasActivityText } from "@t3tools/client-runtime/kin/kinCanvasView";
import type { KinCanvasActivity, KinCanvasSince, KinChatId } from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../../components/ui/AppSymbol";
import { Button } from "../../../components/ui/Button";
import { Chip } from "../../../components/ui/Chip";
import { ListRow } from "../../../components/ui/ListRow";
import { ListSection } from "../../../components/ui/ListSection";
import { Sheet } from "../../../components/ui/Sheet";
import type { KinCanvasLead } from "../state/useKinCanvas";
import { KinCanvasAskMenu } from "./KinCanvasPeek";

const PANEL = "rounded-2xl border border-border bg-card";

/** "Since you last looked": one line, the changes under it on demand, each one a way to the card. */
export function KinCanvasSincePanel(props: {
  readonly line: string;
  readonly since: KinCanvasSince;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onChange: (key: string) => void;
  readonly onMarkSeen: () => void;
}) {
  const { since } = props;
  const changes = since.changes.length > 0;
  return (
    <View accessibilityLabel={KIN_CANVAS.sinceTitle} className={`${PANEL} w-full max-w-sm p-3`}>
      <View className="flex-row items-start gap-2">
        <SymbolView name="clock" size={16} tintColorClassName="accent-icon-muted" />
        <Text textRole="footnote" className="min-w-0 flex-1">
          {props.line}
        </Text>
        {changes ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: props.open }}
            onPress={props.onToggle}
            hitSlop={10}
            className="-my-1 min-h-8 justify-center px-1 active:opacity-60"
          >
            <Text textRole="footnote" className="font-t3-medium text-primary-text">
              {props.open ? "Hide" : "Show"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {props.open && changes ? (
        <ScrollView className="mt-2" style={{ maxHeight: 200 }} nestedScrollEnabled>
          {since.changes.slice(0, 12).map((change) => (
            <Pressable
              key={change.key}
              accessibilityRole="button"
              accessibilityLabel={`${change.key}: ${change.title}`}
              onPress={() => props.onChange(change.key)}
              className="min-h-11 flex-row items-center gap-2 rounded-lg px-1.5 active:bg-subtle"
            >
              <Text
                textRole="caption"
                className="text-foreground-muted"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {change.key}
              </Text>
              <Text textRole="footnote" numberOfLines={1} className="min-w-0 flex-1">
                {change.title}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      {since.seenAt !== null && changes ? (
        <View className="mt-2">
          <Button
            size="compact"
            tone="outline"
            label={KIN_CANVAS.markSeen}
            onPress={props.onMarkSeen}
          />
        </View>
      ) : null}
    </View>
  );
}

/** What agents are doing now: each chip flies to the card it is on, or opens the agent's chat. */
export function KinCanvasActivityChips(props: {
  readonly activity: ReadonlyArray<KinCanvasActivity>;
  readonly onPress: (entry: KinCanvasActivity) => void;
}) {
  if (props.activity.length === 0) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      accessibilityLabel="Agents working"
      contentContainerClassName="gap-1.5"
      style={{ flexGrow: 0 }}
    >
      {props.activity.map((entry) => (
        <Chip
          key={`${entry.agentId}:${entry.chatId}`}
          icon="circle.fill"
          label={kinCanvasActivityText(entry)}
          onPress={() => props.onPress(entry)}
        />
      ))}
    </ScrollView>
  );
}

function RoundButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      onPress={props.onPress}
      className="size-11 items-center justify-center rounded-full active:bg-subtle-strong"
    >
      <SymbolView name={props.icon} size={18} tintColorClassName="accent-icon" />
    </Pressable>
  );
}

export function KinCanvasZoomControls(props: {
  readonly onZoomOut: () => void;
  readonly onZoomIn: () => void;
  readonly onShowAll: () => void;
}) {
  return (
    <View className={`${PANEL} flex-row items-center p-0.5`}>
      <RoundButton icon="minus" label={KIN_CANVAS.zoomOut} onPress={props.onZoomOut} />
      <RoundButton icon="plus" label={KIN_CANVAS.zoomIn} onPress={props.onZoomIn} />
      <RoundButton
        icon="arrow.up.left.and.arrow.down.right"
        label={KIN_CANVAS.showAll}
        onPress={props.onShowAll}
      />
    </View>
  );
}

export function KinCanvasSelectionBar(props: {
  readonly count: number;
  readonly leads: ReadonlyArray<KinCanvasLead>;
  readonly onAsk: (lead: KinCanvasLead) => void;
  readonly onClear: () => void;
}) {
  return (
    <View className={`${PANEL} flex-row items-center gap-2 py-1 pr-1 pl-4`}>
      <Text textRole="footnote" style={{ fontVariant: ["tabular-nums"] }}>
        {props.count} selected
      </Text>
      <KinCanvasAskMenu
        leads={props.leads}
        label={KIN_CANVAS.ask}
        tone="primary"
        onAsk={props.onAsk}
      />
      <Button
        size="compact"
        tone="text"
        label={KIN_CANVAS.clearSelection}
        onPress={props.onClear}
      />
    </View>
  );
}

export interface KinCanvasNeedsRow {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly urgent: boolean;
  readonly key: string | null;
  readonly chat: KinChatId | null;
}

export function KinCanvasNeedsSheet(props: {
  readonly rows: ReadonlyArray<KinCanvasNeedsRow>;
  readonly onClose: () => void;
  readonly onRow: (row: KinCanvasNeedsRow) => void;
}) {
  return (
    <Sheet title={KIN_CANVAS.needsYou} onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="px-4 pt-4 pb-10"
      >
        {props.rows.length === 0 ? (
          <Text textRole="footnote" className="p-3 text-foreground-muted">
            {KIN_CANVAS.nothingNeedsYou}
          </Text>
        ) : (
          <ListSection>
            {props.rows.map((row) => (
              <ListRow
                key={row.id}
                label={row.title}
                description={row.detail}
                {...(row.urgent ? { icon: "exclamationmark.circle" as const } : {})}
                onPress={() => props.onRow(row)}
              />
            ))}
          </ListSection>
        )}
      </ScrollView>
    </Sheet>
  );
}
