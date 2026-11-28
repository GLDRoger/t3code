import {
  kinAddressSentencePieces,
  type kinBankSenderAddressSegments,
} from "@t3tools/client-runtime/kin/kinBankSenders";
import { View } from "react-native";

import { AppText as Text, type AppTextProps } from "../../../components/ui/AppText";

/** A sender's address whole, its domain stronger, read out as one address. */
export function KinSenderAddress(props: {
  readonly address: string;
  readonly segments: ReturnType<typeof kinBankSenderAddressSegments>;
}) {
  return (
    // One text per piece in a wrapping row: the line breaks only after an @ or a dot, where a
    // single text would also break at a hyphen inside the domain.
    <View accessible accessibilityLabel={props.address} className="flex-row flex-wrap">
      {props.segments.map((segment) => (
        <Text
          key={segment.start}
          textRole="body"
          className={
            segment.domain
              ? "max-w-full font-t3-semibold text-foreground"
              : "max-w-full text-foreground-muted"
          }
        >
          {segment.text}
        </Text>
      ))}
    </View>
  );
}

/**
 * A sentence that may hold an address, wrapped the way `KinSenderAddress` wraps one: at large text
 * an address breaks only after an @ or a dot, never mid-word. Without an address it is one text.
 */
export function KinAddressSentence(props: {
  readonly text: string;
  readonly textRole: NonNullable<AppTextProps["textRole"]>;
  readonly className: string;
}) {
  const pieces = kinAddressSentencePieces(props.text);
  if (pieces === null)
    return (
      <Text textRole={props.textRole} className={props.className}>
        {props.text}
      </Text>
    );
  const starts = pieces.map((_, index) => pieces.slice(0, index).join("").length);
  return (
    <View accessible accessibilityLabel={props.text} className="flex-row flex-wrap">
      {pieces.map((piece, index) => (
        <Text
          key={starts[index]}
          textRole={props.textRole}
          className={`max-w-full ${props.className}`}
        >
          {piece}
        </Text>
      ))}
    </View>
  );
}
