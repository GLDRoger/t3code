import { memo } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Chip } from "../../../components/ui/Chip";
import type { KinDigestCardView, KinDigestRow } from "./kinCardPresentation";

/** A server-drawn list: the shadow summary or a routine. Plain text only; links open on a tap. */
export const KinDigestCard = memo(function KinDigestCard(props: {
  readonly digest: KinDigestCardView;
  /** The screen's safe link handler. */
  readonly onOpenLink: (url: string) => void;
}) {
  const { digest } = props;
  const links = digest.rows.flatMap((row) => (row.link === null ? [] : [row.link]));
  const openRow = (row: KinDigestRow) => {
    if (row.link !== null) props.onOpenLink(row.link.url);
  };

  return (
    <View
      accessible
      accessibilityLabel={digest.accessibilityLabel}
      accessibilityActions={links.map((link, index) => ({
        name: `link-${index}`,
        label: `Open ${link.label}`,
      }))}
      onAccessibilityAction={(event) => {
        const link = links[Number(event.nativeEvent.actionName.slice("link-".length))];
        if (link !== undefined) props.onOpenLink(link.url);
      }}
      className="gap-2.5 rounded-[20px] border border-border bg-card-alt p-4"
    >
      <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-foreground-secondary">
        {digest.eyebrow}
      </Text>
      <Text textRole="headline" className="font-t3-bold text-foreground">
        {digest.title}
      </Text>
      {digest.rows.map((row) => (
        <View key={row.key} className="gap-0.5">
          {row.heading === null ? null : (
            <Text textRole="footnote" className="pt-1 font-t3-medium text-foreground-secondary">
              {row.heading}
            </Text>
          )}
          <Text textRole="footnote" className="text-foreground">
            {row.text}
          </Text>
          {row.note === null ? null : (
            <Text textRole="caption" className="text-foreground-muted">
              {row.note}
            </Text>
          )}
          {row.link === null ? null : (
            <View className="flex-row pt-1">
              <Chip size="small" label={row.link.chipLabel} onPress={() => openRow(row)} />
            </View>
          )}
        </View>
      ))}
      {digest.more === null ? null : (
        <Text textRole="caption" className="text-foreground-muted">
          {digest.more}
        </Text>
      )}
    </View>
  );
});
