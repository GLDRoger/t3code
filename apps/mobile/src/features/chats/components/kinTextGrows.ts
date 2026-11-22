import { useWindowDimensions } from "react-native";

/**
 * Above the default text size a Kin row grows to more lines rather than cut a name or a date to
 * nothing; at the default size it keeps its line caps.
 */
export function useKinTextGrows(): boolean {
  return useWindowDimensions().fontScale > 1;
}

/** A line cap that lifts when the text is set larger than the default. */
export function kinLines(lines: number, grows: boolean): number | undefined {
  return grows ? undefined : lines;
}
