import type { KinCanvasDetail } from "@t3tools/client-runtime/kin/kinCanvasCamera";
import { KIN_CANVAS_CARD_H, KIN_CANVAS_CARD_W } from "@t3tools/client-runtime/kin/kinCanvasLayout";
import { KIN_CANVAS, type KinCanvasCardView } from "@t3tools/client-runtime/kin/kinCanvasView";
import type { KinRecordKey, KinRecordState } from "@t3tools/contracts";
import { memo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { cn } from "../../../lib/cn";
import { KinWorkStateSymbol } from "../components/KinWorkStateSymbol";
import { useKinDoc } from "../state/useKinDocs";
import type { KinWorkTarget } from "../state/useKinWork";

/** Half the world view's side: it is centred on the canvas origin so cards far out still take touches. */
export const KIN_CANVAS_WORLD_HALF = 20_000;

const STATE_OF_TONE: Record<KinCanvasCardView["tone"], KinRecordState | null> = {
  late: "open",
  done: "done",
  doing: "doing",
  waiting: "waiting",
  open: "open",
  doc: null,
};

export interface KinCanvasCardProps {
  readonly target: KinWorkTarget;
  readonly x: number;
  readonly y: number;
  readonly card: KinCanvasCardView;
  readonly detail: KinCanvasDetail;
  /** How much larger type is drawn zoomed out, so titles stay readable. */
  readonly inv: number;
  /** One of the few docs nearest the middle at the nearest zoom: its text is read onto the card. */
  readonly readsText: boolean;
  readonly peeked: boolean;
  readonly onPress: (key: string) => void;
}

/** One card on the map, at its place in world units; the board's transform scales it. */
export const KinCanvasCard = memo(function KinCanvasCard(props: KinCanvasCardProps) {
  const { card, detail } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={card.accessibilityLabel}
      accessibilityHint="Opens it over the map"
      accessibilityState={{ selected: props.peeked }}
      onPress={() => props.onPress(card.key)}
      className={cn(
        "absolute overflow-hidden rounded-xl active:opacity-80",
        detail === "dots" ? "p-0" : "border p-3",
        card.kind === "doc" ? "bg-card-alt" : "bg-card",
        props.peeked
          ? "border-2 border-primary"
          : card.working
            ? "border-primary/60"
            : card.tone === "late"
              ? "border-danger-border"
              : "border-border",
      )}
      style={{
        left: props.x + KIN_CANVAS_WORLD_HALF,
        top: props.y + KIN_CANVAS_WORLD_HALF,
        width: KIN_CANVAS_CARD_W,
        height: KIN_CANVAS_CARD_H,
      }}
    >
      {detail === "dots" ? (
        <View className={cn("flex-1 rounded-xl", dotTone(card))} />
      ) : detail === "titles" ? (
        <View className="flex-1 gap-1">
          <KindMark card={card} size={12 * props.inv} />
          <Text
            numberOfLines={2}
            className="font-t3-medium"
            style={{ fontSize: 14 * props.inv, lineHeight: 18 * props.inv }}
          >
            {card.title}
          </Text>
        </View>
      ) : (
        <View className="flex-1">
          <CardHead card={card} />
          <Text textRole="footnote" numberOfLines={2} className="mt-1.5 font-t3-medium">
            {card.title}
          </Text>
          {detail === "near" && props.readsText ? (
            <DocText target={props.target} docKey={card.key as KinRecordKey} />
          ) : (
            <>
              <Text textRole="caption" numberOfLines={1} className="mt-1 text-foreground-muted">
                {card.line}
              </Text>
              {card.summary !== null ? (
                <Text textRole="caption" numberOfLines={2} className="mt-1 text-foreground-muted">
                  {card.summary}
                </Text>
              ) : null}
            </>
          )}
          {card.working ? <WorkingLine /> : null}
        </View>
      )}
    </Pressable>
  );
});

function dotTone(card: KinCanvasCardView) {
  if (card.working) return "bg-primary/60";
  if (card.tone === "late") return "bg-danger/45";
  if (card.tone === "doc") return "bg-foreground/10";
  if (card.tone === "doing") return "bg-primary/25";
  return "bg-foreground/20";
}

/** Zoomed out, what kind of card it is, without words: a page for a doc, the task's state. */
function KindMark(props: { readonly card: KinCanvasCardView; readonly size: number }) {
  const state = STATE_OF_TONE[props.card.tone];
  return (
    <View className="flex-row items-center gap-1">
      {state === null ? (
        <SymbolView name="doc.text" size={props.size} tintColorClassName="accent-icon-muted" />
      ) : (
        <View style={{ transform: [{ scale: props.size / 12 }], transformOrigin: "left center" }}>
          <KinWorkStateSymbol state={state} />
        </View>
      )}
      {props.card.working ? (
        <View
          className="rounded-full bg-primary"
          style={{ width: props.size * 0.6, height: props.size * 0.6 }}
        />
      ) : null}
    </View>
  );
}

function CardHead(props: { readonly card: KinCanvasCardView }) {
  const { card } = props;
  const state = STATE_OF_TONE[card.tone];
  return (
    <View className="flex-row items-center gap-1.5">
      {state === null ? (
        <SymbolView name="doc.text" size={14} tintColorClassName="accent-icon-muted" />
      ) : (
        <KinWorkStateSymbol state={state} />
      )}
      <Text
        textRole="caption"
        className="text-foreground-muted"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {card.key}
      </Text>
      <Text
        textRole="caption"
        numberOfLines={1}
        className={cn(
          "shrink",
          card.tone === "late" ? "text-danger-foreground" : "text-foreground-muted",
        )}
      >
        {card.tone === "late" ? "· Late" : card.kind === "doc" ? "· Doc" : ""}
      </Text>
    </View>
  );
}

/** Still, never pulsing: a mark that an agent's worker is running on this task now. */
function WorkingLine() {
  return (
    <View className="mt-auto flex-row items-center gap-1.5">
      <View className="size-1.5 rounded-full bg-primary" />
      <Text textRole="caption" numberOfLines={1} className="font-t3-medium text-primary-text">
        {KIN_CANVAS.agentWorking}
      </Text>
    </View>
  );
}

/** Close enough to read: the doc's own opening lines, from the read its page uses. */
function DocText(props: { readonly target: KinWorkTarget; readonly docKey: KinRecordKey }) {
  const { state } = useKinDoc(props.target, props.docKey, null);
  const text =
    state._tag === "ready"
      ? kinDocPlainText(state.value.body)
      : state._tag === "loading"
        ? ""
        : KIN_CANVAS.readFailed;
  return (
    <Text textRole="caption" numberOfLines={5} className="mt-1 text-foreground">
      {text}
    </Text>
  );
}

/** A doc's markdown as plain running text for a few lines on a card. */
export function kinDocPlainText(markdown: string): string {
  return (
    markdown
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      // A heading reads as a lead-in to what follows it: "Goal: Patients book…".
      .replace(/^#{1,6}\s+(.*?)[\s:]*$/gm, "$1:")
      .replace(/[*_`>|]/g, "")
      .replace(/\s+/g, " ")
      .trim()
  );
}
