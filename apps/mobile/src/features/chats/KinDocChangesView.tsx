import { kinBodyMarkdown } from "@t3tools/client-runtime/kin/kinChatFeed";
import {
  KIN_DOC_CHANGES,
  kinDocChanges,
  type KinDocChange,
  type KinDocMark,
  type KinDocRun,
} from "@t3tools/client-runtime/kin/kinDocChanges";
import { KIN_DOCS } from "@t3tools/client-runtime/kin/kinDocs";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";

// The review diff's own tints: they read on a light and on a dark screen alike.
const ADDED = "rgba(16, 185, 129, 0.24)";
const REMOVED = "rgba(244, 63, 94, 0.24)";
const tint = (mark: KinDocMark | "changed") =>
  mark === "added" ? ADDED : mark === "removed" ? REMOVED : undefined;

function Runs(props: { readonly runs: ReadonlyArray<KinDocRun> }) {
  return props.runs.map((run, index) =>
    run.mark === "same" ? (
      run.text
    ) : (
      <Text
        // oxlint-disable-next-line react/no-array-index-key -- runs are positional and never reorder
        key={index}
        accessibilityLabel={`${run.mark === "added" ? KIN_DOC_CHANGES.added : KIN_DOC_CHANGES.removed}: ${run.text}`}
        style={{ backgroundColor: tint(run.mark) }}
        className={run.mark === "removed" ? "text-foreground-muted line-through" : ""}
      >
        {run.text}
      </Text>
    ),
  );
}

function Markdown(props: { readonly markdown: string; readonly mark: KinDocMark }) {
  const styles = useMarkdownPreviewStyles();
  return (
    <View
      accessibilityLabel={
        props.mark === "same"
          ? undefined
          : props.mark === "added"
            ? KIN_DOC_CHANGES.added
            : KIN_DOC_CHANGES.removed
      }
      style={{ backgroundColor: tint(props.mark) }}
      className={props.mark === "same" ? "" : "rounded-lg px-3 py-1"}
    >
      <SelectableMarkdownText
        markdown={kinBodyMarkdown(props.markdown)}
        textStyle={styles.nativeTextStyle}
        selectable
      />
    </View>
  );
}

const HEADING = ["title", "title", "headline", "headline", "body", "body", "body"] as const;
const CELL = "w-40 border-r border-border-subtle px-3 py-2";

function Change(props: { readonly change: KinDocChange }) {
  const { change } = props;
  switch (change.type) {
    case "block":
      return <Markdown markdown={change.markdown} mark={change.mark} />;
    case "text":
      return change.block === "heading" ? (
        <Text
          textRole={HEADING[change.level] ?? "body"}
          accessibilityRole="header"
          selectable
          className="font-t3-bold text-foreground"
        >
          <Runs runs={change.runs} />
        </Text>
      ) : (
        <View className={change.block === "quote" ? "border-l-2 border-border pl-3" : ""}>
          <Text
            textRole="body"
            selectable
            className={change.block === "quote" ? "text-foreground-muted" : "text-foreground"}
          >
            <Runs runs={change.runs} />
          </Text>
        </View>
      );
    case "list":
      return (
        <View className="gap-1">
          {change.items.map((item, index) => (
            <View
              // oxlint-disable-next-line react/no-array-index-key -- list items are positional and never reorder
              key={index}
              style={{ backgroundColor: tint(item.mark) }}
              className="flex-row gap-2 rounded-sm"
            >
              <Text textRole="body" className="w-6 text-right text-foreground-muted">
                {change.ordered ? `${index + 1}.` : "•"}
              </Text>
              <Text textRole="body" selectable className="min-w-0 flex-1 text-foreground">
                <Runs runs={item.runs} />
              </Text>
            </View>
          ))}
        </View>
      );
    case "table":
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="overflow-hidden rounded-lg border border-border-subtle">
            <View className="flex-row bg-grouped-card">
              {change.header.map((cell, index) => (
                // oxlint-disable-next-line react/no-array-index-key -- columns are positional and never reorder
                <View key={index} className={CELL}>
                  <Text textRole="footnote" className="font-t3-medium text-foreground">
                    <Runs runs={cell} />
                  </Text>
                </View>
              ))}
            </View>
            {change.rows.map((row, at) => (
              <View
                // oxlint-disable-next-line react/no-array-index-key -- rows are positional and never reorder
                key={at}
                style={{ backgroundColor: tint(row.mark) }}
                className="flex-row border-t border-border-subtle"
              >
                {row.cells.map((cell, index) => (
                  // oxlint-disable-next-line react/no-array-index-key -- columns are positional and never reorder
                  <View key={index} className={CELL}>
                    <Text textRole="footnote" selectable className="text-foreground">
                      <Runs runs={cell} />
                    </Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        </ScrollView>
      );
    case "code":
      return (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View className="rounded-lg bg-grouped-card p-3">
            {change.lines.map((line, index) => (
              <Text
                // oxlint-disable-next-line react/no-array-index-key -- lines are positional and never reorder
                key={index}
                style={{ backgroundColor: tint(line.mark) }}
                className={
                  line.mark === "removed"
                    ? "font-mono text-xs text-foreground-muted line-through"
                    : "font-mono text-xs text-foreground"
                }
              >
                {line.text === "" ? " " : line.text}
              </Text>
            ))}
          </View>
        </ScrollView>
      );
  }
}

/** A long stretch folded to one line that says what it is, opened on request. */
function Folded(props: {
  readonly label: string;
  readonly mark: KinDocMark;
  readonly markdown: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View className="gap-2">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${props.label}. ${open ? KIN_DOC_CHANGES.hide : KIN_DOC_CHANGES.show}`}
        onPress={() => setOpen(!open)}
        style={{ backgroundColor: tint(props.mark) }}
        className="min-h-11 flex-row items-center gap-3 rounded-lg px-3 py-2 active:opacity-60"
      >
        <Text textRole="footnote" numberOfLines={2} className="min-w-0 flex-1 text-foreground">
          {props.label}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {open ? KIN_DOC_CHANGES.hide : KIN_DOC_CHANGES.show}
        </Text>
      </Pressable>
      {open ? <Markdown markdown={props.markdown} mark={props.mark} /> : null}
    </View>
  );
}

/** Two versions of a doc read as one document, with what came and went marked in place. */
export function KinDocChangesView(props: { readonly before: string; readonly after: string }) {
  const view = kinDocChanges(props.before, props.after);
  if (view.identical) return <EmptyState variant="plain" {...KIN_DOCS.noChanges} />;
  return (
    <View className="gap-4 px-2">
      <Text textRole="footnote" className="text-foreground-muted">
        {KIN_DOC_CHANGES.legend}
      </Text>
      {view.parts.map((part) =>
        part.type === "shown" ? (
          <Change key={part.id} change={part.change} />
        ) : (
          <Folded key={part.id} label={part.label} mark={part.mark} markdown={part.markdown} />
        ),
      )}
    </View>
  );
}
