import { KIN_CANVAS, type KinCanvasCardView } from "@t3tools/client-runtime/kin/kinCanvasView";
import { KIN_RETRY } from "@t3tools/client-runtime/kin/kinAnswers";
import { kinDocMarkdown } from "@t3tools/client-runtime/kin/kinChatFeed";
import type { KinRecordKey } from "@t3tools/contracts";
import { ScrollView, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { Sheet } from "../../../components/ui/Sheet";
import { SelectableMarkdownText } from "../../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../../files/FileMarkdownPreview";
import { KinWorkLoading } from "../components/KinWorkPieces";
import { useKinDoc } from "../state/useKinDocs";
import type { KinWorkTarget } from "../state/useKinWork";

/**
 * A card read over the live map, half the screen and up to nearly all of it: a doc's text, or what a
 * task's card says in full. Open goes to its own page for everything else.
 */
export function KinCanvasPeek(props: {
  readonly target: KinWorkTarget;
  readonly card: KinCanvasCardView;
  readonly onClose: () => void;
  readonly onOpen: (card: KinCanvasCardView) => void;
}) {
  const { card } = props;
  return (
    <Sheet title={card.title} onClose={props.onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-3 px-5 pt-3 pb-12"
      >
        <View className="flex-row items-center gap-2">
          <Text
            textRole="caption"
            className="text-foreground-muted"
            style={{ fontVariant: ["tabular-nums"] }}
          >
            {card.key} · {card.tone === "late" ? "Late" : card.status}
          </Text>
        </View>
        <Text textRole="footnote" className="text-foreground-muted">
          {card.line}
        </Text>
        {card.working ? (
          <View className="flex-row items-center gap-2">
            <View className="size-2 rounded-full bg-primary" />
            <Text textRole="footnote" className="font-t3-medium text-primary-text">
              {KIN_CANVAS.agentWorking}
            </Text>
          </View>
        ) : null}
        <View className="flex-row">
          <Button
            size="compact"
            tone="primary"
            icon="arrow.up.right"
            label={card.kind === "doc" ? "Open doc" : "Open task"}
            onPress={() => props.onOpen(card)}
          />
        </View>
        {card.kind === "doc" ? (
          <PeekDocText target={props.target} docKey={card.key as KinRecordKey} />
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

function PeekDocText(props: { readonly target: KinWorkTarget; readonly docKey: KinRecordKey }) {
  const { state, refresh } = useKinDoc(props.target, props.docKey, null);
  const styles = useMarkdownPreviewStyles();
  if (state._tag === "loading") return <KinWorkLoading label="Loading doc" />;
  if (state._tag !== "ready")
    return (
      <View className="items-start gap-2 pt-2">
        <Text textRole="footnote" className="text-foreground-muted">
          {KIN_CANVAS.readFailed}
        </Text>
        <Button size="compact" tone="secondary" label={KIN_RETRY} onPress={refresh} />
      </View>
    );
  return (
    <View className="border-t border-border-subtle pt-3">
      <SelectableMarkdownText
        markdown={kinDocMarkdown(state.value.body)}
        textStyle={styles.nativeTextStyle}
        inlineWebLinks
      />
    </View>
  );
}
