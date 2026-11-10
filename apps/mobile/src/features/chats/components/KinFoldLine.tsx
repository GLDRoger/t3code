import * as Haptics from "expo-haptics";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";
import type { KinFeedRow } from "@t3tools/client-runtime/kin/kinChatFeed";

type FoldRow = Extract<KinFeedRow, { readonly type: "fold" }>;

const joinNames = (names: ReadonlyArray<string>) =>
  names.length <= 1
    ? (names[0] ?? "Agents")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

// The decision is markdown; the fold line shows its first line as plain text.
const firstLine = (markdown: string) =>
  markdown
    .split("\n")
    .find((line) => line.trim().length > 0)
    ?.replace(/[*_`#>]/g, "")
    .trim() ?? "";

/** Folded agent talk (DESIGN 8.3): one line naming who talked and what they settled. */
export function KinFoldLine(props: { readonly row: FoldRow; readonly onToggle: () => void }) {
  const { row } = props;
  const who = `${joinNames(row.authors)} talked it over.`;
  const decision = row.decision === null ? null : firstLine(row.decision);
  const count = `${row.count} messages`;
  return (
    <View className="px-4 py-1.5">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[who, decision, count].filter(Boolean).join(" ")}
        accessibilityHint={`Double tap to ${row.expanded ? "hide" : "show"} the messages.`}
        accessibilityState={{ expanded: row.expanded }}
        className="min-h-11 flex-row items-center gap-2 px-1 active:opacity-60"
        onPress={() => {
          void Haptics.selectionAsync();
          props.onToggle();
        }}
      >
        <Text textRole="footnote" className="min-w-0 shrink text-foreground-muted">
          {who}
          {decision ? <Text className="text-foreground"> {decision}</Text> : null} {count}
        </Text>
        <SymbolView
          name={row.expanded ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-icon-subtle"
        />
      </Pressable>
    </View>
  );
}
