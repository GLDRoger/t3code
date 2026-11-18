import type { KinCanvasLayout } from "@t3tools/client-runtime/kin/kinCanvasLayout";
import {
  KIN_CANVAS,
  KIN_CANVAS_WIDGET_KINDS,
  type KinCanvasModel,
} from "@t3tools/client-runtime/kin/kinCanvasView";
import type { KinCanvasWidgetKind } from "@t3tools/contracts";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListSection } from "../../../components/ui/ListSection";
import { Menu } from "../../../components/ui/Menu";
import { Sheet } from "../../../components/ui/Sheet";
import type { KinCanvasLead } from "../state/useKinCanvas";

export type KinCanvasPeekTarget =
  | { readonly type: "card"; readonly key: string }
  | { readonly type: "group"; readonly key: string };

/** Ask about what is chosen: one item per agent this person can message. */
export function KinCanvasAskMenu(props: {
  readonly leads: ReadonlyArray<KinCanvasLead>;
  readonly label: string;
  readonly tone?: "primary" | "outline";
  readonly onAsk: (lead: KinCanvasLead) => void;
}) {
  if (props.leads.length === 0) return null;
  return (
    <Menu
      title={KIN_CANVAS.askWho}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      actions={props.leads.map((lead) => ({ id: lead.agentId, title: lead.name }))}
      onPressAction={({ nativeEvent: { event } }) => {
        const lead = props.leads.find((held) => held.agentId === event);
        if (lead !== undefined) props.onAsk(lead);
      }}
    >
      <View pointerEvents="none">
        <Button
          size="compact"
          tone={props.tone ?? "outline"}
          icon="bubble.left"
          label={props.label}
          onPress={() => {}}
        />
      </View>
    </Menu>
  );
}

/** What one card or group says in full, as a sheet over the canvas, with what can be done from here. */
export function KinCanvasPeek(props: {
  readonly target: KinCanvasPeekTarget;
  readonly model: KinCanvasModel;
  readonly layout: KinCanvasLayout;
  readonly canArrange: boolean;
  readonly placed: boolean;
  readonly leads: ReadonlyArray<KinCanvasLead>;
  readonly onClose: () => void;
  readonly onOpen: (key: string, kind: "task" | "doc" | "project") => void;
  readonly onAsk: (lead: KinCanvasLead, key: string) => void;
  readonly onAddWidget: (kind: KinCanvasWidgetKind, source: string) => void;
  readonly onRemoveWidget: (id: string) => void;
  readonly onPutBack: (key: string) => void;
  readonly onShowSources: (keys: ReadonlyArray<string>) => void;
}) {
  const { target, model } = props;
  const card = target.type === "card" ? model.cards.get(target.key) : undefined;
  const widget = target.type === "card" ? model.widgets.get(target.key) : undefined;
  const group =
    target.type === "group" ? model.groups.find((g) => g.key === target.key) : undefined;
  const groupKey = group?.key ?? null;
  const title = card?.title ?? widget?.title ?? group?.title;
  if (title === undefined) return null;

  const membersOf = (key: string) =>
    [...props.layout.cards.values()]
      .filter((box) => box.group === key && model.cards.has(box.key))
      .map((box) => box.key);

  return (
    <Sheet title={title} onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 pt-4 pb-10"
      >
        <Text
          textRole="caption"
          className="text-foreground-muted"
          style={{ fontVariant: ["tabular-nums"] }}
        >
          {card?.key ?? widget?.sourceKey ?? groupKey}
        </Text>

        {card !== undefined ? (
          <>
            <Text textRole="footnote" className="text-foreground-muted">
              {card.line}
            </Text>
            <View className="gap-1.5">
              <Row
                label="State"
                value={card.tone === "late" ? `${card.status}, late` : card.status}
              />
              {card.working !== null ? <Row label="Now" value={card.working} /> : null}
              {card.changed !== null ? <Row label="New" value={card.changed} /> : null}
              {card.needsYou ? <Row label={KIN_CANVAS.needsYou} value="It's on your list" /> : null}
            </View>
            <View className="flex-row flex-wrap gap-2">
              <Button
                size="compact"
                tone="primary"
                icon="arrow.up.right"
                label={KIN_CANVAS.open}
                onPress={() => props.onOpen(card.key, card.kind)}
              />
              <KinCanvasAskMenu
                leads={props.leads}
                label={KIN_CANVAS.askWho}
                onAsk={(lead) => props.onAsk(lead, card.key)}
              />
              {props.canArrange && card.kind === "task" ? (
                <Button
                  size="compact"
                  tone="outline"
                  icon="timer"
                  label="Count down to it"
                  onPress={() => props.onAddWidget("countdown", card.key)}
                />
              ) : null}
              {props.canArrange && props.placed ? (
                <Button
                  size="compact"
                  tone="text"
                  icon="arrow.uturn.backward"
                  label={KIN_CANVAS.resetPlace}
                  onPress={() => props.onPutBack(card.key)}
                />
              ) : null}
            </View>
          </>
        ) : null}

        {widget !== undefined ? (
          <>
            <View>
              <Text
                textRole="display"
                className="font-t3-bold"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {widget.headline}
              </Text>
              <Text textRole="footnote" className="text-foreground-muted">
                {widget.detail}
              </Text>
            </View>
            <Text textRole="caption" className="text-foreground-muted">
              Counted by Kin from {widget.sourceKey} whenever it changes.
            </Text>
            <View className="flex-row flex-wrap gap-2">
              {widget.widget.kind !== "countdown" ? (
                <Button
                  size="compact"
                  tone="outline"
                  label="Show its tasks"
                  onPress={() => props.onShowSources(membersOf(widget.sourceKey))}
                />
              ) : model.cards.has(widget.sourceKey) ? (
                <Button
                  size="compact"
                  tone="outline"
                  label="Show the task"
                  onPress={() => props.onShowSources([widget.sourceKey])}
                />
              ) : null}
              {widget.tone !== "gone" ? (
                <Button
                  size="compact"
                  tone="outline"
                  icon="arrow.up.right"
                  label={`Open ${widget.sourceKey}`}
                  onPress={() =>
                    props.onOpen(
                      widget.sourceKey,
                      widget.widget.kind === "countdown" ? "task" : "project",
                    )
                  }
                />
              ) : null}
              {props.canArrange ? (
                <Button
                  size="compact"
                  tone="text"
                  icon="trash"
                  label={KIN_CANVAS.removeWidget}
                  onPress={() => props.onRemoveWidget(widget.key)}
                />
              ) : null}
            </View>
          </>
        ) : null}

        {groupKey !== null ? (
          <>
            <Text textRole="footnote" className="text-foreground-muted">
              {membersOf(groupKey).length} on the canvas
            </Text>
            <View className="flex-row flex-wrap gap-2">
              <Button
                size="compact"
                tone="primary"
                icon="arrow.up.right"
                label="Open project"
                onPress={() => props.onOpen(groupKey, "project")}
              />
              <KinCanvasAskMenu
                leads={props.leads}
                label={KIN_CANVAS.askWho}
                onAsk={(lead) => props.onAsk(lead, groupKey)}
              />
            </View>
            {props.canArrange ? (
              <ListSection title={KIN_CANVAS.addWidget}>
                {KIN_CANVAS_WIDGET_KINDS.map((kind) => (
                  <ListActionRow
                    key={kind.kind}
                    label={kind.label}
                    description={
                      kind.kind === "countdown"
                        ? "Time left to the project's target date"
                        : kind.detail
                    }
                    onPress={() => props.onAddWidget(kind.kind, groupKey)}
                  />
                ))}
              </ListSection>
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

function Row(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="flex-row gap-3">
      <Text textRole="footnote" className="w-24 text-foreground-muted">
        {props.label}
      </Text>
      <Text textRole="footnote" className="min-w-0 flex-1">
        {props.value}
      </Text>
    </View>
  );
}
