import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { resolveNativeReviewDiffView } from "../diffs/nativeReviewDiffSurface";
import { useAppearanceCodeSurface } from "../settings/appearance/useAppearanceCodeSurface";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { buildNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import { buildReviewParsedDiff } from "./reviewModel";
import { useNativeReviewDiffBridge } from "./useNativeReviewDiffBridge";

const EMPTY_IDS: readonly string[] = [];

/**
 * A unified git patch in the review diff surface, as tall as its rows, for a page that scrolls
 * around it. Where the native surface isn't built, the patch reads as plain marked lines.
 */
export function PatchDiffView(props: {
  readonly patch: string;
  /** Names this diff among the others the highlighter holds. */
  readonly id: string;
  /** One file with nothing to say about its name: no file or hunk header rows. */
  readonly bare?: boolean;
}) {
  const { patch, id } = props;
  const { nativeReviewDiffStyle, codeWordBreak } = useAppearanceCodeSurface();
  const { themeAppearance } = useAppearancePreferences();
  const parsed = buildNativeReviewDiffData(buildReviewParsedDiff(patch, id));
  const data = props.bare
    ? { ...parsed, rows: parsed.rows.filter((row) => row.kind !== "file" && row.kind !== "hunk") }
    : parsed;
  const bridge = useNativeReviewDiffBridge({
    threadKey: null,
    sectionId: id,
    diff: patch,
    data,
    collapsedFileIds: EMPTY_IDS,
    viewedFileIds: EMPTY_IDS,
    selectedRowIds: EMPTY_IDS,
    canHighlight: true,
  });
  const [measured, setMeasured] = useState<{ key: string; height: number } | null>(null);
  const measurementKey = `${patch.length}:${codeWordBreak}:${nativeReviewDiffStyle.rowHeight}`;
  const [NativeDiff] = useState(() => resolveNativeReviewDiffView());
  if (NativeDiff === null || data.rows.length === 0) return <PlainPatch patch={patch} />;
  return (
    <View
      style={{
        height:
          measured?.key === measurementKey
            ? measured.height
            : data.rows.length * nativeReviewDiffStyle.rowHeight,
      }}
    >
      <NativeDiff
        scrollEnabled={false}
        bounces={false}
        appearanceScheme={themeAppearance}
        rowHeight={nativeReviewDiffStyle.rowHeight}
        contentWidth={2800}
        style={{ flex: 1 }}
        rowsJson={bridge.rowsJson}
        themeJson={bridge.themeJson}
        styleJson={bridge.styleJson}
        tokensPatchJson={bridge.tokensPatchJson}
        tokensResetKey={bridge.tokensResetKey}
        onDebug={(event) => {
          bridge.onDebug(event);
          const { message, contentHeight } = event.nativeEvent;
          if (message === "metrics" && typeof contentHeight === "number") {
            setMeasured((current) =>
              current?.key === measurementKey && current.height === contentHeight
                ? current
                : { key: measurementKey, height: contentHeight },
            );
          }
        }}
      />
    </View>
  );
}

function PlainPatch(props: { readonly patch: string }) {
  const lines = props.patch
    .split("\n")
    .filter((line) => !/^(diff --git|index |--- |\+\+\+ |@@)/.test(line));
  return (
    <View className="py-2">
      {lines.map((line, index) => (
        <Text
          // oxlint-disable-next-line react/no-array-index-key -- a patch's lines have no identity but their place
          key={index}
          className={cn(
            "px-3 font-mono text-xs",
            line.startsWith("+")
              ? "text-foreground"
              : line.startsWith("-")
                ? "text-foreground-muted line-through"
                : "text-foreground-muted",
          )}
        >
          {line === "" ? " " : line}
        </Text>
      ))}
    </View>
  );
}
