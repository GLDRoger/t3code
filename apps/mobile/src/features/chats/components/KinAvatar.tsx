import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { cn } from "../../../lib/cn";

/** Agents get an outlined rounded square, people a filled circle (DESIGN 8.7). */
export function KinAvatar(props: { readonly kind: "agent" | "person"; readonly initials: string }) {
  const agent = props.kind === "agent";
  return (
    <View
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      className={cn(
        "size-10 items-center justify-center",
        agent
          ? "rounded-[12px] border-[1.5px] border-primary"
          : "rounded-full border border-secondary-border bg-secondary",
      )}
    >
      <Text
        textRole="footnote"
        maxFontSizeMultiplier={1.2}
        className={cn("font-t3-bold", agent ? "text-primary-text" : "text-secondary-foreground")}
      >
        {props.initials}
      </Text>
    </View>
  );
}
