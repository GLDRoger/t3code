import type { ColorValue } from "react-native";
import Svg, { Text } from "react-native-svg";
import { withUniwind } from "uniwind";

const ThemedText = withUniwind(Text);

// Kin's wordmark until a drawn one replaces it; the name keeps upstream's imports working.
export function T3Wordmark(props: {
  readonly height: number;
  readonly color?: ColorValue;
  readonly colorClassName?: string;
}) {
  const aspectRatio = 112 / 56;
  return (
    <Svg
      accessibilityLabel="Kin"
      height={props.height}
      width={props.height * aspectRatio}
      viewBox="0 0 112 56"
    >
      <ThemedText
        x="0"
        y="54"
        fontSize="74"
        fontWeight="700"
        textLength="112"
        lengthAdjust="spacingAndGlyphs"
        color={props.color}
        colorClassName={props.colorClassName}
        fill="currentColor"
      >
        Kin
      </ThemedText>
    </Svg>
  );
}
